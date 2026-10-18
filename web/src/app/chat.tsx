import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import type { Catalog } from '../core/ai/catalog.ts'
import type { BeamEngine, BeamState } from '../core/compare/beam.ts'
import type {
  AdaptersModule,
  CapabilitiesModule,
  ChatAdapter,
  EffortModule,
  ModelDescriptor,
  ProviderConfig,
  ProviderKeys,
  ProviderKind,
} from '../core/contracts/ai.ts'
import type { ChatController, RequestModule, StreamState } from '../core/contracts/chat.ts'
import type { CollectionName, CollectionTypes } from '../core/contracts/extras.ts'
import type { RegisteredTool, ToolApproval, ToolRegistry } from '../core/contracts/tools.ts'
import type { Vault } from '../core/contracts/vault.ts'
import type {
  Conversation,
  ConversationFilter,
  Entity,
  Id,
  Message,
  ModelRef,
  Part,
  Settings,
  Thread,
  Workspace,
} from '../core/contracts/workspace.ts'
import type { LocalBlobs } from '../core/media/blobs.ts'
import type { SearchIndex } from '../core/search/search.ts'
import { holdReload } from '../pwa/register.ts'
import { createMcpHost, type McpHost } from './mcpHost.ts'
import { resolveModelWith } from './providers.tsx'
import { useVault } from './vault.tsx'

/*
 * The chat session of an unlocked vault, for the interface: the workspace (the vault's Yjs documents), the chat
 * controller, the provider keys and the blob store, opened once the vault unlocks and closed when it locks. Screens
 * read them through the hooks below, which re-render on the workspace's own change notifications.
 *
 * Invariants:
 * - A session exists only while the vault is unlocked or locking. On lock, every stream is stopped and committed
 *   (`chat.dispose()`), the search index is dropped, then the workspace closes, the decrypted object URLs are revoked
 *   and the rendered Markdown and large-part caches are dropped; nothing decrypted outlives the lock in this page.
 * - While the workspace has changes the pending queue has not saved, it holds the vault lock (`workspace-save`,
 *   core/workspace/lifecycle.ts), so a lock waits for the write instead of losing it.
 * - The core modules (Yjs, the AI SDK and its providers) load in chunks of their own when the vault first unlocks,
 *   never with the first paint.
 * - The on-device engines (core/ai/local, app/local.ts) are stopped on lock: their workers terminate.
 * - Streams hold the vault lock and the PWA reload (the controller takes both, `chat-stream`), so neither an
 *   auto-lock nor an update cuts an answer.
 * - The tool registry holds the built-in tools (web/src/core/tools/builtins.ts) for the session only; approvals that
 *   outlive a call are stored encrypted in the workspace (`toolApprovals`).
 * - The MCP client (app/mcpHost.ts) adds the tools of the MCP servers to the same registry while the session is open;
 *   it is disposed with the session, before the workspace closes.
 */

/** The core modules a session uses, loaded together after unlock. */
export interface ChatModules {
  readonly capabilities: CapabilitiesModule
  readonly effort: EffortModule
  readonly adapters: AdaptersModule
  readonly request: RequestModule
}

/** Provider keys that tell the interface when they change (there is no other way to observe them). */
export interface ObservableKeys extends ProviderKeys {
  subscribe(fn: () => void): () => void
}

export interface ChatSession {
  readonly workspace: Workspace
  readonly chat: ChatController
  /** Beam and the Arena: several models answering one message (core/compare/beam.ts). */
  readonly beam: BeamEngine
  readonly keys: ObservableKeys
  readonly blobs: LocalBlobs
  /** Full-text search over the conversations, in memory only; dropped on lock. */
  readonly search: SearchIndex
  /** The tools chats may declare (contracts/tools.ts), registered when the session opens. */
  readonly tools: ToolRegistry
  /** The MCP client, loaded once the vault has a server (or a screen asks for it). */
  readonly mcp: McpHost
  readonly modules: ChatModules
  /** The bundled model catalog, null until its chunk has loaded (the session opens without waiting for it). */
  readonly catalog: Catalog | null
  /** The model a reference names, or null when its provider or kind is unknown or trashed. */
  resolveModel(ref: ModelRef): ModelDescriptor | null
  /** An object URL for a stored image, or null when this device does not have it; revoked on lock. */
  blobUrl(blob: string, mediaType: string): Promise<string | null>
  /** The part a `ref` part stores (spec/DATA-MODEL.md section 4.3), or null when this device does not have it. */
  refPart(blob: string): Promise<Part | null>
}

type SessionState =
  | { readonly status: 'closed' }
  | { readonly status: 'opening' }
  | { readonly status: 'open'; readonly session: ChatSession }
  | { readonly status: 'failed'; readonly error: unknown }

const SessionContext = createContext<SessionState>({ status: 'closed' })

function observableKeys(keys: ProviderKeys): ObservableKeys {
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const fn of listeners) fn()
  }
  return {
    get: (id) => keys.get(id),
    list: () => keys.list(),
    async set(id, key) {
      await keys.set(id, key)
      notify()
    },
    async delete(id) {
      await keys.delete(id)
      notify()
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

/** Opens the session of an unlocked vault; the returned `close` runs the lock cleanup. */
async function openSession(vault: Vault): Promise<{
  session: ChatSession
  close: () => Promise<void>
  /** Resolves with the session once the catalog has loaded (a new object, so readers render again). */
  withCatalog: Promise<ChatSession>
}> {
  const [
    ws,
    lifecycle,
    searchModule,
    controller,
    keysModule,
    adapters,
    capabilities,
    effort,
    request,
    blobsModule,
    rngModule,
    render,
    registryModule,
    builtinsModule,
    toolFetchModule,
    local,
    streams,
    beamModule,
  ] = await Promise.all([
    import('../core/workspace/workspace.ts'),
    import('../core/workspace/lifecycle.ts'),
    import('../core/search/search.ts'),
    import('../core/chat/controller.ts'),
    import('../core/ai/keys.ts'),
    import('../core/ai/adapters.ts'),
    import('../core/ai/capabilities.ts'),
    import('../core/ai/effort.ts'),
    import('../core/chat/request.ts'),
    import('../core/media/blobs.ts'),
    import('../core/crypto/rng.ts'),
    import('../ui/render/markdown.ts'),
    import('../core/tools/registry.ts'),
    import('../core/tools/builtins.ts'),
    import('../core/tools/fetch.ts'),
    import('./local.ts'),
    import('../core/sync/streams.ts'),
    import('../core/compare/beam.ts'),
  ])
  const store = vault.localStore()
  const subkeys = vault.subkeys()
  const rng = rngModule.cryptoRng()
  const clock = { now: () => Date.now() }
  // What sync brought to this device (the object mirror) is replayed with each document, under its pending queue.
  const workspace = await ws.openWorkspace({
    store,
    subkeys,
    rng,
    clock,
    base: (docId) => streams.mirroredUpdates(store.objects, subkeys, docId),
  })
  const search = searchModule.createSearch({ workspace, onLock: (cleanup) => vault.onLock(cleanup) })
  // The session's own lock cleanup (below) runs first, as it was registered first; this one then finds the search
  // disposed and the workspace closed, which are both idempotent.
  const unbind = lifecycle.bindWorkspaceToVault(vault, workspace, [() => search.dispose()])
  const keys = observableKeys(keysModule.createProviderKeys(store))
  const blobs = blobsModule.createLocalBlobs({ objects: store.objects, subkeys, rng })
  const modules: ChatModules = { capabilities, effort, adapters, request }
  const adapterCache = new Map<ProviderKind, ChatAdapter>()
  const adapter = (kind: ProviderKind): ChatAdapter => {
    let a = adapterCache.get(kind)
    if (a === undefined) {
      // The on-device kinds run in this browser (core/ai/local); every other kind goes over the network.
      a = local.localAdapter(kind) ?? adapters.createAdapter(kind)
      adapterCache.set(kind, a)
    }
    return a
  }
  // The controller resolves models through the same function: it sees the catalog as soon as it has loaded.
  let catalog: Catalog | null = null
  const resolveModel = (ref: ModelRef) => {
    const model = resolveModelWith(workspace, capabilities, catalog, ref)
    const name = model === null ? null : local.localModelName(model.kind, ref.id)
    return model === null || name === null ? model : { ...model, name }
  }
  const tools = registryModule.createToolRegistry()
  for (const tool of builtinsModule.builtinTools({ clock, search, download: toolFetchModule.toolFetch })) {
    await tools.register(tool)
  }
  const mcp = createMcpHost({ workspace, registry: tools, store, rng })
  const chat = controller.createChatController({
    workspace,
    holdLock: (reason: string) => vault.holdLock(reason),
    holdReload,
    adapter,
    keys,
    resolveModel,
    blobs,
    rng,
    clock,
    tools: { registry: tools, approvals: workspace.toolApprovals },
  })
  const beam = beamModule.createBeamEngine({
    workspace,
    holdLock: (reason: string) => vault.holdLock(reason),
    holdReload,
    adapter,
    keys,
    resolveModel,
    blobs,
    rng,
    clock,
    tools: { registry: tools },
  })

  const urls = new Map<string, Promise<string | null>>()
  const blobUrl = (blob: string, mediaType: string): Promise<string | null> => {
    const key = `${blob}|${mediaType}`
    let url = urls.get(key)
    if (url === undefined) {
      url = blobs
        .get(blob)
        .then((bytes) => (bytes === null ? null : URL.createObjectURL(new Blob([bytes], { type: mediaType }))))
      // A failed read is not cached: the blob may arrive later.
      url.then(
        (u) => {
          if (u === null) urls.delete(key)
        },
        () => urls.delete(key),
      )
      urls.set(key, url)
    }
    return url
  }

  const parts = new Map<string, Promise<Part | null>>()
  const refPart = (blob: string): Promise<Part | null> => {
    let part = parts.get(blob)
    if (part === undefined) {
      part = blobs.get(blob).then((bytes) => {
        if (bytes === null) return null
        const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        const ok =
          typeof parsed === 'object' && parsed !== null && typeof (parsed as { type?: unknown }).type === 'string'
        return ok ? (parsed as Part) : null
      })
      // A blob that is not here yet is asked for again later.
      part.then(
        (p) => {
          if (p === null) parts.delete(blob)
        },
        () => parts.delete(blob),
      )
      parts.set(blob, part)
    }
    return part
  }

  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try {
      await Promise.all([chat.dispose(), beam.dispose()])
      await mcp.dispose().catch(() => undefined)
    } finally {
      // The model workers hold the conversation in memory (its prompt, its cache on the GPU): they go with the lock.
      local.releaseLocal()
      search.dispose()
      unbind()
      workspace.close()
      parts.clear()
      for (const url of urls.values())
        url.then(
          (u) => u !== null && URL.revokeObjectURL(u),
          () => undefined,
        )
      urls.clear()
      render.clearRenderCache()
    }
  }
  const session: ChatSession = {
    workspace,
    chat,
    beam,
    keys,
    blobs,
    search,
    tools,
    mcp,
    modules,
    catalog,
    resolveModel,
    blobUrl,
    refPart,
  }
  const withCatalog = import('../core/ai/catalog.ts')
    .then((m) => m.loadBundledCatalog())
    .then((loaded) => {
      catalog = loaded
      return { ...session, catalog: loaded }
    })
  return { session, close, withCatalog }
}

/** Opens the chat session whenever the vault is unlocked and closes it on lock. */
export function ChatProvider({ children }: { readonly children: ReactNode }) {
  const { vault, status } = useVault()
  const open = status.state === 'unlocked' || status.state === 'locking'
  const [state, setState] = useState<SessionState>({ status: 'closed' })

  useEffect(() => {
    if (!open) {
      setState({ status: 'closed' })
      return
    }
    let live = true
    let close: (() => Promise<void>) | null = null
    setState({ status: 'opening' })
    const unregister = vault.onLock(async () => {
      live = false
      setState({ status: 'closed' })
      await close?.()
    })
    openSession(vault).then(
      (opened) => {
        close = opened.close
        if (!live) {
          void opened.close()
          return
        }
        setState({ status: 'open', session: opened.session })
        opened.withCatalog.then(
          (session) => live && setState({ status: 'open', session }),
          // Without the catalog, models keep their ids as names and the conservative default capabilities.
          () => undefined,
        )
      },
      (error: unknown) => {
        if (live) setState({ status: 'failed', error })
      },
    )
    return () => {
      live = false
      unregister()
      void close?.()
    }
  }, [open, vault])

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>
}

/** The session state: closed (locked or no vault), opening, open or failed. */
export function useSessionState(): SessionState {
  return useContext(SessionContext)
}

/** The open session, or null. */
export function useSession(): ChatSession | null {
  const state = useContext(SessionContext)
  return state.status === 'open' ? state.session : null
}

/**
 * A value read from an external store that notifies changes: re-read only after a notification, so a reader that
 * builds a new array on each call never loops `useSyncExternalStore`.
 */
export function useExternal<T>(subscribe: ((fn: () => void) => () => void) | null, read: () => T): T {
  const cache = useRef<{ version: number; value: T; read: () => T } | null>(null)
  const version = useRef(0)
  const sub = useCallback(
    (fn: () => void) => {
      if (subscribe === null) return () => undefined
      return subscribe(() => {
        version.current++
        fn()
      })
    },
    [subscribe],
  )
  const get = () => {
    const c = cache.current
    if (c !== null && c.version === version.current && c.read === read) return c.value
    const value = read()
    cache.current = { version: version.current, value, read }
    return value
  }
  return useSyncExternalStore(sub, get, get)
}

const EMPTY_CONVERSATIONS: readonly Conversation[] = []

/** Conversations matching `filter`, pinned first then most recent. */
export function useConversations(filter?: ConversationFilter): readonly Conversation[] {
  const session = useSession()
  const ws = session?.workspace ?? null
  const trashed = filter?.trashed
  const archived = filter?.archived
  const folder = filter?.folder
  const subscribe = useMemo(() => (ws === null ? null : (fn: () => void) => ws.subscribe('conversations', fn)), [ws])
  const read = useCallback(() => {
    if (ws === null) return EMPTY_CONVERSATIONS
    const f: { trashed?: boolean; archived?: boolean; folder?: Id | null } = {}
    if (trashed !== undefined) f.trashed = trashed
    if (archived !== undefined) f.archived = archived
    if (folder !== undefined) f.folder = folder
    return ws.conversations.list(f)
  }, [ws, trashed, archived, folder])
  return useExternal(subscribe, read)
}

/** One conversation, or undefined. */
export function useConversation(id: Id | null): Conversation | undefined {
  const session = useSession()
  const ws = session?.workspace ?? null
  const subscribe = useMemo(() => (ws === null ? null : (fn: () => void) => ws.subscribe('conversations', fn)), [ws])
  const read = useCallback(() => (ws === null || id === null ? undefined : ws.conversations.get(id)), [ws, id])
  return useExternal(subscribe, read)
}

export type ThreadState =
  | { readonly status: 'loading' }
  | { readonly status: 'missing' }
  | { readonly status: 'ready'; readonly thread: Thread; readonly path: readonly Message[] }

/** The message tree of a conversation, its shard loaded on first use, and the active branch. */
export function useThread(id: Id | null): ThreadState {
  const session = useSession()
  const ws = session?.workspace ?? null
  const [thread, setThread] = useState<{ id: Id; thread: Thread } | { id: Id; missing: true } | null>(null)
  useEffect(() => {
    if (ws === null || id === null) return
    let live = true
    ws.thread(id).then(
      (t) => live && setThread({ id, thread: t }),
      () => live && setThread({ id, missing: true }),
    )
    return () => {
      live = false
    }
  }, [ws, id])
  const loaded = thread !== null && thread.id === id && 'thread' in thread ? thread.thread : null
  const subscribe = useMemo(
    () => (ws === null || id === null ? null : (fn: () => void) => ws.subscribe({ conversation: id }, fn)),
    [ws, id],
  )
  const read = useCallback(() => (loaded === null ? null : loaded.path()), [loaded])
  const path = useExternal(subscribe, read)
  if (id === null || (thread !== null && thread.id === id && 'missing' in thread)) return { status: 'missing' }
  if (loaded === null || path === null) return { status: 'loading' }
  return { status: 'ready', thread: loaded, path }
}

/**
 * A message's parts with each `ref` part replaced by the part its blob stores (spec/DATA-MODEL.md section 4.3). A part
 * still loading, or whose blob this device does not have, is left out meanwhile.
 */
export function useResolvedParts(parts: readonly Part[]): readonly Part[] {
  const session = useSession()
  const hasRef = parts.some((p) => p.type === 'ref')
  const [resolved, setResolved] = useState<{ from: readonly Part[]; parts: readonly Part[] } | null>(null)
  useEffect(() => {
    if (!hasRef || session === null) return
    let live = true
    void Promise.all(
      parts.map((p) => (p.type === 'ref' ? session.refPart(p.blob).catch(() => null) : Promise.resolve(p))),
    ).then((all) => {
      if (live) setResolved({ from: parts, parts: all.filter((p): p is Part => p !== null) })
    })
    return () => {
      live = false
    }
  }, [hasRef, session, parts])
  if (!hasRef) return parts
  if (resolved !== null && resolved.from === parts) return resolved.parts
  return parts.filter((p) => p.type !== 'ref')
}

/** The response streaming in a conversation, or null; re-renders on every stream change. */
export function useStream(id: Id | null): StreamState | null {
  const session = useSession()
  const chat = session?.chat ?? null
  const subscribe = useMemo(
    () =>
      chat === null || id === null
        ? null
        : (fn: () => void) =>
            chat.subscribe((_event, conv) => {
              if (conv === id) fn()
            }),
    [chat, id],
  )
  const read = useCallback(() => (chat === null || id === null ? null : chat.stream(id)), [chat, id])
  return useExternal(subscribe, read)
}

/** Conversations with a stream running. */
export function useStreaming(): readonly Id[] {
  const session = useSession()
  const chat = session?.chat ?? null
  const subscribe = useMemo(() => (chat === null ? null : (fn: () => void) => chat.subscribe(() => fn())), [chat])
  const read = useCallback(() => (chat === null ? [] : chat.streaming()), [chat])
  return useExternal(subscribe, read)
}

const EMPTY_PROVIDERS: readonly ProviderConfig[] = []

/** Providers that are not trashed, by label. */
export function useProviders(): readonly ProviderConfig[] {
  const session = useSession()
  const ws = session?.workspace ?? null
  const subscribe = useMemo(() => (ws === null ? null : (fn: () => void) => ws.subscribe('providers', fn)), [ws])
  const read = useCallback(() => (ws === null ? EMPTY_PROVIDERS : ws.providers.list()), [ws])
  return useExternal(subscribe, read)
}

/** One synced setting. */
export function useSetting<K extends keyof Settings>(key: K): Settings[K] | null {
  const session = useSession()
  const ws = session?.workspace ?? null
  const subscribe = useMemo(() => (ws === null ? null : (fn: () => void) => ws.subscribe('settings', fn)), [ws])
  const read = useCallback(() => (ws === null ? null : ws.settings.get(key)), [ws, key])
  return useExternal(subscribe, read)
}

/** Provider ids with a key on this device, refreshed when a key changes. */
export function useKeyedProviders(): ReadonlySet<string> | null {
  const session = useSession()
  const keys = session?.keys ?? null
  const [ids, setIds] = useState<ReadonlySet<string> | null>(null)
  useEffect(() => {
    if (keys === null) return
    let live = true
    const load = () =>
      keys.list().then(
        (list) => live && setIds(new Set(list)),
        () => live && setIds(new Set()),
      )
    void load()
    const off = keys.subscribe(() => void load())
    return () => {
      live = false
      off()
    }
  }, [keys])
  return ids
}

const EMPTY_TOOLS: readonly RegisteredTool[] = []

/** The tools of the session's registry, by name. */
export function useRegisteredTools(): readonly RegisteredTool[] {
  const session = useSession()
  const registry = session?.tools ?? null
  const subscribe = useMemo(() => (registry === null ? null : (fn: () => void) => registry.subscribe(fn)), [registry])
  const read = useCallback(() => (registry === null ? EMPTY_TOOLS : registry.list()), [registry])
  return useExternal(subscribe, read)
}

const EMPTY_APPROVALS: readonly ToolApproval[] = []

/** The stored tool approvals ("always" and "for this chat"). */
export function useToolApprovals(): readonly ToolApproval[] {
  const session = useSession()
  const ws = session?.workspace ?? null
  const subscribe = useMemo(() => (ws === null ? null : (fn: () => void) => ws.subscribe('toolApprovals', fn)), [ws])
  const read = useCallback(() => (ws === null ? EMPTY_APPROVALS : ws.toolApprovals.list()), [ws])
  return useExternal(subscribe, read)
}

/** Whether the workspace has local changes not yet saved on this device. */
export function usePersistence(): { readonly unsaved: number; readonly blocked: boolean } | null {
  const session = useSession()
  const ws = session?.workspace ?? null
  const subscribe = useMemo(() => (ws === null ? null : (fn: () => void) => ws.onPersistence(fn)), [ws])
  const read = useCallback(() => (ws === null ? null : ws.persistence()), [ws])
  return useExternal(subscribe, read)
}

/** The Beam or Arena comparison of a conversation, or null; re-renders on every stream change. */
export function useBeam(id: Id | null): BeamState | null {
  const session = useSession()
  const beam = session?.beam ?? null
  const subscribe = useMemo(
    () =>
      beam === null || id === null
        ? null
        : (fn: () => void) =>
            beam.subscribe((conv) => {
              if (conv === id) fn()
            }),
    [beam, id],
  )
  const read = useCallback(() => (beam === null || id === null ? null : beam.state(id)), [beam, id])
  return useExternal(subscribe, read)
}

const EMPTY_ENTITIES: readonly Entity<never>[] = []

/** The entities of a collection (contracts/extras.ts), not trashed, oldest first. */
export function useCollection<N extends CollectionName>(name: N): readonly Entity<CollectionTypes[N]>[] {
  const session = useSession()
  const ws = session?.workspace ?? null
  const subscribe = useMemo(() => (ws === null ? null : (fn: () => void) => ws.subscribe(name, fn)), [ws, name])
  const read = useCallback(
    () => (ws === null ? (EMPTY_ENTITIES as readonly Entity<CollectionTypes[N]>[]) : ws.collection(name).list()),
    [ws, name],
  )
  return useExternal(subscribe, read)
}

/** One entity of a collection, or undefined. */
export function useEntity<N extends CollectionName>(name: N, id: Id | null): Entity<CollectionTypes[N]> | undefined {
  const session = useSession()
  const ws = session?.workspace ?? null
  const subscribe = useMemo(() => (ws === null ? null : (fn: () => void) => ws.subscribe(name, fn)), [ws, name])
  const read = useCallback(() => (ws === null || id === null ? undefined : ws.collection(name).get(id)), [ws, name, id])
  return useExternal(subscribe, read)
}
