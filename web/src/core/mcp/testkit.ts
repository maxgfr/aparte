/*
 * Test doubles of the MCP specs (bun test only, never imported by the app): an MCP server with an OAuth 2.1
 * authorization server, played in memory behind the `request` the manager is given, and a hub of named channels that
 * stands for BroadcastChannel.
 */
import { base64urlEncode, utf8 } from '../crypto/bytes.ts'
import { sha256 } from '../crypto/keys.ts'
import { CALLBACK_TYPE, type CallbackChannel } from './callback.ts'
import type { McpCallResult } from './mapping.ts'

export const SERVER_ORIGIN = 'https://mcp.example.test'
export const SERVER_URL = `${SERVER_ORIGIN}/mcp`
export const ISSUER = 'https://auth.example.test'
export const REDIRECT_URI = 'https://app.example.test/aparte/oauth-callback.html'

export interface FakeTool {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly inputSchema?: unknown
  readonly annotations?: Record<string, unknown>
  readonly handler?: (args: Record<string, unknown>) => McpCallResult | Promise<McpCallResult>
}

export interface Seen {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string
  readonly mode?: string
}

const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } })

interface Grant {
  readonly challenge: string
  readonly redirectUri: string
  readonly clientId: string
  readonly resource: string | null
}

/** An MCP server (Streamable HTTP, JSON responses) with an optional OAuth authorization server. */
export class FakeMcpServer {
  tools: FakeTool[] = []
  readonly seen: Seen[] = []
  readonly calls: { readonly name: string; readonly args: Record<string, unknown> }[] = []
  /** A static token the server requires (bearer auth), or null. */
  staticToken: string | null = null
  /** OAuth: the server requires a token it issued. */
  oauth = false
  /** Answers every request with a network error, except no-cors probes (a server without CORS). */
  noCors = false
  /** An extra raw body for `tools/call` (an oversized answer), replacing the JSON-RPC result. */
  rawCallBody: string | null = null
  expiresIn = 3600
  /** `sse`: the legacy HTTP+SSE transport (GET the stream, POST to the endpoint it names, answers on the stream). */
  transport: 'http' | 'sse' = 'http'
  private stream: ReadableStreamDefaultController<Uint8Array> | null = null
  readonly issued: { access: string; refresh: string }[] = []
  readonly grants = new Map<string, Grant>()
  readonly clients = new Set<string>()
  private counter = 0

  readonly request = async (input: string | URL, init: RequestInit & { purpose: 'mcp' }): Promise<Response> => {
    if (init.purpose !== 'mcp') throw new Error(`Wrong purpose ${String(init.purpose)}`)
    const url = new URL(String(input))
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((v, k) => {
      headers[k] = v
    })
    const body = typeof init.body === 'string' ? init.body : init.body == null ? '' : String(init.body)
    this.seen.push({
      url: url.href,
      method: init.method ?? 'GET',
      headers,
      body,
      ...(init.mode ? { mode: init.mode } : {}),
    })
    if (this.noCors) {
      if (init.mode === 'no-cors') return new Response(null, { status: 200 })
      throw new TypeError('Failed to fetch')
    }
    if (url.origin === ISSUER) return this.authServer(url, init.method ?? 'GET', body, headers)
    if (url.origin !== SERVER_ORIGIN) throw new TypeError('Failed to fetch')
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return this.oauth ? json(200, { resource: SERVER_URL, authorization_servers: [ISSUER] }) : json(404, {})
    }
    if (url.pathname !== '/mcp' && !(this.transport === 'sse' && url.pathname === '/messages')) return json(404, {})
    if (!this.authorized(headers.authorization)) {
      return json(
        401,
        { error: 'invalid_token' },
        {
          'www-authenticate': `Bearer resource_metadata="${SERVER_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
        },
      )
    }
    if (this.transport === 'sse') return this.sse(url, init.method ?? 'GET', body)
    if ((init.method ?? 'GET') === 'GET') return new Response(null, { status: 405 })
    if (init.method === 'DELETE') return new Response(null, { status: 200 })
    return this.rpc(JSON.parse(body))
  }

  private async sse(url: URL, method: string, body: string): Promise<Response> {
    const encoder = new TextEncoder()
    if (method === 'GET' && url.pathname === '/mcp') {
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.stream = controller
          controller.enqueue(encoder.encode('event: endpoint\ndata: /messages?session=1\n\n'))
        },
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    if (method === 'POST' && url.pathname === '/messages') {
      const answer = await this.rpc(JSON.parse(body))
      if (answer.status === 200) {
        const text = await answer.text()
        this.stream?.enqueue(encoder.encode(`event: message\ndata: ${text}\n\n`))
      }
      return new Response(null, { status: 202 })
    }
    return json(405, {})
  }

  private authorized(header: string | undefined): boolean {
    if (this.staticToken !== null) return header === `Bearer ${this.staticToken}`
    if (this.oauth) {
      const latest = this.issued.at(-1)
      return latest !== undefined && header === `Bearer ${latest.access}`
    }
    return true
  }

  private async rpc(message: { id?: number; method: string; params?: Record<string, unknown> }): Promise<Response> {
    if (message.id === undefined) return new Response(null, { status: 202 })
    const ok = (result: unknown) => json(200, { jsonrpc: '2.0', id: message.id, result })
    switch (message.method) {
      case 'initialize':
        return ok({
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'fake', version: '1.0' },
        })
      case 'tools/list':
        return ok({
          tools: this.tools.map(({ handler: _h, ...t }) => ({ inputSchema: { type: 'object' }, ...t })),
        })
      case 'tools/call': {
        const name = String(message.params?.name)
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>
        this.calls.push({ name, args })
        if (this.rawCallBody !== null) {
          return new Response(this.rawCallBody, { status: 200, headers: { 'content-type': 'application/json' } })
        }
        const tool = this.tools.find((t) => t.name === name)
        if (tool === undefined)
          return json(200, { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Unknown tool' } })
        return ok(tool.handler ? await tool.handler(args) : { content: [{ type: 'text', text: `${name} ran` }] })
      }
      default:
        return json(200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } })
    }
  }

  private async authServer(url: URL, method: string, body: string, headers: Record<string, string>): Promise<Response> {
    if (url.pathname === '/.well-known/oauth-authorization-server' && method === 'GET') {
      return json(200, {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        registration_endpoint: `${ISSUER}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        authorization_response_iss_parameter_supported: true,
      })
    }
    if (url.pathname === '/register' && method === 'POST') {
      const meta = JSON.parse(body) as { redirect_uris: string[] }
      const id = `client-${++this.counter}`
      this.clients.add(id)
      return json(201, { client_id: id, redirect_uris: meta.redirect_uris, token_endpoint_auth_method: 'none' })
    }
    if (url.pathname === '/token' && method === 'POST') {
      if (headers['content-type'] !== 'application/x-www-form-urlencoded')
        return json(400, { error: 'invalid_request' })
      const q = new URLSearchParams(body)
      if (!this.clients.has(q.get('client_id') ?? '')) return json(401, { error: 'invalid_client' })
      if (q.get('grant_type') === 'authorization_code') {
        const code = q.get('code') ?? ''
        const grant = this.grants.get(code)
        this.grants.delete(code)
        if (grant === undefined) return json(400, { error: 'invalid_grant' })
        const challenge = base64urlEncode(await sha256(utf8(q.get('code_verifier') ?? '')))
        if (challenge !== grant.challenge || q.get('redirect_uri') !== grant.redirectUri) {
          return json(400, { error: 'invalid_grant' })
        }
        if (q.get('resource') !== grant.resource) return json(400, { error: 'invalid_target' })
        return json(200, this.issue())
      }
      if (q.get('grant_type') === 'refresh_token') {
        if (!this.issued.some((t) => t.refresh === q.get('refresh_token'))) return json(400, { error: 'invalid_grant' })
        return json(200, this.issue())
      }
      return json(400, { error: 'unsupported_grant_type' })
    }
    return json(404, {})
  }

  private issue() {
    const n = ++this.counter
    const tokens = { access: `access-${n}-canary`, refresh: `refresh-${n}-canary` }
    this.issued.push(tokens)
    return {
      access_token: tokens.access,
      token_type: 'Bearer',
      expires_in: this.expiresIn,
      refresh_token: tokens.refresh,
    }
  }

  /** What the authorization server does when the user approves in the popup: a code bound to the request. */
  authorize(authorizationUrl: string): { readonly code: string; readonly state: string } {
    const url = new URL(authorizationUrl)
    const q = url.searchParams
    if (url.origin !== ISSUER || q.get('code_challenge_method') !== 'S256') throw new Error('Bad authorization URL')
    const code = `code-${++this.counter}`
    this.grants.set(code, {
      challenge: q.get('code_challenge') ?? '',
      redirectUri: q.get('redirect_uri') ?? '',
      clientId: q.get('client_id') ?? '',
      resource: q.get('resource'),
    })
    return { code, state: q.get('state') ?? '' }
  }

  /** The `tools/call` requests made. */
  callCount(): number {
    return this.calls.length
  }
}

/** Named channels, delivering asynchronously like BroadcastChannel (never to the sender, which is not a channel). */
export function channelHub(): {
  open(name: string): CallbackChannel
  post(name: string, data: unknown): void
  readonly opened: string[]
  listening(name: string): number
} {
  const channels = new Map<string, Set<CallbackChannel>>()
  const opened: string[] = []
  return {
    opened,
    open(name) {
      opened.push(name)
      const channel: CallbackChannel = {
        onmessage: null,
        close() {
          channels.get(name)?.delete(channel)
        },
      }
      let set = channels.get(name)
      if (set === undefined) {
        set = new Set()
        channels.set(name, set)
      }
      set.add(channel)
      return channel
    },
    post(name, data) {
      for (const channel of [...(channels.get(name) ?? [])]) {
        queueMicrotask(() => channel.onmessage?.({ data }))
      }
    },
    listening(name) {
      return channels.get(name)?.size ?? 0
    },
  }
}

/** The message oauth-callback.html posts. */
export function callbackMessage(fields: { state: string; code?: string; iss?: string; error?: string }): unknown {
  return {
    type: CALLBACK_TYPE,
    state: fields.state,
    code: fields.code ?? null,
    iss: fields.iss ?? null,
    error: fields.error ?? null,
  }
}
