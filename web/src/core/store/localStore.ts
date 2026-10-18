/*
 * The device store of spec/FORMAT.md section 11 (contract: web/src/core/contracts/store.ts): the IndexedDB database
 * `aparte-v1`, its plaintext `meta` store, and the encrypted record store of one unlocked vault.
 *
 * Invariants:
 * - `local` and `pending` hold only kind-6 envelopes under HMAC-derived names (section 11.3), and `objects` only
 *   envelopes of kinds 1 to 5 under well-formed remote names: no key or value is readable without the vault's keys.
 * - Every write is a single readwrite transaction, so it lands completely or not at all.
 * - A disposed record store drops its subkeys at once and rejects every later call with LockedError, including a call
 *   that was in flight when it was disposed and has not returned yet.
 */

import { type IDBPDatabase, wrap } from 'idb'
import {
  type Bytes,
  type BytesModule,
  CorruptError,
  type DocId,
  type EnvelopeKind,
  type EnvelopeModule,
  InvalidInputError,
  InvalidStateError,
  LockedError,
  type NamesModule,
  type Rng,
  type Subkeys,
  TamperedError,
} from '../contracts/crypto.ts'
import type {
  LocalDb,
  LocalMeta,
  LocalPurpose,
  LocalStore,
  MetaKeyslot,
  MetaValues,
  ObjectMirror,
  OpenLocalDbOptions,
  PendingQueue,
  PendingUpdate,
} from '../contracts/store.ts'
import * as bytesImpl from '../crypto/bytes.ts'
import * as envelopeImpl from '../crypto/envelope.ts'
import * as namesImpl from '../crypto/names.ts'

const B: BytesModule = bytesImpl
const E: EnvelopeModule = envelopeImpl
const N: NamesModule = namesImpl

export const DB_NAME = 'aparte-v1'
const DB_VERSION = 1
const STORES = ['meta', 'objects', 'local', 'pending'] as const
type StoreName = (typeof STORES)[number]

const KEYSLOT_PREFIX = 'keyslot:'
const SLOT_ID = /^[a-z2-7]{26}$/
const MAX_ID_BYTES = 1024
const SECRET_KEY_BYTES = 44
/** iv (12) || the 32-byte master key || the 16-byte tag (spec/FORMAT.md section 17.1). */
const DEVICE_SLOT_BYTES = 60
const MIN_ENVELOPE = 100

/** The open connection behind each LocalDb handed out by openLocalDb. */
interface Handle {
  readonly idb: IDBPDatabase
  closed: boolean
  /** Tail of the chain that serializes read-modify-write sequences of the pending queue across store instances. */
  queue: Promise<unknown>
}

const handles = new WeakMap<LocalDb, Handle>()

function handleOf(db: LocalDb): Handle {
  const handle = handles.get(db)
  if (!handle) throw new InvalidInputError('Not a database opened by openLocalDb')
  return handle
}

function open(db: LocalDb): IDBPDatabase {
  const handle = handleOf(db)
  if (handle.closed) throw new InvalidStateError('The local database is closed')
  return handle.idb
}

/** Opens (creating at version 1 if needed) the database with its four object stores, all with out-of-line keys. */
export async function openLocalDb(options: OpenLocalDbOptions = {}): Promise<LocalDb> {
  const name = options.name ?? DB_NAME
  const factory = options.indexedDB ?? indexedDB
  const request = factory.open(name, DB_VERSION)
  request.onupgradeneeded = () => {
    const raw = request.result
    for (const store of STORES) if (!raw.objectStoreNames.contains(store)) raw.createObjectStore(store)
  }
  const raw = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new InvalidStateError('The local database is held open by an older version'))
  })
  const handle: Handle = { idb: wrap(raw), closed: false, queue: Promise.resolve() }
  const db: LocalDb = {
    name,
    close() {
      if (handle.closed) return
      handle.closed = true
      raw.close()
    },
  }
  // A newer schema elsewhere (another tab after an update) needs this connection gone; later calls then reject.
  raw.onversionchange = () => db.close()
  handles.set(db, handle)
  return db
}

/** Copies a stored byte value into a fresh ArrayBuffer-backed array; anything else in a byte slot is corrupt. */
function toBytes(value: unknown): Bytes {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  throw new CorruptError('A stored value is not a byte string')
}

async function write(db: LocalDb, stores: StoreName[], fn: (tx: WriteTx) => void): Promise<void> {
  const tx = open(db).transaction(stores, 'readwrite', { durability: 'strict' })
  const requests: Promise<unknown>[] = []
  fn({
    put: (store, key, value) => requests.push(tx.objectStore(store).put(value, key)),
    delete: (store, key) => requests.push(tx.objectStore(store).delete(key)),
    clear: (store) => requests.push(tx.objectStore(store).clear()),
  })
  // A failing request aborts the whole transaction; waiting for every promise keeps no rejection unhandled.
  const results = await Promise.allSettled([...requests, tx.done])
  const failed = results.find((r) => r.status === 'rejected')
  if (failed) throw (failed as PromiseRejectedResult).reason
}

interface WriteTx {
  put(store: StoreName, key: string, value: unknown): void
  delete(store: StoreName, key: string): void
  clear(store: StoreName): void
}

// meta

function checkMetaValue(key: keyof MetaValues, value: unknown): void {
  switch (key) {
    case 'fmt':
    case 'vault':
      if (typeof value !== 'string') throw new InvalidInputError(`meta ${key} must be a string`)
      return
    case 'device-key':
    case 'device-slot-key':
      // Only a key the platform refuses to export may rest in plaintext storage.
      if (!(value instanceof CryptoKey) || value.extractable || value.algorithm.name !== 'AES-GCM') {
        throw new InvalidInputError('A device key must be a non-extractable AES-GCM CryptoKey')
      }
      return
    case 'secret-key':
      if (!(value instanceof Uint8Array) || value.length !== SECRET_KEY_BYTES) {
        throw new InvalidInputError('The wrapped Secret Key must be 44 bytes')
      }
      return
    case 'device-slot':
      if (!(value instanceof Uint8Array) || value.length !== DEVICE_SLOT_BYTES) {
        throw new InvalidInputError('The device slot must be 60 bytes')
      }
      return
    default:
      throw new InvalidInputError('Unknown meta entry')
  }
}

function checkSlotId(slot: string): void {
  if (!SLOT_ID.test(slot)) throw new InvalidInputError('A slot id is 26 base32 characters')
}

/** The rows `entries` and `keyslots` stand for, checked, with byte values copied. */
function metaRows(entries: Partial<MetaValues>, keyslots: readonly MetaKeyslot[]): [string, unknown][] {
  const rows: [string, unknown][] = []
  for (const [key, value] of Object.entries(entries) as [keyof MetaValues, unknown][]) {
    if (value === undefined) continue
    checkMetaValue(key, value)
    rows.push([key, value instanceof Uint8Array ? new Uint8Array(value) : value])
  }
  for (const { slot, bytes } of keyslots) {
    checkSlotId(slot)
    rows.push([KEYSLOT_PREFIX + slot, B.fromUtf8(bytes)])
  }
  return rows
}

/** Whether `keys` (every key of `meta`) name exactly the keyslots `expected`. */
function sameKeyslots(keys: readonly IDBValidKey[], expected: readonly string[]): boolean {
  const held = keys
    .map(String)
    .filter((k) => k.startsWith(KEYSLOT_PREFIX))
    .map((k) => k.slice(KEYSLOT_PREFIX.length))
    .sort()
  const want = [...new Set(expected)].sort()
  return held.length === want.length && held.every((slot, i) => slot === want[i])
}

/** The plaintext `meta` store; keyslot files are kept as their text, as section 11.2 specifies. */
export function createLocalMeta(db: LocalDb): LocalMeta {
  return {
    async get<K extends keyof MetaValues>(key: K): Promise<MetaValues[K] | undefined> {
      const value: unknown = await open(db).get('meta', key)
      if (value === undefined) return undefined
      if (key === 'secret-key' || key === 'device-slot') return toBytes(value) as MetaValues[K]
      return value as MetaValues[K]
    },
    async put<K extends keyof MetaValues>(key: K, value: MetaValues[K]): Promise<void> {
      checkMetaValue(key, value)
      const stored = value instanceof Uint8Array ? new Uint8Array(value) : value
      await write(db, ['meta'], (tx) => tx.put('meta', key, stored))
    },
    async delete(key: keyof MetaValues): Promise<void> {
      await write(db, ['meta'], (tx) => tx.delete('meta', key))
    },
    async keyslots(): Promise<readonly { readonly slot: string; readonly bytes: Bytes }[]> {
      const range = IDBKeyRange.bound(KEYSLOT_PREFIX, `${KEYSLOT_PREFIX}￿`)
      const tx = open(db).transaction('meta', 'readonly')
      const [keys, values] = await Promise.all([tx.store.getAllKeys(range), tx.store.getAll(range), tx.done])
      // getAllKeys and getAll walk the same range in the same key order, so the arrays line up and are sorted by slot.
      return keys.map((key, i) => {
        const text: unknown = values[i]
        if (typeof text !== 'string') throw new CorruptError('A stored keyslot is not text')
        return { slot: String(key).slice(KEYSLOT_PREFIX.length), bytes: B.utf8(text) }
      })
    },
    async putKeyslot(slot: string, bytes: Uint8Array): Promise<void> {
      checkSlotId(slot)
      const text = B.fromUtf8(bytes)
      await write(db, ['meta'], (tx) => tx.put('meta', KEYSLOT_PREFIX + slot, text))
    },
    async deleteKeyslot(slot: string): Promise<void> {
      checkSlotId(slot)
      await write(db, ['meta'], (tx) => tx.delete('meta', KEYSLOT_PREFIX + slot))
    },
    async change({ put = {}, keyslots = [], remove = [], removeKeyslots = [] }): Promise<void> {
      const rows = metaRows(put, keyslots)
      for (const slot of removeKeyslots) checkSlotId(slot)
      await write(db, ['meta'], (tx) => {
        for (const key of remove) tx.delete('meta', key)
        for (const slot of removeKeyslots) tx.delete('meta', KEYSLOT_PREFIX + slot)
        for (const [key, value] of rows) tx.put('meta', key, value)
      })
    },
    async initVault({ entries, keyslots, replace }): Promise<boolean> {
      const rows = metaRows(entries, keyslots)
      // The check and the writes share one readwrite transaction: two pages creating at once cannot both pass it. A
      // replacement takes every store, so the records of the vault it replaces go in the same step.
      const stores: StoreName[] = replace ? [...STORES] : ['meta']
      const tx = open(db).transaction(stores, 'readwrite', { durability: 'strict' })
      const meta = tx.objectStore('meta')
      const existing: unknown = await meta.get('vault')
      const allowed = replace
        ? existing === replace.vault && sameKeyslots(await meta.getAllKeys(), replace.keyslots)
        : existing === undefined
      if (!allowed) {
        tx.abort()
        await tx.done.catch(() => undefined)
        return false
      }
      const requests: Promise<unknown>[] = stores.map((name) => tx.objectStore(name).clear())
      for (const [key, value] of rows) requests.push(meta.put(value, key))
      const results = await Promise.allSettled([...requests, tx.done])
      const failed = results.find((r) => r.status === 'rejected')
      if (failed) throw (failed as PromiseRejectedResult).reason
      return true
    },
    async clear(): Promise<void> {
      await write(db, ['meta'], (tx) => tx.clear('meta'))
    },
  }
}

// Local record payloads (spec/FORMAT.md section 9.6)

/** payload = u8(len(purpose)) || purpose || u16be(len(id)) || id || value. */
function frameRecord(purpose: string, id: string, value: Uint8Array): Bytes {
  const p = B.utf8(purpose)
  const i = B.utf8(id)
  if (i.length > MAX_ID_BYTES) throw new InvalidInputError('A local record id is at most 1024 bytes')
  return B.concat(new Uint8Array([p.length]), p, new Uint8Array([i.length >> 8, i.length & 0xff]), i, value)
}

interface LocalRecord {
  readonly purpose: string
  readonly id: string
  readonly value: Bytes
}

const PURPOSE = /^[a-z][a-z0-9-]{0,31}$/

/** Strict UTF-8 of an authenticated payload: text that does not decode is malformed framing, so `corrupt`. */
function framedText(bytes: Uint8Array): string {
  try {
    return B.fromUtf8(bytes)
  } catch (cause) {
    throw new CorruptError('A local record purpose or id is not UTF-8', { cause })
  }
}

/** Every malformed framing is `corrupt` (sections 9.6 and 12), as Rust decode_local_record reports it. */
function unframeRecord(payload: Uint8Array): LocalRecord {
  const pLen = payload[0]
  if (pLen === undefined || payload.length < 1 + pLen + 2) throw new CorruptError('Truncated local record')
  const purpose = framedText(payload.subarray(1, 1 + pLen))
  const iLen = ((payload[1 + pLen] as number) << 8) | (payload[2 + pLen] as number)
  const idStart = 3 + pLen
  if (payload.length < idStart + iLen) throw new CorruptError('Truncated local record')
  const id = framedText(payload.subarray(idStart, idStart + iLen))
  if (!PURPOSE.test(purpose)) throw new CorruptError('A local record purpose is not [a-z][a-z0-9-]{0,31}')
  if (iLen > MAX_ID_BYTES) throw new CorruptError('A local record id is above 1024 bytes')
  return { purpose, id, value: new Uint8Array(payload.subarray(idStart + iLen)) }
}

// Object names (spec/FORMAT.md section 8.8)

const KIND_OF_NAME: { readonly [type: string]: EnvelopeKind } = {
  segment: 1,
  checkpoint: 2,
  chunk: 3,
  manifest: 4,
  secret: 5,
}

/** The envelope kind a remote object name implies; InvalidInputError for anything that does not hold an envelope. */
function objectKind(name: string): EnvelopeKind {
  const parsed = N.parseName(name)
  const kind = parsed ? KIND_OF_NAME[parsed.type] : undefined
  if (kind === undefined) throw new InvalidInputError('Not the name of a remote envelope')
  return kind
}

/** Structural check of a mirrored object without decrypting it: at least 100 bytes, an APT1 header, the named kind. */
function checkObject(name: string, envelope: Uint8Array): void {
  const kind = objectKind(name)
  if (envelope.length < MIN_ENVELOPE) throw new InvalidInputError('Not an aparte/1 envelope')
  let header: ReturnType<EnvelopeModule['parseEnvelopeHeader']>
  try {
    header = E.parseEnvelopeHeader(envelope)
  } catch (cause) {
    throw new InvalidInputError('Not an aparte/1 envelope', { cause })
  }
  if (header.kind !== kind) throw new InvalidInputError('The envelope kind does not match its name')
}

// Record store

const PENDING_ID = /^(index|c(?:0\d|1[0-5]))\|([1-9]\d{0,15})$/
const DOC_ID = /^(index|c(?:0\d|1[0-5]))$/

function checkDocId(docId: DocId): void {
  if (!DOC_ID.test(docId)) throw new InvalidInputError('Unknown document id')
}

export function createLocalStore(input: {
  readonly db: LocalDb
  readonly subkeys: Subkeys
  readonly rng: Rng
}): LocalStore {
  const { db, rng } = input
  const handle = handleOf(db)
  let subkeys: Subkeys | null = input.subkeys

  /** The subkeys while the store is live; LockedError once disposed. */
  const keys = (): Subkeys => {
    if (!subkeys) throw new LockedError()
    return subkeys
  }

  /** Runs `fn` with the keys and refuses to hand out its result if the store was disposed meanwhile. */
  const live = async <T>(fn: (k: Subkeys) => Promise<T>): Promise<T> => {
    const result = await fn(keys())
    keys()
    return result
  }

  /** Serializes `fn` after every earlier queued sequence on the same database. */
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = handle.queue.then(fn, fn)
    handle.queue = run.catch(() => undefined)
    return run
  }

  const seal = async (k: Subkeys, purpose: string, id: string, value: Uint8Array) => {
    const name = await N.localName(k, purpose, id)
    const bytes = await E.sealEnvelope(k, { kind: 6, name, payload: frameRecord(purpose, id, value) }, rng)
    return { name, bytes }
  }

  /** Opens a kind-6 envelope and checks that its framed purpose and id name it (section 9.6). */
  const unseal = async (k: Subkeys, name: string, stored: unknown): Promise<LocalRecord> => {
    const payload = await E.openEnvelope(k, { kind: 6, name, bytes: toBytes(stored) })
    let record: LocalRecord
    try {
      record = unframeRecord(payload)
    } finally {
      payload.fill(0)
    }
    let expected: string
    try {
      expected = await N.localName(k, record.purpose, record.id)
    } catch (cause) {
      if (cause instanceof InvalidInputError) throw new CorruptError('A local record does not frame a name', { cause })
      throw cause
    }
    // A recomputed name is secret-derived: compared in constant time (section 2).
    if (!B.equal(B.utf8(expected), B.utf8(name))) throw new CorruptError('A local record does not match its name')
    return record
  }

  /**
   * Every record of a store that opens under these keys. A record that does not authenticate belongs to another
   * vault (or was damaged) and is skipped: listing has no plaintext index to tell them apart.
   */
  const scan = async (k: Subkeys, store: 'local' | 'pending'): Promise<(LocalRecord & { readonly name: string })[]> => {
    const tx = open(db).transaction(store, 'readonly')
    const [names, values] = await Promise.all([tx.store.getAllKeys(), tx.store.getAll(), tx.done])
    const out: (LocalRecord & { readonly name: string })[] = []
    for (const [i, key] of names.entries()) {
      const name = String(key)
      try {
        out.push({ name, ...(await unseal(k, name, values[i])) })
      } catch (error) {
        if (!(error instanceof TamperedError)) throw error
      }
    }
    return out
  }

  const pendingOf = async (k: Subkeys, docId: DocId) => {
    const out: { readonly name: string; readonly n: number; readonly update: Bytes }[] = []
    for (const record of await scan(k, 'pending')) {
      const match = record.purpose === 'pending' ? PENDING_ID.exec(record.id) : null
      if (!match) throw new CorruptError('A pending record has a malformed id')
      if (match[1] === docId) out.push({ name: record.name, n: Number(match[2]), update: record.value })
    }
    return out.sort((a, b) => a.n - b.n)
  }

  const objects: ObjectMirror = {
    put: (name, envelope) =>
      live(async () => {
        checkObject(name, envelope)
        const copy = new Uint8Array(envelope)
        await write(db, ['objects'], (tx) => tx.put('objects', name, copy))
      }),
    get: (name) =>
      live(async () => {
        const value: unknown = await open(db).get('objects', name)
        return value === undefined ? null : toBytes(value)
      }),
    delete: (name) => live(() => write(db, ['objects'], (tx) => tx.delete('objects', name))),
    names: (prefix) =>
      live(async () => {
        const range = prefix ? IDBKeyRange.bound(prefix, `${prefix}￿`) : undefined
        const keys = await open(db).getAllKeys('objects', range)
        return keys.map(String).filter((name) => prefix === undefined || name.startsWith(prefix))
      }),
  }

  const pending: PendingQueue = {
    append: (docId, update) =>
      live((k) => {
        checkDocId(docId)
        return serialized(async () => {
          const queue = await pendingOf(k, docId)
          const n = (queue.at(-1)?.n ?? 0) + 1
          const { name, bytes } = await seal(k, 'pending', `${docId}|${n}`, update)
          keys()
          await write(db, ['pending'], (tx) => tx.put('pending', name, bytes))
          return n
        })
      }),
    list: (docId) =>
      live(async (k) => {
        checkDocId(docId)
        const queue = await pendingOf(k, docId)
        return queue.map(({ n, update }): PendingUpdate => ({ n, update }))
      }),
    drop: (docId, throughN) =>
      live((k) => {
        checkDocId(docId)
        if (!Number.isSafeInteger(throughN) || throughN < 0) throw new InvalidInputError('Bad queue position')
        return serialized(async () => {
          const doomed = (await pendingOf(k, docId)).filter((u) => u.n <= throughN)
          keys()
          if (doomed.length === 0) return
          await write(db, ['pending'], (tx) => {
            for (const u of doomed) tx.delete('pending', u.name)
          })
        })
      }),
  }

  return {
    put: (purpose: LocalPurpose, id: string, value: Uint8Array) =>
      live(async (k) => {
        const { name, bytes } = await seal(k, purpose, id, value)
        keys()
        await write(db, ['local'], (tx) => tx.put('local', name, bytes))
      }),
    get: (purpose, id) =>
      live(async (k) => {
        const name = await N.localName(k, purpose, id)
        const stored: unknown = await open(db).get('local', name)
        if (stored === undefined) return null
        const record = await unseal(k, name, stored)
        if (record.purpose !== purpose || record.id !== id) throw new CorruptError('A local record does not match')
        return record.value
      }),
    delete: (purpose, id) =>
      live(async (k) => {
        const name = await N.localName(k, purpose, id)
        await write(db, ['local'], (tx) => tx.delete('local', name))
      }),
    list: (purpose) =>
      live(async (k) => {
        // Validates the purpose the same way a write would, so a typo is an error rather than an empty list.
        await N.localName(k, purpose, '')
        const ids = (await scan(k, 'local')).filter((r) => r.purpose === purpose).map((r) => r.id)
        return ids.sort()
      }),
    objects,
    pending,
    dispose() {
      subkeys = null
    },
  }
}
