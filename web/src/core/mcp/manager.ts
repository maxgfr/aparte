/*
 * The MCP manager (McpManager in web/src/core/contracts/mcp.ts): one connection per enabled server, through the
 * `@ai-sdk/mcp` client and its Streamable HTTP and legacy SSE transports, every request through the MCP fetch
 * (fetch.ts: net.ts with purpose `mcp`, size caps); the tools each server lists, mapped (mapping.ts) and registered
 * in the session's tool registry while the user's choice allows; and the OAuth sign-in (oauth.ts, callback.ts).
 *
 * Invariants:
 * - A server's tool is registered only while it is on in the configuration and its live definition has the
 *   fingerprint the user accepted. A definition that changed is unregistered and held back (`changed`) until the
 *   user accepts it again; a new tool starts off, except at the first listing of a server, when the user has just
 *   added it and every tool starts on.
 * - Tool lists are read again on connect, after the server says they changed, and before a call when the last
 *   listing is older than RELIST_MS: a call to a tool whose definition changed since it was registered is refused,
 *   never sent.
 * - A call that the server rejected for its token (401) is retried once after a refresh; a call is never retried
 *   otherwise (a tool may not be idempotent), except when the connection was already closed before it was sent.
 * - Tokens live in McpSecrets (device-only); this module holds the access token only inside the headers of the open
 *   connection, and the PKCE verifier and state only in the pending flow.
 * - Nothing here touches the DOM: the channel the popup answers on is opened by the injected `openChannel`.
 */
import { createMCPClient, type MCPClient, type MCPClientConfig, MCPClientError } from '@ai-sdk/mcp'
import type { Rng } from '../contracts/crypto.ts'
import { InvalidStateError } from '../contracts/crypto.ts'
import type {
  McpManager,
  McpProblem,
  McpSecret,
  McpSecrets,
  McpServerConfig,
  McpServers,
  McpStatus,
  McpToolChoice,
  McpToolState,
  McpToolView,
  OAuthTokens,
} from '../contracts/mcp.ts'
import type { Tool, ToolAnnotations, ToolRegistry, ToolResult } from '../contracts/tools.ts'
import type { Clock } from '../contracts/vault.ts'
import type { Id, Workspace } from '../contracts/workspace.ts'
import { fingerprintOf } from '../tools/fingerprint.ts'
import { awaitCallback, CallbackCancelledError, type CallbackChannel } from './callback.ts'
import { createMcpFetch, type McpFetchOptions } from './fetch.ts'
import {
  annotationsOf,
  descriptionOf,
  inputSchemaOf,
  MAX_TOOLS,
  type McpCallResult,
  type McpToolDefinition,
  registryNames,
  titleOf,
  toToolResult,
} from './mapping.ts'
import {
  checkIssuer,
  discover,
  exchangeCode,
  needsRefresh,
  OAuthError,
  type PendingFlow,
  parseWwwAuthenticate,
  refreshTokens,
  registerClient,
  startFlow,
} from './oauth.ts'

/** A listing older than this is read again before a call. */
export const RELIST_MS = 30_000
const CONNECT_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 120_000
const SIGN_IN_TIMEOUT_MS = 10 * 60_000
const PROBE_TIMEOUT_MS = 10_000
const MAX_PAGES = 20

/** The part of an `@ai-sdk/mcp` client the manager uses (tests pass a fake). */
export type McpClientLike = Pick<MCPClient, 'listTools' | 'callTool' | 'close' | 'serverInfo'>

export interface McpManagerDeps {
  readonly workspace: Pick<Workspace, 'subscribe'> & { readonly mcp: McpServers }
  readonly registry: ToolRegistry
  readonly secrets: McpSecrets
  /** web/src/security/net.ts `request` (purpose `mcp`). */
  readonly request: McpFetchOptions['request']
  readonly rng: Rng
  readonly clock: Clock
  /** `<origin><base>oauth-callback.html`, registered with every authorization server. */
  readonly redirectUri: string
  /** Opens the BroadcastChannel the popup answers on. */
  readonly openChannel: (name: string) => CallbackChannel
  readonly createClient?: (config: MCPClientConfig) => Promise<McpClientLike>
  readonly clientName?: string
  readonly clientVersion?: string
  /** The app's home page, sent as the registered client's `client_uri`. */
  readonly clientUri?: string
  readonly timeouts?: { readonly connect?: number; readonly call?: number; readonly signIn?: number }
}

interface Entry {
  readonly def: McpToolDefinition
  readonly registryName: string
  readonly title: string
  readonly description: string
  readonly annotations: ToolAnnotations
  readonly spec: Omit<Tool, 'execute'> | null
  readonly fingerprint: string
  /** Why it cannot be offered; null when it can. */
  invalid: string | null
}

interface Runtime {
  readonly id: Id
  config: McpServerConfig
  status: McpStatus
  client: McpClientLike | null
  serverName: string
  tools: Map<string, Entry>
  /** Registry names this server registered, with the fingerprint registered. */
  registered: Map<string, string>
  listedAt: number
  stale: boolean
  generation: number
  connecting: Promise<McpStatus> | null
  syncing: Promise<void>
  flow: PendingFlow | null
  waiting: AbortController | null
  /** The `WWW-Authenticate` of the latest 401, for discovery. */
  challenge: string | null
  /** A first listing seeds the choices (every tool on). */
  seeded: boolean
}

const OFF: McpStatus = Object.freeze({ state: 'off' })

function* causes(error: unknown): Generator<unknown> {
  let at: unknown = error
  for (let depth = 0; depth < 6 && at !== undefined && at !== null; depth++) {
    yield at
    at = (at as { cause?: unknown }).cause
  }
}

type Classified =
  | McpProblem
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'network' }
  | { readonly kind: 'closed' }

/** What went wrong, from an error of the MCP client, its transport or the fetch below it. */
export function classify(error: unknown): Classified {
  for (const e of causes(error)) {
    if (MCPClientError.isInstance(e) && typeof e.statusCode === 'number') {
      if (e.statusCode === 401) return { kind: 'unauthorized' }
      if (e.statusCode === 403) return { kind: 'auth', status: 403 }
      if (e.statusCode >= 400) return { kind: 'http', status: e.statusCode }
    }
  }
  for (const e of causes(error)) {
    if (e instanceof TypeError) {
      return /^Blocked request/.test(e.message) ? { kind: 'insecure' } : { kind: 'network' }
    }
    if (e instanceof RangeError) return { kind: 'protocol', detail: 'The server answered more than the app reads.' }
    if (e instanceof OAuthError) {
      return e.code === 'insecure' ? { kind: 'insecure' } : { kind: 'auth', detail: e.message }
    }
  }
  const message = error instanceof Error ? error.message : String(error)
  // The SSE transport reports a refused stream in its message only.
  const status = /Transport Error: (\d{3})\b/.exec(message)?.[1]
  if (status === '401') return { kind: 'unauthorized' }
  if (status === '403') return { kind: 'auth', status: 403 }
  if (status !== undefined) return { kind: 'http', status: Number(status) }
  if (/closed client/i.test(message)) return { kind: 'closed' }
  if (/timed out/i.test(message)) return { kind: 'timeout' }
  return { kind: 'protocol', detail: message.slice(0, 300) }
}

const failure = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

function abortError(): Error {
  const error = new Error('The tool was stopped')
  error.name = 'AbortError'
  return error
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function createMcpManager(deps: McpManagerDeps): McpManager {
  const { workspace, registry, secrets, rng, clock } = deps
  const create = deps.createClient ?? ((config: MCPClientConfig) => createMCPClient(config))
  const connectTimeout = deps.timeouts?.connect ?? CONNECT_TIMEOUT_MS
  const callTimeout = deps.timeouts?.call ?? CALL_TIMEOUT_MS
  const signInTimeout = deps.timeouts?.signIn ?? SIGN_IN_TIMEOUT_MS
  const runtimes = new Map<Id, Runtime>()
  const listeners = new Set<() => void>()
  let disposed = false
  const oauthFetch = createMcpFetch({ request: deps.request })
  const oauthDeps = { http: oauthFetch, rng, clock }

  const emit = () => {
    for (const fn of [...listeners]) {
      try {
        fn()
      } catch {
        // A failing listener must not stop the others.
      }
    }
  }
  const setStatus = (rt: Runtime, status: McpStatus): McpStatus => {
    rt.status = Object.freeze(status)
    emit()
    return rt.status
  }

  // Tools

  const stateOf = (entry: Entry, choice: McpToolChoice | undefined): McpToolState => {
    if (entry.invalid !== null) return 'invalid'
    if (choice === undefined) return 'new'
    if (!choice.enabled) return 'off'
    return choice.fingerprint === entry.fingerprint ? 'on' : 'changed'
  }

  const views = (rt: Runtime): McpToolView[] => {
    const choices = new Map(rt.config.tools.map((c) => [c.name, c]))
    return [...rt.tools.values()]
      .sort((a, b) => (a.def.name < b.def.name ? -1 : a.def.name > b.def.name ? 1 : 0))
      .map((e) =>
        Object.freeze({
          name: e.def.name,
          registryName: e.registryName,
          title: e.title,
          description: e.description,
          annotations: e.annotations,
          fingerprint: e.fingerprint,
          state: stateOf(e, choices.get(e.def.name)),
        }),
      )
  }

  const connectedStatus = (rt: Runtime): McpStatus => ({
    state: 'connected',
    tools: Object.freeze(views(rt)),
    server: rt.serverName,
  })

  const unregisterAll = (rt: Runtime) => {
    for (const name of rt.registered.keys()) registry.unregister(name)
    rt.registered.clear()
  }

  /** Brings the registry in line with the listing and the user's choices. Serialised per server. */
  const applyRegistrations = (rt: Runtime): Promise<void> => {
    rt.syncing = rt.syncing.then(async () => {
      if (disposed) return
      const config = rt.config
      const choices = new Map(config.tools.map((c) => [c.name, c]))
      const desired = new Map<string, Entry>()
      if (config.enabled && rt.client !== null) {
        for (const entry of rt.tools.values()) {
          if (stateOf(entry, choices.get(entry.def.name)) === 'on') desired.set(entry.registryName, entry)
        }
      }
      for (const [name, fingerprint] of [...rt.registered]) {
        if (desired.get(name)?.fingerprint !== fingerprint) {
          registry.unregister(name)
          rt.registered.delete(name)
        }
      }
      for (const [name, entry] of desired) {
        if (rt.registered.has(name) || entry.spec === null) continue
        const fingerprint = entry.fingerprint
        const mcpName = entry.def.name
        try {
          const registered = await registry.register({
            ...entry.spec,
            execute: (input, context) => call(rt.id, mcpName, fingerprint, input, context.signal),
          })
          if (registered.fingerprint !== fingerprint) {
            registry.unregister(name)
            entry.invalid = 'Its definition could not be fingerprinted the same way twice'
          } else rt.registered.set(name, fingerprint)
        } catch {
          // Another tool holds the name (a built-in, another source): this one cannot be offered.
          entry.invalid = 'Another tool has the same name'
        }
      }
      if (rt.status.state === 'connected') setStatus(rt, connectedStatus(rt))
    })
    return rt.syncing
  }

  /** Reads every page of `tools/list` and maps the tools (fingerprints included). */
  const list = async (rt: Runtime, client: McpClientLike): Promise<void> => {
    const defs: McpToolDefinition[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_PAGES && defs.length < MAX_TOOLS; page++) {
      const result = await client.listTools({
        ...(cursor === undefined ? {} : { params: { cursor } }),
        options: { timeout: connectTimeout },
      })
      for (const tool of result.tools) if (defs.length < MAX_TOOLS) defs.push(tool as McpToolDefinition)
      cursor = result.nextCursor
      if (cursor === undefined) break
    }
    const names = registryNames(
      rt.config.prefix,
      defs.map((d) => d.name),
    )
    const tools = new Map<string, Entry>()
    for (const def of defs) {
      if (tools.has(def.name)) continue
      const registryName = names.get(def.name) as string
      const schema = inputSchemaOf(def)
      const annotations = annotationsOf(def)
      const description = descriptionOf(def)
      const title = titleOf(def)
      const invalid = schema.ok ? null : schema.invalid
      const spec = schema.ok
        ? {
            name: registryName,
            title,
            description,
            inputSchema: schema.schema,
            annotations,
            source: 'mcp' as const,
            origin: rt.id,
          }
        : null
      const fingerprint =
        spec === null
          ? ''
          : await fingerprintOf(spec).catch(() => {
              return ''
            })
      tools.set(def.name, {
        def,
        registryName,
        title,
        description,
        annotations,
        spec,
        fingerprint,
        invalid: invalid ?? (fingerprint === '' ? 'Its definition is not JSON' : null),
      })
    }
    rt.tools = tools
    rt.listedAt = clock.now()
    rt.stale = false
    // A server just added starts with every tool on: the user sees the list and turns off what they do not want.
    if (!rt.seeded && rt.config.tools.length === 0) {
      rt.seeded = true
      const seed = [...tools.values()]
        .filter((e) => e.invalid === null)
        .map((e) => ({ name: e.def.name, enabled: true, fingerprint: e.fingerprint }))
      if (seed.length > 0) {
        workspace.mcp.update(rt.id, { tools: seed })
        rt.config = workspace.mcp.get(rt.id) ?? rt.config
      }
    }
    rt.seeded = true
  }

  // Connections

  const closeClient = async (rt: Runtime) => {
    const client = rt.client
    rt.client = null
    if (client !== null) await client.close().catch(() => undefined)
  }

  const probe = async (url: string): Promise<McpProblem> => {
    try {
      await deps.request(url, {
        method: 'GET',
        mode: 'no-cors',
        purpose: 'mcp',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      return { kind: 'cors' }
    } catch {
      return { kind: 'unreachable' }
    }
  }

  const problemOf = async (rt: Runtime, error: unknown): Promise<McpProblem> => {
    const c = classify(error)
    if (c.kind === 'network') return probe(rt.config.url)
    if (c.kind === 'unauthorized') return { kind: 'auth', status: 401 }
    if (c.kind === 'closed') return { kind: 'unreachable' }
    return c
  }

  const saveTokens = async (rt: Runtime, secret: Extract<McpSecret, { kind: 'oauth' }>, tokens: OAuthTokens | null) => {
    await secrets.set(rt.id, tokens === null ? { kind: 'oauth', client: secret.client } : { ...secret, tokens })
  }

  /** Prepares a sign-in: discovery, registration (once per authorization server), a fresh state and verifier. */
  const prepareSignIn = async (rt: Runtime, gen: number, problem?: McpProblem): Promise<McpStatus> => {
    rt.flow = null
    setStatus(rt, { state: 'needs-auth', signIn: 'preparing', ...(problem === undefined ? {} : { problem }) })
    try {
      const secret = await secrets.get(rt.id).catch(() => null)
      const discovered = await discover(rt.config.url, parseWwwAuthenticate(rt.challenge), { http: oauthFetch })
      let client =
        secret?.kind === 'oauth' &&
        secret.client.issuer === discovered.metadata.issuer &&
        secret.client.redirectUri === deps.redirectUri &&
        secret.client.tokenEndpoint === discovered.metadata.token_endpoint
          ? secret.client
          : null
      if (client === null) {
        client = await registerClient(
          discovered,
          {
            redirectUri: deps.redirectUri,
            clientName: deps.clientName ?? 'Aparté',
            ...(deps.clientUri === undefined ? {} : { clientUri: deps.clientUri }),
          },
          { http: oauthFetch },
        )
        await secrets.set(rt.id, { kind: 'oauth', client })
      } else if (client.resource !== discovered.resource || client.scope !== discovered.scope) {
        const { resource: _r, scope: _s, ...rest } = client
        client = {
          ...rest,
          ...(discovered.resource === undefined ? {} : { resource: discovered.resource }),
          ...(discovered.scope === undefined ? {} : { scope: discovered.scope }),
        }
        await secrets.set(rt.id, { kind: 'oauth', client })
      }
      const flow = await startFlow(client, { rng, clock })
      if (gen !== rt.generation || disposed) return rt.status
      rt.flow = flow
      return setStatus(rt, { state: 'needs-auth', signIn: 'ready', ...(problem === undefined ? {} : { problem }) })
    } catch (error) {
      if (gen !== rt.generation || disposed) return rt.status
      return setStatus(rt, { state: 'needs-auth', signIn: 'failed', problem: await problemOf(rt, error) })
    }
  }

  /** The headers of the connection, or the status to show instead (no secret, sign-in needed). */
  const authHeaders = async (
    rt: Runtime,
    gen: number,
    refresh: boolean,
  ): Promise<{ readonly headers: Record<string, string> } | { readonly status: McpStatus }> => {
    const config = rt.config
    if (config.auth === 'none') return { headers: {} }
    const secret = await secrets.get(rt.id).catch(() => null)
    const missing = () => ({ status: setStatus(rt, { state: 'error', problem: { kind: 'auth', detail: 'missing' } }) })
    if (config.auth === 'bearer') {
      return secret?.kind === 'bearer' ? { headers: { authorization: `Bearer ${secret.token}` } } : missing()
    }
    if (config.auth === 'headers') return secret?.kind === 'headers' ? { headers: { ...secret.headers } } : missing()
    if (secret?.kind !== 'oauth' || secret.tokens === undefined) return { status: await prepareSignIn(rt, gen) }
    let tokens: OAuthTokens | null = secret.tokens
    if (refresh || needsRefresh(tokens, clock.now())) {
      try {
        tokens = await refreshTokens(secret.client, tokens, oauthDeps)
      } catch {
        tokens = null
      }
      await saveTokens(rt, secret, tokens)
      if (tokens === null) return { status: await prepareSignIn(rt, gen) }
    }
    return { headers: { authorization: `Bearer ${tokens.accessToken}` } }
  }

  const doConnect = async (rt: Runtime): Promise<McpStatus> => {
    const gen = ++rt.generation
    rt.flow = null
    rt.waiting?.abort()
    const config = workspace.mcp.get(rt.id)
    if (config === undefined || config.deletedAt !== undefined || !config.enabled) {
      await closeClient(rt)
      unregisterAll(rt)
      return setStatus(rt, OFF)
    }
    rt.config = config
    setStatus(rt, { state: 'connecting' })
    await closeClient(rt)
    for (let attempt = 0; attempt < 2; attempt++) {
      const auth = await authHeaders(rt, gen, attempt > 0)
      if (gen !== rt.generation || disposed) return rt.status
      if ('status' in auth) return auth.status
      rt.challenge = null
      let client: McpClientLike | null = null
      try {
        client = await create({
          transport: {
            type: config.transport,
            url: config.url,
            headers: auth.headers,
            redirect: 'error',
            fetch: createMcpFetch({
              request: deps.request,
              onUnauthorized: (header) => {
                rt.challenge = header
              },
            }) as typeof globalThis.fetch,
          },
          clientName: deps.clientName ?? 'Aparte',
          version: deps.clientVersion ?? '1.0.0',
          protocolVersionDiscovery: false,
          initializationOptions: { timeout: connectTimeout },
          onUncaughtError: () => {
            // A notification the client does not handle (a list change) or a dropped stream: read the tools again
            // before the next call.
            rt.stale = true
          },
        })
        if (gen !== rt.generation || disposed) {
          await client.close().catch(() => undefined)
          return rt.status
        }
        rt.client = client
        rt.serverName = [client.serverInfo?.name, client.serverInfo?.version].filter(Boolean).join(' ')
        await list(rt, client)
        if (gen !== rt.generation || disposed) return rt.status
        setStatus(rt, connectedStatus(rt))
        await applyRegistrations(rt)
        return rt.status
      } catch (error) {
        if (client !== null && rt.client === client) await closeClient(rt)
        else if (client !== null) await client.close().catch(() => undefined)
        if (gen !== rt.generation || disposed) return rt.status
        unregisterAll(rt)
        const c = classify(error)
        if (c.kind === 'unauthorized' && config.auth === 'oauth') {
          const secret = await secrets.get(rt.id).catch(() => null)
          if (attempt === 0 && secret?.kind === 'oauth' && secret.tokens?.refreshToken !== undefined) continue
          if (secret?.kind === 'oauth') await saveTokens(rt, secret, null)
          return prepareSignIn(rt, gen)
        }
        return setStatus(rt, { state: 'error', problem: await problemOf(rt, error) })
      }
    }
    return rt.status
  }

  const runtime = (id: Id): Runtime | undefined => runtimes.get(id)

  const connect = (id: Id): Promise<McpStatus> => {
    if (disposed) return Promise.resolve(OFF)
    const rt = runtime(id) ?? track(workspace.mcp.get(id))
    if (rt === undefined) return Promise.resolve(OFF)
    const run = doConnect(rt).finally(() => {
      if (rt.connecting === run) rt.connecting = null
    })
    rt.connecting = run
    return run
  }

  // Calls

  async function call(
    id: Id,
    mcpName: string,
    fingerprint: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    if (!isPlainObject(input)) return failure('The arguments must be a JSON object.')
    const rt = runtime(id)
    if (rt === undefined || disposed) return failure('This MCP server is no longer configured.')
    if (rt.connecting !== null) await rt.connecting
    if (rt.client === null || rt.stale || clock.now() - rt.listedAt > RELIST_MS) {
      if (rt.client === null) await connect(id)
      else {
        try {
          await list(rt, rt.client)
          await applyRegistrations(rt)
          if (rt.status.state === 'connected') setStatus(rt, connectedStatus(rt))
        } catch {
          await connect(id)
        }
      }
    }
    if (signal.aborted) throw abortError()
    const entry = rt.tools.get(mcpName)
    if (rt.client === null || rt.status.state !== 'connected') {
      return failure('Not run: the MCP server is not connected.')
    }
    if (
      entry === undefined ||
      entry.fingerprint !== fingerprint ||
      rt.registered.get(entry.registryName) !== fingerprint
    ) {
      return failure(
        'Not run: the definition of this tool changed on its server since it was offered, so it is held back until the user reviews it.',
      )
    }
    for (let attempt = 0; ; attempt++) {
      const client = rt.client
      if (client === null) return failure('Not run: the MCP server is not connected.')
      try {
        const result = await client.callTool({
          name: mcpName,
          arguments: input,
          options: { signal, timeout: callTimeout },
        })
        return toToolResult(result as McpCallResult)
      } catch (error) {
        if (signal.aborted) throw abortError()
        const c = classify(error)
        // Rejected before it ran (expired token, closed connection): reconnect once and send it again.
        if (attempt === 0 && (c.kind === 'closed' || (c.kind === 'unauthorized' && rt.config.auth === 'oauth'))) {
          const status = await connect(id)
          if (status.state === 'connected' && rt.registered.get(entry.registryName) === fingerprint) continue
          return failure('Not run: the MCP server needs the user to sign in again.')
        }
        if (c.kind === 'timeout') return failure('The MCP server did not answer in time.')
        if (c.kind === 'http' || c.kind === 'auth') {
          return failure(`The MCP server refused the call (HTTP ${'status' in c ? (c.status ?? '') : ''}).`)
        }
        const detail = MCPClientError.isInstance(error) ? error.message.slice(0, 500) : 'the request failed'
        return failure(`The MCP server failed: ${detail}`)
      }
    }
  }

  // Configuration changes

  function track(config: McpServerConfig | undefined): Runtime | undefined {
    if (config === undefined || config.deletedAt !== undefined) return undefined
    const rt: Runtime = {
      id: config.id,
      config,
      status: OFF,
      client: null,
      serverName: '',
      tools: new Map(),
      registered: new Map(),
      listedAt: 0,
      stale: false,
      generation: 0,
      connecting: null,
      syncing: Promise.resolve(),
      flow: null,
      waiting: null,
      challenge: null,
      seeded: config.tools.length > 0,
    }
    runtimes.set(config.id, rt)
    return rt
  }

  const stop = (rt: Runtime) => {
    rt.generation++
    rt.flow = null
    rt.waiting?.abort()
    unregisterAll(rt)
    void closeClient(rt)
    setStatus(rt, OFF)
  }

  const reconcile = () => {
    if (disposed) return
    const servers = workspace.mcp.list()
    const ids = new Set(servers.map((s) => s.id))
    for (const rt of [...runtimes.values()]) {
      if (!ids.has(rt.id)) {
        stop(rt)
        runtimes.delete(rt.id)
      }
    }
    for (const server of servers) {
      const rt = runtime(server.id)
      if (rt === undefined) {
        track(server)
        if (server.enabled) void connect(server.id)
        continue
      }
      const prev = rt.config
      rt.config = server
      if (!server.enabled) {
        if (rt.status.state !== 'off') stop(rt)
        continue
      }
      if (
        !prev.enabled ||
        prev.url !== server.url ||
        prev.transport !== server.transport ||
        prev.auth !== server.auth
      ) {
        void connect(server.id)
      } else if (prev.tools !== server.tools) {
        void applyRegistrations(rt)
      }
    }
  }

  const unsubscribe = workspace.subscribe('mcp', reconcile)
  reconcile()

  const updateChoice = (id: Id, name: string, enabled: boolean, accept: boolean) => {
    const rt = runtime(id)
    const config = workspace.mcp.get(id)
    if (config === undefined) throw new InvalidStateError('Unknown MCP server')
    const entry = rt?.tools.get(name)
    const previous = config.tools.find((c) => c.name === name)
    const fingerprint = accept || previous === undefined ? entry?.fingerprint : previous.fingerprint
    if (fingerprint === undefined || fingerprint === '') throw new InvalidStateError('This tool is not listed')
    const tools = [...config.tools.filter((c) => c.name !== name), { name, enabled, fingerprint }]
    workspace.mcp.update(id, { tools })
  }

  return {
    status(id) {
      return runtime(id)?.status ?? OFF
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    connect,
    setToolEnabled(id, name, enabled) {
      updateChoice(id, name, enabled, enabled)
    },
    acceptTool(id, name) {
      updateChoice(id, name, true, true)
    },
    signInUrl(id) {
      const rt = runtime(id)
      if (rt === undefined || rt.flow === null) return null
      if (rt.status.state !== 'needs-auth' || rt.status.signIn !== 'ready') return null
      return rt.flow.url
    },
    async completeSignIn(id) {
      const rt = runtime(id)
      const flow = rt?.flow ?? null
      if (rt === undefined || flow === null || rt.status.state !== 'needs-auth' || rt.status.signIn !== 'ready') {
        throw new InvalidStateError('No sign-in is ready for this server')
      }
      const gen = rt.generation
      const controller = new AbortController()
      rt.waiting = controller
      setStatus(rt, { state: 'needs-auth', signIn: 'waiting' })
      try {
        const outcome = await awaitCallback({
          open: deps.openChannel,
          state: flow.state,
          timeoutMs: signInTimeout,
          signal: controller.signal,
        })
        // One answer per flow: from here on the state and the verifier are gone, whatever happens next.
        rt.flow = null
        if (gen !== rt.generation || disposed) return rt.status
        if (outcome.kind === 'error') throw new OAuthError('denied', `The sign-in was refused (${outcome.error})`)
        checkIssuer(flow.client, outcome.iss)
        const tokens = await exchangeCode(flow, outcome.code, oauthDeps)
        await secrets.set(rt.id, { kind: 'oauth', client: flow.client, tokens })
        return await connect(id)
      } catch (error) {
        rt.flow = null
        if (gen !== rt.generation || disposed) return rt.status
        if (error instanceof CallbackCancelledError) return prepareSignIn(rt, gen)
        return prepareSignIn(rt, gen, await problemOf(rt, error))
      } finally {
        if (rt.waiting === controller) rt.waiting = null
      }
    },
    cancelSignIn(id) {
      runtime(id)?.waiting?.abort()
    },
    async signOut(id) {
      const rt = runtime(id)
      const secret = await secrets.get(id).catch(() => null)
      if (secret?.kind === 'oauth') await secrets.set(id, { kind: 'oauth', client: secret.client })
      if (rt !== undefined) {
        rt.generation++
        unregisterAll(rt)
        await closeClient(rt)
        await prepareSignIn(rt, rt.generation)
      }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      const closing: Promise<void>[] = []
      for (const rt of runtimes.values()) {
        rt.generation++
        rt.flow = null
        rt.waiting?.abort()
        unregisterAll(rt)
        closing.push(closeClient(rt))
        rt.status = OFF
      }
      runtimes.clear()
      listeners.clear()
      await Promise.all(closing)
    },
  }
}
