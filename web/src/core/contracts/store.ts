/*
 * Contracts of the device store (spec/FORMAT.md section 11): IndexedDB database `aparte-v1` with the stores `meta`,
 * `objects`, `local` and `pending`. Implemented by web/src/core/store/localStore.ts.
 *
 * Invariants:
 * - Nothing readable is stored. `meta` holds only the format marker, the vault id, keyslot files, the device key (a
 *   non-extractable CryptoKey) and the wrapped Secret Key. `objects` holds envelopes exactly as on the remote.
 *   `local` and `pending` hold kind-6 envelopes under HMAC-derived names; no key or value carries a purpose, an id, a
 *   ULID or a timestamp in clear.
 * - A LocalStore is bound to the subkeys of one unlocked vault. Once disposed (the vault locked), every call rejects
 *   with LockedError and the store holds no reference to a key.
 * - Every write is one IndexedDB transaction: it lands completely or not at all.
 */

import type { Bytes, DocId, Rng, Subkeys } from './crypto.ts'

/** Device-only record purposes of aparte/1 (spec/FORMAT.md section 11.3); `pending` is reserved for the queue. */
export type LocalPurpose = 'device' | 'sync-credential' | 'oauth-token' | 'provider-key' | 'hwm' | 'draft'

/** An open handle on the database; obtained from `openLocalDb`, shared by the meta store and the record store. */
export interface LocalDb {
  readonly name: string
  /** Closes the connection; later calls through any store built on it reject. */
  close(): void
}

/** Plaintext `meta` entries other than keyslots, by key. */
export interface MetaValues {
  /** `aparte/1\n`. */
  readonly fmt: string
  /** base32 vaultId. */
  readonly vault: string
  /** Non-extractable AES-256-GCM key generated on this device; wraps the Secret Key. */
  readonly 'device-key': CryptoKey
  /** iv (12) || AES-GCM(device-key, iv, SK, "aparte/1|device-secret-key|" || vault): 44 bytes. */
  readonly 'secret-key': Bytes
}

/** The plaintext `meta` store. Usable while locked: it is what unlocking reads. */
export interface LocalMeta {
  get<K extends keyof MetaValues>(key: K): Promise<MetaValues[K] | undefined>
  put<K extends keyof MetaValues>(key: K, value: MetaValues[K]): Promise<void>
  delete(key: keyof MetaValues): Promise<void>
  /** Keyslot files by base32 slotId (`meta` key `keyslot:<slot>`), sorted by slot. */
  keyslots(): Promise<readonly { readonly slot: string; readonly bytes: Bytes }[]>
  putKeyslot(slot: string, bytes: Uint8Array): Promise<void>
  deleteKeyslot(slot: string): Promise<void>
  /**
   * Makes a vault exist, in one transaction: unless `vault` is already set, removes every entry (the leftovers of an
   * interrupted creation) and writes `entries` and `keyslots`. Returns false, having written nothing, when `vault` is
   * already set: another page of this device created a vault first.
   */
  initVault(input: {
    readonly entries: Pick<MetaValues, 'fmt' | 'vault'> & Partial<Pick<MetaValues, 'device-key' | 'secret-key'>>
    readonly keyslots: readonly { readonly slot: string; readonly bytes: Uint8Array }[]
  }): Promise<boolean>
  /** Removes every entry, for a device that leaves the vault. */
  clear(): Promise<void>
}

/** Local mirror of remote objects: name -> envelope bytes, stored as they are (already ciphertext). */
export interface ObjectMirror {
  /** InvalidInputError, and nothing stored, unless `envelope` is at least 100 bytes with an APT1 header of kind 1 to 5. */
  put(name: string, envelope: Uint8Array): Promise<void>
  get(name: string): Promise<Bytes | null>
  delete(name: string): Promise<void>
  /** Names starting with `prefix` (all when omitted), sorted. */
  names(prefix?: string): Promise<string[]>
}

export interface PendingUpdate {
  /** Position in the document's queue, from 1, increasing. */
  readonly n: number
  readonly update: Bytes
}

/** Local Yjs updates not yet sealed into a segment, per document, each stored as a local record of purpose `pending`. */
export interface PendingQueue {
  /** Appends and returns the update's position. */
  append(docId: DocId, update: Uint8Array): Promise<number>
  /** The document's pending updates in order. */
  list(docId: DocId): Promise<PendingUpdate[]>
  /** Removes the document's updates up to and including position `throughN` (once sealed into a segment). */
  drop(docId: DocId, throughN: number): Promise<void>
}

/** The encrypted record store of one unlocked vault. */
export interface LocalStore {
  /** Seals `value` as a kind-6 envelope under the record's local name, replacing any previous value. */
  put(purpose: LocalPurpose, id: string, value: Uint8Array): Promise<void>
  /** The record's value, or null when absent; TamperedError when the stored envelope does not authenticate. */
  get(purpose: LocalPurpose, id: string): Promise<Bytes | null>
  delete(purpose: LocalPurpose, id: string): Promise<void>
  /** Ids of the records of one purpose, sorted (decrypts the store: there is no plaintext index). */
  list(purpose: LocalPurpose): Promise<string[]>
  readonly objects: ObjectMirror
  readonly pending: PendingQueue
  /** Drops the key references; every later call rejects with LockedError. Idempotent. */
  dispose(): void
}

export interface OpenLocalDbOptions {
  /** Defaults to `aparte-v1`; tests pass a fresh name per case. */
  readonly name?: string
  /** Defaults to the global indexedDB. */
  readonly indexedDB?: IDBFactory
}

export interface LocalStoreModule {
  readonly DB_NAME: 'aparte-v1'
  /** Opens (creating at version 1 if needed) the database with its four object stores. */
  openLocalDb(options?: OpenLocalDbOptions): Promise<LocalDb>
  createLocalMeta(db: LocalDb): LocalMeta
  createLocalStore(input: { readonly db: LocalDb; readonly subkeys: Subkeys; readonly rng: Rng }): LocalStore
}
