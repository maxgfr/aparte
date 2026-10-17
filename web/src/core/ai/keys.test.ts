/*
 * Device-only provider keys (web/src/core/contracts/ai.ts, ProviderKeysModule) over the real LocalStore and
 * fake-indexeddb. A key is a `provider-key` local record holding the JSON of spec/DATA-MODEL.md section 6; the raw
 * database must never contain it in any encoding.
 */
import { describe, expect, test } from 'bun:test'
import type { ProviderKeysModule } from '../contracts/ai.ts'
import {
  type BytesModule,
  InvalidInputError,
  type KeysModule,
  LockedError,
  type RngModule,
} from '../contracts/crypto.ts'
import type { LocalStoreModule } from '../contracts/store.ts'
import * as bytesImpl from '../crypto/bytes.ts'
import * as keysImpl from '../crypto/keys.ts'
import * as rngImpl from '../crypto/rng.ts'
import * as storeImpl from '../store/localStore.ts'
import * as providerKeysImpl from './keys.ts'

const B: BytesModule = bytesImpl
const K: KeysModule = keysImpl
const R: RngModule = rngImpl
const S: LocalStoreModule = storeImpl
const P: ProviderKeysModule = providerKeysImpl

const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  mk: string
  vaultId: string
}
const subkeys = await K.deriveSubkeys(B.fromHex(inputs.mk), B.fromHex(inputs.vaultId))
const KEY = 'sk-ant-api03-canary-5d1f0b7e-the-key-must-never-reach-indexeddb'

let count = 0
async function fresh() {
  const name = `provider-keys-${++count}-${crypto.randomUUID()}`
  const db = await S.openLocalDb({ name })
  const store = S.createLocalStore({ db, subkeys, rng: R.cryptoRng() })
  return { name, store, keys: P.createProviderKeys(store) }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Every key and value of the database as bytes, read without the store module. */
async function rawBytes(name: string): Promise<Uint8Array[]> {
  const db = await request(indexedDB.open(name))
  const out: Uint8Array[] = []
  for (const storeName of [...db.objectStoreNames]) {
    const os = db.transaction(storeName, 'readonly').objectStore(storeName)
    const keys = await request(os.getAllKeys())
    const values = await request(os.getAll())
    for (const k of keys) out.push(B.utf8(String(k)))
    for (const v of values) {
      if (v instanceof Uint8Array) out.push(v)
      else if (v instanceof ArrayBuffer) out.push(new Uint8Array(v))
      else if (typeof v === 'string') out.push(B.utf8(v))
    }
  }
  db.close()
  return out
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

describe('provider keys', () => {
  test('set, get, list and delete', async () => {
    const { keys } = await fresh()
    expect(await keys.get('p1')).toBeNull()
    await keys.set('p1', KEY)
    await keys.set('p2', 'gsk_other')
    expect(await keys.get('p1')).toBe(KEY)
    expect(await keys.list()).toEqual(['p1', 'p2'])
    await keys.set('p1', 'sk-replaced')
    expect(await keys.get('p1')).toBe('sk-replaced')
    await keys.delete('p1')
    expect(await keys.get('p1')).toBeNull()
    expect(await keys.list()).toEqual(['p2'])
  })

  test('the record is the DATA-MODEL secret JSON under purpose provider-key', async () => {
    const { store, keys } = await fresh()
    await keys.set('p1', KEY)
    const raw = await store.get('provider-key', 'p1')
    expect(raw).not.toBeNull()
    expect(JSON.parse(B.fromUtf8(raw as Uint8Array))).toEqual({ kind: 'api-key', provider: 'p1', key: KEY })
  })

  test('refuses empty keys and keys with whitespace or control characters', async () => {
    const { keys } = await fresh()
    for (const bad of ['', ' sk-x', 'sk-x ', 'sk-\nx', 'sk-\u0000x']) {
      await expect(keys.set('p1', bad)).rejects.toBeInstanceOf(InvalidInputError)
    }
    expect(await keys.list()).toEqual([])
  })

  test('the raw database never holds the key, in any encoding', async () => {
    const { name, keys } = await fresh()
    await keys.set('p1', KEY)
    const encodings = [
      B.utf8(KEY),
      new Uint8Array(new Uint16Array([...KEY].map((c) => c.charCodeAt(0))).buffer),
      B.utf8(B.toHex(B.utf8(KEY))),
      B.utf8(btoa(KEY)),
      B.utf8(B.base64urlEncode(B.utf8(KEY))),
    ]
    for (const bytes of await rawBytes(name)) {
      for (const needle of encodings) expect(contains(bytes, needle)).toBe(false)
    }
  })

  test('a disposed store (locked vault) refuses every call', async () => {
    const { store, keys } = await fresh()
    await keys.set('p1', KEY)
    store.dispose()
    await expect(keys.get('p1')).rejects.toBeInstanceOf(LockedError)
    await expect(keys.set('p1', KEY)).rejects.toBeInstanceOf(LockedError)
  })
})
