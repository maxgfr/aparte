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
import type { Bytes } from '../core/contracts/crypto.ts'
import type { LocalStore } from '../core/contracts/store.ts'
import type {
  DestinationConfig,
  GitHubDestination,
  RemoteStore,
  S3Destination,
  SyncStatus,
} from '../core/contracts/sync.ts'
import type { Vault } from '../core/contracts/vault.ts'
import type { SyncEngineImpl } from '../core/sync/engine.ts'
import type { FsDirHandle } from '../core/sync/providers/folder.ts'
import type { GitHubCheck } from '../core/sync/providers/github.ts'
import type { SyncScheduler } from '../core/sync/scheduler.ts'
import { request } from '../security/net.ts'
import { type ChatSession, useSession } from './chat.tsx'
import { useVault } from './vault.tsx'

/*
 * End-to-end encrypted sync for the interface: the engine and the scheduler of an open session, the destinations this
 * device is set up with, and the join of a vault from its store before this device holds it.
 *
 * Invariants:
 * - Destination settings, credentials included, are local records of purpose `sync-credential` (encrypted, never
 *   synced, never in a document). Each device is set up on its own.
 * - Every request a destination makes goes through web/src/security/net.ts with purpose `sync`.
 * - Sync runs only while the vault is unlocked and a passphrase protects it: another device cannot open a `device`
 *   vault (spec/FORMAT.md section 17), so it has no keyslot to send. A round holds the vault lock while it writes, and
 *   locking stops the scheduler and closes the engine. A folder handle is kept in memory only, for the page's lifetime: nothing that
 *   could be read stays on the device.
 * - The sync modules load in chunks of their own, after the session opened.
 */

/** A destination as this device keeps it, without its secret. */
export interface DestinationView {
  readonly id: string
  readonly kind: DestinationConfig['kind']
  readonly label: string
  /** A folder chosen before a reload: the browser must be asked for it again. */
  readonly needsFolder: boolean
}

/** What joining from a store leaves for the first unlock: the destination to keep, or an archive to import. */
type PendingJoin =
  | { readonly kind: 'destination'; readonly config: DestinationConfig }
  | { readonly kind: 'archive'; readonly entries: ReadonlyMap<string, Bytes> }

let pendingJoin: PendingJoin | null = null
/** Folder handles chosen in this page, by destination id. */
const folders = new Map<string, FsDirHandle>()

/** Whether this page joined a vault and has not unlocked it yet: the lock screen then keeps the Secret Key. */
export function joinedThisPage(): boolean {
  return pendingJoin !== null
}

/** The `fetch` of every destination: the app's one network door, purpose `sync`. */
const http = (url: string, init: RequestInit): Promise<Response> => request(url, { ...init, purpose: 'sync' })

const labelOf = (config: DestinationConfig): string => {
  if (config.kind === 'github') return `${config.owner}/${config.repo}`
  if (config.kind === 's3') return `${config.bucket}${config.prefix ? `/${config.prefix}` : ''}`
  return config.label
}

type Providers = typeof import('../core/sync/providers/github.ts') &
  typeof import('../core/sync/providers/s3.ts') &
  typeof import('../core/sync/providers/folder.ts') &
  typeof import('../core/sync/providers/zip.ts')

async function loadProviders(): Promise<Providers> {
  const [github, s3, folder, zip] = await Promise.all([
    import('../core/sync/providers/github.ts'),
    import('../core/sync/providers/s3.ts'),
    import('../core/sync/providers/folder.ts'),
    import('../core/sync/providers/zip.ts'),
  ])
  return { ...github, ...s3, ...folder, ...zip }
}

/** The store of a destination, or null for a folder whose handle this page does not have. */
function storeOf(p: Providers, config: DestinationConfig): RemoteStore | null {
  if (config.kind === 'github') {
    return p.githubStore({
      owner: config.owner,
      repo: config.repo,
      ...(config.branch ? { branch: config.branch } : {}),
      ...(config.root ? { root: config.root } : {}),
      token: config.token,
      http,
    })
  }
  if (config.kind === 's3') {
    return p.s3Store({
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      ...(config.prefix ? { prefix: config.prefix } : {}),
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      http,
    })
  }
  const handle = folders.get(`folder:${config.label}`)
  return handle ? p.folderStore(handle, config.label) : null
}

function idOf(p: Providers, config: DestinationConfig): string {
  if (config.kind === 'github') return p.githubStoreId(config)
  if (config.kind === 's3') return p.s3StoreId(config)
  return `folder:${config.label}`
}

async function readConfigs(store: LocalStore): Promise<Map<string, DestinationConfig>> {
  const out = new Map<string, DestinationConfig>()
  for (const id of await store.list('sync-credential')) {
    const bytes = await store.get('sync-credential', id)
    if (bytes === null) continue
    try {
      const config = JSON.parse(new TextDecoder().decode(bytes)) as DestinationConfig
      if (config.kind === 'github' || config.kind === 's3' || config.kind === 'folder') out.set(id, config)
    } catch {
      // A record this build cannot read is left alone.
    }
  }
  return out
}

const writeConfig = (store: LocalStore, id: string, config: DestinationConfig): Promise<void> =>
  store.put('sync-credential', id, new TextEncoder().encode(JSON.stringify(config)))

/** Exclusive locks shared by the pages of this device; directly without the Web Locks API. */
const webLock = <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  return locks ? (locks.request(name, fn) as Promise<T>) : fn()
}

interface SyncRuntime {
  readonly engine: SyncEngineImpl
  readonly scheduler: SyncScheduler
  readonly providers: Providers
  readonly store: LocalStore
  readonly configs: Map<string, DestinationConfig>
  close(): void
}

async function openSync(vault: Vault, session: ChatSession): Promise<SyncRuntime> {
  const [{ createSyncEngine }, { createScheduler }, { cryptoRng }, providers] = await Promise.all([
    import('../core/sync/engine.ts'),
    import('../core/sync/scheduler.ts'),
    import('../core/crypto/rng.ts'),
    loadProviders(),
  ])
  const store = vault.localStore()
  const rng = cryptoRng()
  const clock = { now: () => Date.now() }
  const vaultId = vault.status().vaultId as string
  const engine = createSyncEngine({
    store,
    subkeys: vault.subkeys(),
    workspace: session.workspace,
    keyslots: {
      vault: vaultId,
      files: () => vault.keyslotFiles(),
      import: (files) => vault.importKeyslots(files),
    },
    rng,
    clock,
    lock: webLock,
    hold: (reason) => vault.holdLock(reason),
  })

  const join = pendingJoin
  pendingJoin = null
  if (join?.kind === 'destination') await writeConfig(store, idOf(providers, join.config), join.config)

  const configs = await readConfigs(store)
  for (const [id, config] of configs) {
    const remote = storeOf(providers, config)
    if (remote && remote.id === id) engine.addDestination(remote, labelOf(config))
  }

  const scheduler = createScheduler({
    engine,
    clock,
    rng,
    timers: {
      set(fn, ms) {
        const handle = setTimeout(fn, ms)
        return () => clearTimeout(handle)
      },
    },
    isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  })

  if (join?.kind === 'archive') {
    const archive = providers.zipStore(join.entries, 'zip:import')
    engine.addDestination(archive, 'archive', { transient: true })
    try {
      await engine.round(archive.id)
    } catch {
      // The archive's keyslots opened the vault; whatever else in it did not import can be imported again from the
      // sync screen. Sync itself still starts.
    } finally {
      engine.removeDestination(archive.id)
    }
  }

  const onOnline = () => scheduler.trigger('online')
  const onVisible = () => {
    if (document.visibilityState === 'visible') scheduler.trigger('visible')
  }
  addEventListener('online', onOnline)
  document.addEventListener('visibilitychange', onVisible)
  let unsaved = session.workspace.persistence().unsaved
  const offPersistence = session.workspace.onPersistence(() => {
    const now = session.workspace.persistence().unsaved
    // Local changes just reached the device's queue: they are ready to seal and send.
    if (now === 0 && unsaved > 0) scheduler.trigger('sealed')
    unsaved = now
  })
  scheduler.start()

  let closed = false
  return {
    engine,
    scheduler,
    providers,
    store,
    configs,
    close() {
      if (closed) return
      closed = true
      scheduler.stop()
      engine.close()
      removeEventListener('online', onOnline)
      document.removeEventListener('visibilitychange', onVisible)
      try {
        offPersistence()
      } catch {
        // The workspace already closed.
      }
    },
  }
}

export interface SyncValue {
  readonly ready: boolean
  readonly status: SyncStatus
  readonly destinations: readonly DestinationView[]
  readonly folderSupported: boolean
  syncNow(): void
  connectGitHub(config: Omit<GitHubDestination, 'kind'>): Promise<GitHubCheck>
  connectS3(config: Omit<S3Destination, 'kind'>): Promise<void>
  connectFolder(): Promise<boolean>
  reconnectFolder(id: string): Promise<boolean>
  remove(id: string): Promise<void>
  dismissAlarm(id: string): Promise<void>
  exportArchive(): Promise<{ readonly bytes: Bytes; readonly count: number }>
  importArchive(bytes: Uint8Array): Promise<void>
  corsRule(origin: string): { readonly json: string; readonly xml: string } | null
}

const EMPTY: SyncStatus = Object.freeze({ dests: [], alarms: [] })

type DirectoryPicker = (options: { mode: 'readwrite' }) => Promise<FsDirHandle>

const picker = (): DirectoryPicker | null => {
  const pick = (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker
  return typeof pick === 'function' ? pick.bind(globalThis) : null
}

const SyncContext = createContext<SyncValue | null>(null)

export function useSync(): SyncValue {
  const value = useContext(SyncContext)
  if (value === null) throw new Error('useSync must be used inside <SyncProvider>')
  return value
}

/** Runs sync while the chat session is open. */
export function SyncProvider({ children }: { readonly children: ReactNode }) {
  const { vault, status: vaultStatus } = useVault()
  const protectedByPassphrase = vaultStatus.protection === 'passphrase'
  const session = useSession()
  const workspace = session?.workspace ?? null
  const [runtime, setRuntime] = useState<SyncRuntime | null>(null)
  const [version, setVersion] = useState(0)
  const sessionRef = useRef(session)
  sessionRef.current = session

  useEffect(() => {
    const current = sessionRef.current
    if (workspace === null || current === null || !protectedByPassphrase) {
      setRuntime(null)
      return
    }
    let live = true
    let opened: SyncRuntime | null = null
    const unregister = vault.onLock(() => {
      live = false
      opened?.close()
      setRuntime(null)
    })
    openSync(vault, current).then(
      (r) => {
        opened = r
        if (!live) {
          r.close()
          return
        }
        setRuntime(r)
      },
      () => undefined,
    )
    return () => {
      live = false
      unregister()
      opened?.close()
    }
  }, [vault, workspace, protectedByPassphrase])

  const subscribe = useCallback(
    (fn: () => void) => (runtime === null ? () => undefined : runtime.engine.subscribe(fn)),
    [runtime],
  )
  const read = useCallback(() => (runtime === null ? EMPTY : runtime.engine.status()), [runtime])
  const status = useSyncExternalStore(subscribe, read, read)

  const destinations = useMemo<readonly DestinationView[]>(() => {
    void version
    if (runtime === null) return []
    return [...runtime.configs].map(([id, config]) => ({
      id,
      kind: config.kind,
      label: labelOf(config),
      needsFolder: config.kind === 'folder' && !folders.has(id),
    }))
  }, [runtime, version])

  const add = useCallback(
    async (config: DestinationConfig): Promise<void> => {
      if (runtime === null) throw new Error('Sync is not open')
      const remote = storeOf(runtime.providers, config)
      const id = idOf(runtime.providers, config)
      await writeConfig(runtime.store, id, config)
      runtime.configs.set(id, config)
      if (remote) {
        runtime.engine.removeDestination(id)
        runtime.engine.addDestination(remote, labelOf(config))
      }
      setVersion((v) => v + 1)
      runtime.scheduler.trigger('manual')
    },
    [runtime],
  )

  const value = useMemo<SyncValue>(
    () => ({
      ready: runtime !== null,
      status,
      destinations,
      folderSupported: picker() !== null,
      syncNow() {
        runtime?.scheduler.trigger('manual')
      },
      async connectGitHub(input) {
        if (runtime === null) throw new Error('Sync is not open')
        const check = await runtime.providers.checkGitHub({ ...input, http })
        if (check.ok) await add({ kind: 'github', ...input })
        return check
      },
      async connectS3(input) {
        if (runtime === null) throw new Error('Sync is not open')
        const remote = runtime.providers.s3Store({ ...input, http })
        await remote.list('fmt/')
        await add({ kind: 's3', ...input })
      },
      async connectFolder() {
        const pick = picker()
        if (pick === null || runtime === null) return false
        const handle = await pick({ mode: 'readwrite' })
        folders.set(`folder:${handle.name}`, handle)
        await add({ kind: 'folder', label: handle.name })
        return true
      },
      async reconnectFolder(id) {
        const pick = picker()
        const config = runtime?.configs.get(id)
        if (pick === null || runtime === null || config?.kind !== 'folder') return false
        const handle = await pick({ mode: 'readwrite' })
        folders.set(`folder:${config.label}`, handle)
        await add(config)
        return true
      },
      async remove(id) {
        if (runtime === null) return
        runtime.engine.removeDestination(id)
        runtime.configs.delete(id)
        folders.delete(id)
        await runtime.store.delete('sync-credential', id)
        setVersion((v) => v + 1)
      },
      async dismissAlarm(id) {
        await runtime?.engine.dismissAlarm(id)
      },
      async exportArchive() {
        if (runtime === null) throw new Error('Sync is not open')
        const archive = runtime.providers.zipStore(new Map(), `zip:export:${Date.now()}`)
        runtime.engine.addDestination(archive, 'archive', { transient: true })
        try {
          await runtime.engine.round(archive.id)
        } finally {
          runtime.engine.removeDestination(archive.id)
        }
        return { bytes: archive.toBytes(), count: archive.size }
      },
      async importArchive(bytes) {
        if (runtime === null) throw new Error('Sync is not open')
        const entries = await runtime.providers.readZip(bytes)
        const archive = runtime.providers.zipStore(entries, `zip:import:${Date.now()}`)
        runtime.engine.addDestination(archive, 'archive', { transient: true })
        try {
          await runtime.engine.round(archive.id)
        } finally {
          runtime.engine.removeDestination(archive.id)
        }
      },
      corsRule(origin) {
        return runtime === null ? null : runtime.providers.corsRule(origin)
      },
    }),
    [runtime, status, destinations, add],
  )
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>
}

// Joining a vault from its store, before this device holds it

export type JoinSource =
  | { readonly kind: 'github'; readonly config: Omit<GitHubDestination, 'kind'> }
  | { readonly kind: 'archive'; readonly bytes: Uint8Array }

/**
 * Reads the vault a store holds and makes this device hold it, locked (Vault.join), in place of the `device` vault
 * this device started with: that vault and everything in it are deleted. The store is read first, so a lookup that
 * fails changes nothing. The destination (or the archive) is kept in this page's memory until the first unlock,
 * which stores it encrypted and syncs.
 */
export async function joinFromStore(vault: Vault, source: JoinSource): Promise<void> {
  const [{ readStoredVault }, providers] = await Promise.all([import('../core/sync/join.ts'), loadProviders()])
  if (source.kind === 'github') {
    const store = providers.githubStore({ ...source.config, http })
    const stored = await readStoredVault(store)
    pendingJoin = { kind: 'destination', config: { kind: 'github', ...source.config } }
    await joinStored(vault, stored)
    return
  }
  const entries = await providers.readZip(source.bytes)
  const stored = await readStoredVault(providers.zipStore(entries))
  pendingJoin = { kind: 'archive', entries }
  await joinStored(vault, stored)
}

/** Joins `stored`; the pending destination goes if the vault would not take it. */
async function joinStored(vault: Vault, stored: Parameters<Vault['join']>[0]): Promise<void> {
  try {
    await vault.join(stored, { replaceDevice: true })
  } catch (error) {
    pendingJoin = null
    throw error
  }
}
