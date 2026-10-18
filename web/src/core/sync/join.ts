/*
 * Joining a vault from its sync store (spec/FORMAT.md section 10.4): a new device reads the format marker and the
 * keyslots, the only plaintext a store holds, and hands them to Vault.join. It then unlocks with the passphrase and the
 * Secret Key of the Emergency Kit, and its first round downloads everything else, trusting what it lists first.
 */

import { RemoteError, type RemoteStore } from '../contracts/sync.ts'
import type { KeyslotFile } from '../contracts/vault.ts'
import { equal, fromUtf8 } from '../crypto/bytes.ts'
import { FMT_BYTES, FMT_NAME } from './engine.ts'

const KEYSLOT = /^keys\/[a-z2-7]{26}\.json$/

export interface StoredVault {
  /** base32 vaultId. */
  readonly vault: string
  readonly keyslots: readonly KeyslotFile[]
}

/**
 * The vault a store holds. RemoteError `not-found` for a store with no vault yet, `incompatible` for another format
 * or for keyslots of more than one vault (the store is shared with something else: never guess which).
 */
export async function readStoredVault(store: RemoteStore): Promise<StoredVault> {
  const entries = await store.list('')
  const marker = entries.find((e) => e.name === FMT_NAME)
  if (!marker) {
    if (entries.length === 0) throw new RemoteError('not-found', 'This destination holds no vault yet')
    throw new RemoteError('incompatible', 'This destination holds something other than an aparte/1 vault')
  }
  const bytes = await store.get(marker)
  if (bytes === null || !equal(bytes, FMT_BYTES)) {
    throw new RemoteError('incompatible', 'This destination holds another format than aparte/1')
  }
  const keyslots: KeyslotFile[] = []
  const vaults = new Set<string>()
  for (const entry of entries) {
    if (!KEYSLOT.test(entry.name)) continue
    const file = await store.get(entry)
    if (file === null) continue
    try {
      const vault = (JSON.parse(fromUtf8(file)) as { vault?: unknown }).vault
      if (typeof vault !== 'string') continue
      vaults.add(vault)
    } catch {
      continue
    }
    keyslots.push({ name: entry.name, bytes: file })
  }
  if (vaults.size === 0) throw new RemoteError('not-found', 'This destination holds no keyslot')
  if (vaults.size > 1) throw new RemoteError('incompatible', 'This destination holds keyslots of several vaults')
  const [vault] = vaults
  return { vault: vault as string, keyslots }
}
