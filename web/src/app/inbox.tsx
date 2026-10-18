import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'wouter'
import type { SharedContent } from '../core/contracts/inbox.ts'
import type { InboxSession, OpenedShare } from '../core/inbox/session.ts'
import { useT } from '../i18n/react.tsx'
import { useSessionState } from './chat.tsx'
import { paths } from './routes.ts'
import { useToast } from './toast.tsx'
import { useVault } from './vault.tsx'

/*
 * The share inbox of an unlocked vault, for the interface (spec/FORMAT.md section 16). Once the vault is unlocked, this
 * device's inbox key is made sure of (so the service worker can seal shares while the vault is locked), and what the
 * worker sealed is opened, in memory only, for the share screen to offer. A share arriving while the app is open is
 * announced; nothing is acted on until the user starts a chat with it or discards it.
 *
 * Invariants:
 * - Opened shares live in React state only, and go on lock with the inbox key; the stored items stay sealed.
 * - An item is deleted once the user took it into a chat (its content then waits in memory as the new chat's draft)
 *   or discarded it.
 */

/** What a new chat starts with when the user takes a share into it: text for the field, photos to attach. */
export interface SharedDraft {
  readonly text: string
  readonly files: readonly File[]
}

let pendingDraft: SharedDraft | null = null

/** The shared draft waiting for the next new chat, handed over once (src/ui/chat/Composer.tsx). */
export function takeSharedDraft(): SharedDraft | null {
  const draft = pendingDraft
  pendingDraft = null
  return draft
}

/** The text a share puts in the message field: its title, text and address, as the sharing app gave them. */
export function draftText(content: SharedContent): string {
  const { title, text, url } = content.header
  const parts = [title, text, url !== undefined && text?.includes(url) !== true ? url : undefined]
  return parts.filter((p): p is string => p !== undefined && p !== '').join('\n\n')
}

interface InboxValue {
  readonly status: 'closed' | 'loading' | 'ready' | 'failed'
  readonly shares: readonly OpenedShare[]
  /** Items removed because they did not open, at the last read. */
  readonly lost: number
  /** Takes a share into the next new chat and deletes it from the inbox. */
  take(id: string): Promise<void>
  discard(id: string): Promise<void>
}

const InboxContext = createContext<InboxValue>({
  status: 'closed',
  shares: [],
  lost: 0,
  take: async () => undefined,
  discard: async () => undefined,
})

export function useInbox(): InboxValue {
  return useContext(InboxContext)
}

/** The channel the service worker announces shares on (src/sw.ts). */
const CHANNEL = 'aparte-inbox'

export function InboxProvider({ children }: { readonly children: ReactNode }) {
  const t = useT()
  const toast = useToast()
  const [location, navigate] = useLocation()
  const { vault } = useVault()
  const open = useSessionState().status === 'open'
  const [status, setStatus] = useState<InboxValue['status']>('closed')
  const [shares, setShares] = useState<readonly OpenedShare[]>([])
  const [lost, setLost] = useState(0)
  const session = useRef<InboxSession | null>(null)
  const here = useRef(location)
  here.current = location
  // The announcement reads these through a ref: the inbox must not reopen when the toast or the route changes.
  const announce = useRef(() => {})
  announce.current = () =>
    toast(t('media.shareArrived'), [{ label: t('media.shareReview'), onClick: () => navigate(paths.share) }])

  useEffect(() => {
    if (!open) {
      setStatus('closed')
      setShares([])
      setLost(0)
      return
    }
    let live = true
    let close: (() => void) | null = null
    setStatus('loading')
    const read = async () => {
      const s = session.current
      if (s === null || !live) return
      const result = await s.read()
      if (!live) return
      setShares(result.shares)
      setLost(result.lost)
      setStatus('ready')
    }
    const unregister = vault.onLock(() => {
      live = false
      session.current?.dispose()
      session.current = null
      close?.()
      setShares([])
    })
    ;(async () => {
      const [{ openInboxStore }, { openInboxSession }, { cryptoRng }] = await Promise.all([
        import('../core/inbox/store.ts'),
        import('../core/inbox/session.ts'),
        import('../core/crypto/rng.ts'),
      ])
      const store = await openInboxStore()
      if (store === null) throw new Error('The inbox database did not open')
      close = () => store.close()
      if (!live) {
        store.close()
        return
      }
      session.current = await openInboxSession({ store, subkeys: vault.subkeys(), rng: cryptoRng() })
      await read()
    })().catch(() => {
      if (live) setStatus('failed')
    })
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL)
    if (channel !== null) {
      channel.onmessage = (event: MessageEvent<unknown>) => {
        if ((event.data as { type?: unknown } | null)?.type !== 'share') return
        void read().catch(() => undefined)
        if (!here.current.startsWith(paths.share)) announce.current()
      }
    }
    return () => {
      live = false
      channel?.close()
      unregister()
      session.current?.dispose()
      session.current = null
      close?.()
    }
  }, [open, vault])

  const take = useCallback(
    async (id: string) => {
      const share = shares.find((s) => s.id === id)
      if (share === undefined) return
      const { sharedFile } = await import('../ui/chat/attach.ts')
      const files = share.content.header.files
        .map((info, i) => ({ info, bytes: share.content.files[i] }))
        .filter((f) => f.info.type.startsWith('image/') && f.bytes !== undefined)
        .map((f) => sharedFile(f.bytes as Uint8Array, f.info.name, f.info.type))
      pendingDraft = { text: draftText(share.content), files }
      await session.current?.remove(id)
      setShares((list) => list.filter((s) => s.id !== id))
    },
    [shares],
  )

  const discard = useCallback(async (id: string) => {
    await session.current?.remove(id)
    setShares((list) => list.filter((s) => s.id !== id))
  }, [])

  const value = useMemo<InboxValue>(
    () => ({ status, shares, lost, take, discard }),
    [status, shares, lost, take, discard],
  )
  return <InboxContext.Provider value={value}>{children}</InboxContext.Provider>
}
