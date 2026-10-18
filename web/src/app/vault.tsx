import {
  createContext,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useLocation } from 'wouter'
import type { CreateVaultInput, LockReason, UnlockCredential, Vault, VaultStatus } from '../core/contracts/vault.ts'
import { useT } from '../i18n/react.tsx'
import { Button } from '../ui/components/Button.tsx'
import { EmptyState } from '../ui/components/EmptyState.tsx'
import { clearCopiedSecret } from './clipboard.ts'
import { lazyChunk, ScreenBoundary } from './lazyChunk.tsx'
import { readPref, writePref } from './prefs.ts'
import { paths } from './routes.ts'

/*
 * The vault of this device, for the interface: one Vault per page (web/src/core/vault/vault.ts), its status as React
 * state, the Emergency Kit of a vault just created or recovered, the auto-lock wired to user activity and page
 * visibility, and the gate that shows the lock screen instead of the app whenever the vault is locked.
 *
 * Invariants:
 * - Nothing of the app renders while the vault is locked or unlocking: the gate replaces the whole shell, so no
 *   screen can show a title, a count or a preview from behind the lock.
 * - The Emergency Kit texts live only in React state, only until the user confirms they kept them, and are dropped
 *   on any lock. While the kit is on screen the vault holds its lock for KIT_HOLD_MS at most: past that the auto-lock
 *   takes it away rather than leave the keys readable in an unattended app.
 * - A kit that was shown but not confirmed (dropped by a lock, a closed tab, a crash) stays pending in the
 *   preferences, and the next unlock shows a new one: for a new vault, with a new recovery key that replaces the one
 *   never confirmed. Only confirming the kit ends that.
 * - Every page of the app on this device (tabs, the installed app) has its own Vault over the same database. They
 *   tell each other on a BroadcastChannel: locking from one locks them all, and a vault created or recovered in one
 *   is read again by the others.
 * - The vault modules (and Argon2 with them) load in a chunk of their own, so the first paint never waits on them
 *   beyond the time IndexedDB takes to say whether a vault exists.
 */

/**
 * The keys shown once: after creating a vault, after a recovery that needed a new Secret Key, or again at the unlock
 * that follows a kit never confirmed (`renew`, with a new recovery key).
 */
export interface PendingKit {
  readonly vaultId: string
  readonly secretKey: string | null
  readonly recoveryKey: string | null
  readonly origin: 'create' | 'recover' | 'renew'
}

interface VaultValue {
  readonly vault: Vault
  readonly status: VaultStatus
  readonly kit: PendingKit | null
  /** Why the vault last locked in this page, for the lock screen to say so; null before any lock. */
  readonly lastLock: LockReason | null
  /** A pending kit is being renewed after an unlock: nothing of the app may show yet. */
  readonly renewingKit: boolean
  create(input: CreateVaultInput): Promise<void>
  /** Unlocks, and shows the Emergency Kit again when the last one was never confirmed. */
  unlock(credential: UnlockCredential): Promise<void>
  /** Recovers with the recovery key; the new passphrase replaces the previous ones on this device. */
  recover(input: { readonly recoveryKey: string; readonly next: string }): Promise<void>
  /** Locks this page and every other page of the app on this device, now or once the work that holds the lock ends. */
  lock(): void
  /** The user confirmed the kit is kept. */
  dismissKit(): void
}

const VaultContext = createContext<VaultValue | null>(null)

export function useVault(): VaultValue {
  const value = useContext(VaultContext)
  if (value === null) throw new Error('useVault must be used inside <VaultProvider>')
  return value
}

/** Activity closer together than this restarts the idle timer once: a scroll or a pointer move fires constantly. */
const TOUCH_THROTTLE_MS = 1000

/** Events that count as the user being there. Passive and captured, so no handler can hide them. */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const

/** The longest the Emergency Kit defers the auto-lock and the visibility lock. */
const KIT_HOLD_MS = 10 * 60_000

/** What one page of the app tells the others on this device. */
type Notice =
  /** The user locked: every page locks. */
  | { readonly type: 'lock' }
  /** A vault was created, or its keyslots changed: every page reads `meta` again. */
  | { readonly type: 'changed' }
  /** A pending kit was renewed: a kit still on screen elsewhere holds a recovery key that no longer opens the vault. */
  | { readonly type: 'kit' }

const NOTICES: readonly Notice['type'][] = ['lock', 'changed', 'kit']

/** The channel between the pages of the app; a no-op where BroadcastChannel is missing. */
function noticeChannel(onNotice: (notice: Notice) => void) {
  if (typeof BroadcastChannel === 'undefined') return { post: (_: Notice) => undefined, close: () => undefined }
  const channel = new BroadcastChannel('aparte-vault')
  channel.onmessage = (e: MessageEvent<unknown>) => {
    const type = (e.data as { type?: unknown } | null)?.type
    const known = NOTICES.find((t) => t === type)
    if (known) onNotice({ type: known })
  }
  return {
    post: (notice: Notice) => channel.postMessage(notice),
    close: () => channel.close(),
  }
}

/** The kit still pending for this vault, if any; a `create` one carries the vault's proof (prefs.ts `KitPending`). */
function pendingKit(
  vaultId: string | null,
): { readonly origin: 'create'; readonly proof: string } | { readonly origin: 'recover' } | null {
  const pending = readPref('kitPending')
  if (vaultId === null || pending === '') return null
  const [origin, id, proof] = pending.split(':')
  if (id !== vaultId) return null
  if (origin === 'create' && proof !== undefined) return { origin, proof }
  return origin === 'recover' ? { origin } : null
}

let opening: Promise<Vault> | null = null

/**
 * Opens this device's vault once per page, whatever React mounts twice (StrictMode). A failure is kept so every
 * caller sees it; a reload is the retry.
 */
function deviceVault(): Promise<Vault> {
  opening ??= (async () => {
    const [{ openVault }, { openLocalDb }, { cryptoRng }] = await Promise.all([
      import('../core/vault/vault.ts'),
      import('../core/store/localStore.ts'),
      import('../core/crypto/rng.ts'),
    ])
    const db = await openLocalDb()
    return openVault({
      db,
      rng: cryptoRng(),
      clock: { now: () => Date.now() },
      timers: {
        set: (fn, ms) => setTimeout(fn, ms),
        clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
    })
  })()
  return opening
}

/** A status snapshot that only changes identity when the vault reports a change, as useSyncExternalStore needs. */
function statusStore(vault: Vault) {
  let snapshot = vault.status()
  const listeners = new Set<() => void>()
  const refresh = () => {
    snapshot = vault.status()
    for (const l of listeners) l()
  }
  const unsubscribe = vault.subscribe(refresh)
  return {
    get: () => snapshot,
    refresh,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    dispose: unsubscribe,
  }
}

type Opened = { readonly vault: Vault; readonly store: ReturnType<typeof statusStore> }

export function VaultProvider({ children }: { readonly children: ReactNode }) {
  const [opened, setOpened] = useState<Opened | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    let store: ReturnType<typeof statusStore> | null = null
    deviceVault().then(
      (vault) => {
        if (!live) return
        store = statusStore(vault)
        setOpened({ vault, store })
      },
      () => {
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
      store?.dispose()
    }
  }, [])
  if (failed) return <StorageFailed />
  // Until IndexedDB answers there is nothing that may be shown: the vault may be locked.
  if (opened === null) return null
  return <OpenVault opened={opened}>{children}</OpenVault>
}

function OpenVault({ opened, children }: { readonly opened: Opened; readonly children: ReactNode }) {
  const { vault, store } = opened
  const status = useSyncExternalStore(store.subscribe, store.get, store.get)
  const [kit, setKit] = useState<PendingKit | null>(null)
  const [renewingKit, setRenewingKit] = useState(false)
  const [lastLock, setLastLock] = useState<LockReason | null>(null)
  /** Posts to the other pages; set while the channel is open. */
  const post = useRef<(notice: Notice) => void>(() => {})

  useEffect(
    () =>
      vault.subscribe((e) => {
        if (e.type !== 'locked') return
        setKit(null)
        setLastLock(e.reason)
      }),
    [vault],
  )

  // A secret copied to the clipboard does not outlive the unlocked session.
  useEffect(() => vault.onLock(clearCopiedSecret), [vault])

  useEffect(() => {
    const notices = noticeChannel((notice) => {
      if (notice.type === 'lock') vault.lock().then(store.refresh, store.refresh)
      else if (notice.type === 'changed') vault.refresh().then(store.refresh, store.refresh)
      else setKit((shown) => (shown?.recoveryKey ? null : shown))
    })
    post.current = notices.post
    return () => {
      post.current = () => {}
      notices.close()
    }
  }, [vault, store])

  // The kit holds the lock while it is on screen, for KIT_HOLD_MS at most; a lock that is already pending refuses the
  // hold, and then the kit goes with the lock. A kit that goes unconfirmed stays pending for the next unlock.
  useEffect(() => {
    if (kit === null) return
    let release: (() => void) | null = null
    try {
      release = vault.holdLock('emergency-kit')
    } catch {
      release = null
    }
    store.refresh()
    const cap = setTimeout(() => {
      release?.()
      release = null
      store.refresh()
    }, KIT_HOLD_MS)
    // Leaving the page drops the kit on screen: the browser asks first.
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    addEventListener('beforeunload', warn)
    return () => {
      removeEventListener('beforeunload', warn)
      clearTimeout(cap)
      release?.()
      store.refresh()
    }
  }, [kit, vault, store])

  useAutoLock(vault, status)

  const create = useCallback(
    async (input: CreateVaultInput) => {
      let created: Awaited<ReturnType<Vault['create']>>
      try {
        created = await vault.create(input)
      } catch (error) {
        // Refused because another page created a vault first: this page now shows it locked.
        store.refresh()
        throw error
      }
      writePref('kitPending', created.kitProof === null ? '' : `create:${created.vaultId}:${created.kitProof}`)
      post.current({ type: 'changed' })
      setLastLock(null)
      setKit({ ...created, origin: 'create' })
      store.refresh()
    },
    [vault, store],
  )

  const unlock = useCallback(
    async (credential: UnlockCredential) => {
      const vaultId = vault.status().vaultId
      const pending = pendingKit(vaultId)
      if (pending === null || vaultId === null) {
        await vault.unlock(credential)
        return
      }
      setRenewingKit(true)
      try {
        if (pending.origin === 'create') {
          // The recovery key of the kit nobody confirmed is replaced, in the same step as the unlock; a marker the
          // vault did not make only unlocks.
          const renewed = await vault.unlockAndRenewKit(credential, pending.proof)
          if (renewed === null) {
            writePref('kitPending', '')
            return
          }
          writePref('kitPending', `create:${vaultId}:${renewed.kitProof}`)
          post.current({ type: 'changed' })
          post.current({ type: 'kit' })
          setKit({ vaultId, secretKey: renewed.secretKey, recoveryKey: renewed.recoveryKey, origin: 'renew' })
        } else {
          await vault.unlock(credential)
          const secretKey = await vault.secretKeyText()
          if (secretKey === null) writePref('kitPending', '')
          else setKit({ vaultId, secretKey, recoveryKey: null, origin: 'recover' })
        }
      } finally {
        setRenewingKit(false)
        store.refresh()
      }
    },
    [vault, store],
  )

  const recover = useCallback(
    async (input: { readonly recoveryKey: string; readonly next: string }) => {
      const recovered = await vault.recover({ ...input, replace: true })
      post.current({ type: 'changed' })
      setLastLock(null)
      const vaultId = vault.status().vaultId
      if (recovered.secretKey !== null && vaultId !== null) {
        writePref('kitPending', `recover:${vaultId}`)
        setKit({ vaultId, secretKey: recovered.secretKey, recoveryKey: null, origin: 'recover' })
      } else if (pendingKit(vaultId)?.origin === 'create') {
        // The recovery key of that kit was just used: it is kept, and the Secret Key stays on this device.
        writePref('kitPending', '')
      }
      store.refresh()
    },
    [vault, store],
  )

  const lock = useCallback(() => {
    post.current({ type: 'lock' })
    vault.lock().then(store.refresh, store.refresh)
  }, [vault, store])

  const dismissKit = useCallback(() => {
    writePref('kitPending', '')
    setKit(null)
  }, [])

  const value = useMemo<VaultValue>(
    () => ({ vault, status, kit, renewingKit, lastLock, create, unlock, recover, lock, dismissKit }),
    [vault, status, kit, renewingKit, lastLock, create, unlock, recover, lock, dismissKit],
  )
  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>
}

/**
 * Restarts the vault's idle timer on user activity while it holds keys. Timers of a hidden page are throttled, and a
 * suspended phone app does not run them at all, so a page that becomes visible again after the idle period locks at
 * once rather than waiting for a late timer (holds still defer it, as for any auto-lock).
 */
function useAutoLock(vault: Vault, status: VaultStatus) {
  const open = status.state === 'unlocked' || status.state === 'locking'
  useEffect(() => {
    if (!open) return
    let lastTouch = Date.now()
    const onActivity = () => {
      const now = Date.now()
      if (now - lastTouch < TOUCH_THROTTLE_MS) return
      lastTouch = now
      vault.touch()
    }
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const idle = vault.status().autoLock.idleMs
      if (idle !== null && Date.now() - lastTouch >= idle) vault.lock().catch(() => undefined)
    }
    const options = { capture: true, passive: true }
    for (const type of ACTIVITY_EVENTS) addEventListener(type, onActivity, options)
    document.addEventListener('visibilitychange', onVisible)
    addEventListener('pageshow', onVisible)
    return () => {
      for (const type of ACTIVITY_EVENTS) removeEventListener(type, onActivity, options)
      document.removeEventListener('visibilitychange', onVisible)
      removeEventListener('pageshow', onVisible)
    }
  }, [open, vault])
}

function StorageFailed() {
  const t = useT()
  return (
    <main>
      <div role="alert">
        <EmptyState
          title={t('vault.storageFailedTitle')}
          body={t('vault.storageFailedBody')}
          action={
            <Button variant="primary" onClick={() => location.reload()}>
              {t('common.reload')}
            </Button>
          }
        />
      </div>
    </main>
  )
}

const Unlock = lazyChunk(() => import('../screens/Unlock/index.tsx').then((m) => m.default))
const Recovery = lazyChunk(() => import('../screens/Recovery/index.tsx').then((m) => m.default))
const EmergencyKit = lazyChunk(() => import('../screens/EmergencyKit/index.tsx').then((m) => m.default))

/**
 * Shows the lock screen (or the recovery screen) instead of `children` while the vault is locked or unlocking, and
 * the Emergency Kit instead of `children` until the user confirms it is kept.
 */
export function VaultGate({ children }: { readonly children: ReactNode }) {
  const { status, kit, renewingKit } = useVault()
  const [location] = useLocation()
  let gate: ReactNode = null
  if (status.state === 'locked' || status.state === 'unlocking') {
    gate = location === paths.recover ? <Recovery /> : <Unlock />
  } else if (kit !== null || renewingKit) {
    gate = <EmergencyKit />
  }
  if (gate === null) return children
  return (
    <ScreenBoundary key={location}>
      <Suspense fallback={null}>{gate}</Suspense>
    </ScreenBoundary>
  )
}
