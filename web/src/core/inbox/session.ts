/*
 * The unlocked page's side of the share inbox: it makes sure this device has an inbox key for the open vault (so the
 * service worker can seal shares while the vault is locked), and opens what the worker stored. An item that does not
 * open (sealed to a key of another vault, or to a key a page of the shared origin planted) is deleted and counted as
 * lost: it was never readable here.
 */
import type { Rng, Subkeys } from '../contracts/crypto.ts'
import type { InboxKeyPair, InboxStore, SharedContent } from '../contracts/inbox.ts'
import { localKey } from '../crypto/keys.ts'
import { createInboxKey, decodeShare, INBOX_WRAP_NAME, openItem, parseInboxKey, unwrapInboxKey } from './inbox.ts'

/** A share that opened, under its item id. */
export interface OpenedShare {
  readonly id: string
  readonly content: SharedContent
}

export interface InboxSession {
  /** Opens every waiting item; those that do not open are deleted and counted in `lost`. */
  read(): Promise<{ readonly shares: readonly OpenedShare[]; readonly lost: number }>
  /** Deletes an item once the user took it into a chat or discarded it. */
  remove(id: string): Promise<void>
  /** Drops the private key reference (on lock). */
  dispose(): void
}

/**
 * The inbox key of this vault: the stored one when it unwraps and matches, else a new one written in its place (a
 * new vault on this device, a file a sibling page rewrote, the first unlock after an update).
 */
export async function ensureInboxKey(store: InboxStore, subkeys: Subkeys, rng: Rng): Promise<InboxKeyPair> {
  const wrapKey = await localKey(subkeys, INBOX_WRAP_NAME)
  const stored = await store.keyFile()
  if (stored !== null) {
    try {
      return await unwrapInboxKey(parseInboxKey(stored), { vaultId: subkeys.vaultId, wrapKey })
    } catch {
      // Replaced below: whatever was sealed to the old key can no longer be read here.
    }
  }
  const created = await createInboxKey({ vaultId: subkeys.vaultId, wrapKey, rng })
  await store.putKeyFile(created.file)
  return created.pair
}

export async function openInboxSession(input: {
  readonly store: InboxStore
  readonly subkeys: Subkeys
  readonly rng: Rng
}): Promise<InboxSession> {
  const { store } = input
  let pair: InboxKeyPair | null = await ensureInboxKey(store, input.subkeys, input.rng)
  return {
    async read() {
      const key = pair
      if (key === null) throw new Error('The inbox session is closed')
      const shares: OpenedShare[] = []
      let lost = 0
      for (const item of await store.items()) {
        try {
          shares.push({ id: item.id, content: decodeShare(await openItem(key, item.bytes)) })
        } catch {
          lost++
          await store.deleteItem(item.id)
        }
      }
      return { shares, lost }
    },
    remove: (id) => store.deleteItem(id),
    dispose() {
      pair = null
    },
  }
}
