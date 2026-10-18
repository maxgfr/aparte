/*
 * The inbox database (spec/FORMAT.md section 16.6, contract: web/src/core/contracts/inbox.ts): IndexedDB `aparte-inbox-v1`
 * at version 1, store `key` (the inbox key file under the key `inbox-key`, as text) and store `items` (sealed items
 * under their base32 id). Nothing in it is readable without the vault: the key file holds a public key and a wrapped
 * private key, the items are sealed to that public key. Its own database, so the frozen schema of `aparte-v1` stays as
 * it is. Opened by the service worker (which never creates it) and by the unlocked page.
 */
import { CorruptError, InvalidInputError, InvalidStateError } from '../contracts/crypto.ts'
import type { InboxStore, StoredItem } from '../contracts/inbox.ts'
import { fromUtf8, utf8 } from '../crypto/bytes.ts'
import { ITEM_HEADER_BYTES, MAX_ITEM_PAYLOAD, MAX_ITEMS } from './inbox.ts'

export const INBOX_DB_NAME = 'aparte-inbox-v1'
const VERSION = 1
const KEY_STORE = 'key'
const ITEM_STORE = 'items'
const KEY_NAME = 'inbox-key'
const ITEM_ID = /^[a-z2-7]{25}[aeimquy4]$/
/** Header, padded plaintext of the largest payload, tag: what an item can weigh at most. */
const MAX_ITEM_BYTES = ITEM_HEADER_BYTES + MAX_ITEM_PAYLOAD + 4 + MAX_ITEM_PAYLOAD / 8 + 16

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function settled(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new InvalidStateError('The inbox transaction was aborted'))
  })
}

function toBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  throw new CorruptError('A stored inbox item is not a byte string')
}

export async function openInboxStore(
  options: { readonly name?: string; readonly indexedDB?: IDBFactory; readonly create?: boolean } = {},
): Promise<InboxStore | null> {
  const factory = options.indexedDB ?? indexedDB
  const create = options.create ?? true
  const request = factory.open(options.name ?? INBOX_DB_NAME, VERSION)
  let refused = false
  request.onupgradeneeded = (event) => {
    if (!create && event.oldVersion === 0) {
      // The service worker never creates the database: without it there is no inbox key to seal to.
      refused = true
      request.transaction?.abort()
      return
    }
    const db = request.result
    if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE)
    if (!db.objectStoreNames.contains(ITEM_STORE)) db.createObjectStore(ITEM_STORE)
  }
  let db: IDBDatabase
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
      request.onblocked = () => reject(new InvalidStateError('The inbox database is held open by an older version'))
    })
  } catch (error) {
    if (refused) return null
    throw error
  }
  db.onversionchange = () => db.close()
  let closed = false
  const live = (): IDBDatabase => {
    if (closed) throw new InvalidStateError('The inbox database is closed')
    return db
  }

  return {
    async keyFile() {
      const value: unknown = await done(live().transaction(KEY_STORE, 'readonly').objectStore(KEY_STORE).get(KEY_NAME))
      if (value === undefined) return null
      if (typeof value !== 'string') throw new CorruptError('The stored inbox key is not text')
      return utf8(value)
    },
    async putKeyFile(bytes) {
      const tx = live().transaction(KEY_STORE, 'readwrite', { durability: 'strict' })
      tx.objectStore(KEY_STORE).put(fromUtf8(bytes), KEY_NAME)
      await settled(tx)
    },
    async addItem(item: StoredItem) {
      if (!ITEM_ID.test(item.id)) throw new InvalidInputError('An inbox item id is 26 base32 characters')
      if (item.bytes.length < ITEM_HEADER_BYTES || item.bytes.length > MAX_ITEM_BYTES) {
        throw new InvalidInputError('An inbox item has an impossible size')
      }
      // The count and the write share one transaction, so two shares at once cannot both pass the cap.
      const tx = live().transaction(ITEM_STORE, 'readwrite', { durability: 'strict' })
      const store = tx.objectStore(ITEM_STORE)
      const full = (await done(store.count())) >= MAX_ITEMS
      if (full) tx.abort()
      else store.put(new Uint8Array(item.bytes), item.id)
      try {
        await settled(tx)
      } catch (error) {
        if (full) throw new InvalidStateError(`The inbox holds ${MAX_ITEMS} items already`)
        throw error
      }
    },
    async items() {
      const store = live().transaction(ITEM_STORE, 'readonly').objectStore(ITEM_STORE)
      const [keys, values] = await Promise.all([done(store.getAllKeys()), done(store.getAll())])
      // getAllKeys and getAll walk the store in the same key order, so the arrays line up.
      return keys.map((key, i) => ({ id: String(key), bytes: toBytes(values[i]) }))
    },
    async deleteItem(id) {
      const tx = live().transaction(ITEM_STORE, 'readwrite', { durability: 'strict' })
      tx.objectStore(ITEM_STORE).delete(id)
      await settled(tx)
    },
    count() {
      return done(live().transaction(ITEM_STORE, 'readonly').objectStore(ITEM_STORE).count())
    },
    close() {
      if (closed) return
      closed = true
      db.close()
    },
  }
}
