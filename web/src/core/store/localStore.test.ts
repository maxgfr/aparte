/*
 * The device store of spec/FORMAT.md section 11 over fake-indexeddb. The canary test reads the raw database, every
 * store, key and value, and requires that a string written through the store appears nowhere: not as UTF-8, not as
 * UTF-16, not as hex, not as base64.
 */
import { describe, expect, test } from 'bun:test'
import {
  type BytesModule,
  type EnvelopeModule,
  InvalidInputError,
  type KeysModule,
  LockedError,
  type NamesModule,
  type RngModule,
  type Subkeys,
  TamperedError,
} from '../contracts/crypto.ts'
import type { LocalDb, LocalStore, LocalStoreModule } from '../contracts/store.ts'
import * as bytesImpl from '../crypto/bytes.ts'
import * as envelopeImpl from '../crypto/envelope.ts'
import * as keysImpl from '../crypto/keys.ts'
import * as namesImpl from '../crypto/names.ts'
import * as rngImpl from '../crypto/rng.ts'
import * as storeImpl from './localStore.ts'

const B: BytesModule = bytesImpl
const E: EnvelopeModule = envelopeImpl
const K: KeysModule = keysImpl
const N: NamesModule = namesImpl
const R: RngModule = rngImpl
const S: LocalStoreModule = storeImpl

const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  mk: string
  vaultId: string
  otherVaultId: string
}
const subkeys = await K.deriveSubkeys(B.fromHex(inputs.mk), B.fromHex(inputs.vaultId))
const CANARY = 'canary-7f3a9c-the-plaintext-must-never-reach-indexeddb'

let count = 0
async function fresh(keys: Subkeys = subkeys): Promise<{ name: string; db: LocalDb; store: LocalStore }> {
  const name = `store-test-${++count}-${crypto.randomUUID()}`
  const db = await S.openLocalDb({ name })
  return { name, db, store: S.createLocalStore({ db, subkeys: keys, rng: R.cryptoRng() }) }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** Every key and value of every store of the database, read without the store module. */
async function dump(name: string): Promise<{ store: string; key: IDBValidKey; value: unknown }[]> {
  const db = await request(indexedDB.open(name))
  const rows: { store: string; key: IDBValidKey; value: unknown }[] = []
  for (const store of [...db.objectStoreNames]) {
    const os = db.transaction(store, 'readonly').objectStore(store)
    const keys = await request(os.getAllKeys())
    const values = await request(os.getAll())
    keys.forEach((key, i) => {
      rows.push({ store, key, value: values[i] })
    })
  }
  db.close()
  return rows
}

async function rawPut(name: string, store: string, key: string, value: unknown): Promise<void> {
  const db = await request(indexedDB.open(name))
  const tx = db.transaction(store, 'readwrite')
  tx.objectStore(store).put(value, key)
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

/** Collects every string and byte sequence inside a stored value. */
function fragments(value: unknown, out: { strings: string[]; bytes: Uint8Array[] }): void {
  if (typeof value === 'string') out.strings.push(value)
  else if (value instanceof Uint8Array) out.bytes.push(value)
  else if (value instanceof ArrayBuffer) out.bytes.push(new Uint8Array(value))
  else if (ArrayBuffer.isView(value)) out.bytes.push(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  else if (Array.isArray(value)) for (const v of value) fragments(v, out)
  else if (value && typeof value === 'object' && !(value instanceof CryptoKey)) {
    for (const [k, v] of Object.entries(value)) {
      out.strings.push(k)
      fragments(v, out)
    }
  }
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

describe('database', () => {
  test('is aparte-v1 with the four stores', async () => {
    expect(S.DB_NAME).toBe('aparte-v1')
    const { name, db } = await fresh()
    db.close()
    const raw = await request(indexedDB.open(name))
    expect([...raw.objectStoreNames].sort()).toEqual(['local', 'meta', 'objects', 'pending'])
    raw.close()
  })
})

describe('records', () => {
  test('put, get, delete and list by purpose', async () => {
    const { store } = await fresh()
    expect(await store.get('oauth-token', 'mcp:a')).toBeNull()
    await store.put('oauth-token', 'mcp:b', new Uint8Array([2]))
    await store.put('oauth-token', 'mcp:a', new Uint8Array([1]))
    await store.put('sync-credential', 'mcp:a', new Uint8Array([3]))
    expect(await store.get('oauth-token', 'mcp:a')).toEqual(new Uint8Array([1]))
    expect(await store.get('sync-credential', 'mcp:a')).toEqual(new Uint8Array([3]))
    expect(await store.list('oauth-token')).toEqual(['mcp:a', 'mcp:b'])
    await store.put('oauth-token', 'mcp:a', new Uint8Array([9, 9]))
    expect(await store.get('oauth-token', 'mcp:a')).toEqual(new Uint8Array([9, 9]))
    await store.delete('oauth-token', 'mcp:a')
    expect(await store.get('oauth-token', 'mcp:a')).toBeNull()
    expect(await store.list('oauth-token')).toEqual(['mcp:b'])
    expect(await store.list('provider-key')).toEqual([])
  })

  test('are kind-6 envelopes under their HMAC-derived local name', async () => {
    const { name, store } = await fresh()
    await store.put('provider-key', 'anthropic', new TextEncoder().encode('sk-test'))
    const rows = (await dump(name)).filter((r) => r.store === 'local')
    expect(rows).toHaveLength(1)
    const row = rows[0] as { key: IDBValidKey; value: unknown }
    expect(row.key).toBe(await N.localName(subkeys, 'provider-key', 'anthropic'))
    const bytes = row.value as Uint8Array
    expect(E.parseEnvelopeHeader(bytes)).toMatchObject({ version: 1, kind: 6, flags: 0, epoch: 0 })
  })

  test('a record copied under another record name does not open', async () => {
    const { name, store } = await fresh()
    await store.put('draft', 'a', new Uint8Array([1]))
    await store.put('draft', 'b', new Uint8Array([2]))
    const rows = (await dump(name)).filter((r) => r.store === 'local')
    const keyA = await N.localName(subkeys, 'draft', 'a')
    const keyB = await N.localName(subkeys, 'draft', 'b')
    const valueA = rows.find((r) => r.key === keyA)?.value
    expect(valueA).toBeInstanceOf(Uint8Array)
    await rawPut(name, 'local', keyB, valueA)
    await expect(store.get('draft', 'b')).rejects.toBeInstanceOf(TamperedError)
  })

  test('another vault cannot see the records', async () => {
    const { db, store } = await fresh()
    await store.put('draft', 'a', new Uint8Array([1]))
    const otherKeys = await K.deriveSubkeys(B.fromHex(inputs.mk), B.fromHex(inputs.otherVaultId))
    const other = S.createLocalStore({ db, subkeys: otherKeys, rng: R.cryptoRng() })
    expect(await other.get('draft', 'a')).toBeNull()
    expect(await other.list('draft')).toEqual([])
  })
})

describe('object mirror', () => {
  const name = 'b/aa/aaaaaaaaaaaaaaaaaaaaaaaaaa'

  test('stores envelopes byte for byte', async () => {
    const { store } = await fresh()
    const envelope = await E.sealEnvelope(subkeys, { kind: 3, name, payload: new Uint8Array(10) }, R.cryptoRng())
    await store.objects.put(name, envelope)
    expect(await store.objects.get(name)).toEqual(envelope)
    expect(await store.objects.names('b/')).toEqual([name])
    expect(await store.objects.names('d/')).toEqual([])
    await store.objects.delete(name)
    expect(await store.objects.get(name)).toBeNull()
  })

  test('refuses anything that is not an envelope of kind 1 to 5', async () => {
    const { store } = await fresh()
    const local = await E.sealEnvelope(
      subkeys,
      { kind: 6, name: 'aaaaaaaaaaaaaaaaaaaaaaaaaa', payload: new Uint8Array(1) },
      R.cryptoRng(),
    )
    for (const bytes of [new TextEncoder().encode(CANARY.repeat(4)), new Uint8Array(120), local]) {
      await expect(store.objects.put(name, bytes)).rejects.toBeInstanceOf(InvalidInputError)
    }
    expect(await store.objects.names()).toEqual([])
  })
})

describe('pending queue', () => {
  test('appends in order per document, survives a new store instance, and drops what was sealed', async () => {
    const { db, store } = await fresh()
    expect(await store.pending.append('index', new Uint8Array([1]))).toBe(1)
    expect(await store.pending.append('index', new Uint8Array([2]))).toBe(2)
    expect(await store.pending.append('c07', new Uint8Array([7]))).toBe(1)
    expect(await store.pending.append('index', new Uint8Array([3]))).toBe(3)
    const again = S.createLocalStore({ db, subkeys, rng: R.cryptoRng() })
    expect(await again.pending.list('index')).toEqual([
      { n: 1, update: new Uint8Array([1]) },
      { n: 2, update: new Uint8Array([2]) },
      { n: 3, update: new Uint8Array([3]) },
    ])
    await again.pending.drop('index', 2)
    expect(await again.pending.list('index')).toEqual([{ n: 3, update: new Uint8Array([3]) }])
    expect(await again.pending.list('c07')).toEqual([{ n: 1, update: new Uint8Array([7]) }])
    expect(await again.pending.append('index', new Uint8Array([4]))).toBe(4)
  })
})

describe('nothing readable reaches IndexedDB', () => {
  test('a canary written through every path appears in no key and no value', async () => {
    const { name, store } = await fresh()
    const canary = new TextEncoder().encode(CANARY)
    await store.put('provider-key', CANARY, canary)
    await store.put('oauth-token', 'token', canary)
    await store.put('draft', 'draft', B.concat(canary, canary))
    await store.pending.append('c03', canary)
    const envelope = await E.sealEnvelope(
      subkeys,
      { kind: 1, name: 'd/aaaaaaaaaaaaaaaa/s/bbbbbbbbbbbbbbbb/0000000/0000000001-cccccccc', payload: canary },
      R.cryptoRng(),
    )
    await store.objects.put('d/aaaaaaaaaaaaaaaa/s/bbbbbbbbbbbbbbbb/0000000/0000000001-cccccccc', envelope)

    const rows = await dump(name)
    expect(rows.length).toBeGreaterThanOrEqual(5)
    const found = { strings: [] as string[], bytes: [] as Uint8Array[] }
    for (const row of rows) {
      fragments(row.key, found)
      fragments(row.value, found)
    }
    const hex = B.toHex(canary)
    const b64 = btoa(CANARY)
    const b64url = B.base64urlEncode(canary)
    for (const s of found.strings) {
      for (const needle of [CANARY, hex, b64, b64url, 'provider-key', 'oauth-token']) {
        expect(s.includes(needle)).toBe(false)
      }
    }
    const utf16 = new Uint8Array(new Uint16Array([...CANARY].map((c) => c.charCodeAt(0))).buffer)
    for (const bytes of found.bytes) {
      expect(contains(bytes, canary)).toBe(false)
      expect(contains(bytes, utf16)).toBe(false)
      expect(contains(bytes, new TextEncoder().encode(hex))).toBe(false)
    }
  })
})

describe('meta', () => {
  test('holds the marker, the vault id, keyslots and the device key', async () => {
    const { db } = await fresh()
    const meta = S.createLocalMeta(db)
    expect(await meta.get('fmt')).toBeUndefined()
    await meta.put('fmt', 'aparte/1\n')
    await meta.put('vault', B.base32Encode(B.fromHex(inputs.vaultId)))
    const deviceKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    await meta.put('device-key', deviceKey)
    await meta.putKeyslot('bbbbbbbbbbbbbbbbbbbbbbbbba', new TextEncoder().encode('{"b":1}\n'))
    await meta.putKeyslot('aaaaaaaaaaaaaaaaaaaaaaaaaa', new TextEncoder().encode('{"a":1}\n'))
    expect(await meta.get('fmt')).toBe('aparte/1\n')
    const key = await meta.get('device-key')
    expect(key?.extractable).toBe(false)
    expect((await meta.keyslots()).map((k) => k.slot)).toEqual([
      'aaaaaaaaaaaaaaaaaaaaaaaaaa',
      'bbbbbbbbbbbbbbbbbbbbbbbbba',
    ])
    await meta.deleteKeyslot('aaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect((await meta.keyslots()).map((k) => k.slot)).toEqual(['bbbbbbbbbbbbbbbbbbbbbbbbba'])
    await meta.clear()
    expect(await meta.get('vault')).toBeUndefined()
    expect(await meta.keyslots()).toEqual([])
  })
})

describe('after dispose', () => {
  test('every call rejects with LockedError', async () => {
    const { store } = await fresh()
    await store.put('draft', 'a', new Uint8Array([1]))
    store.dispose()
    store.dispose()
    await expect(store.get('draft', 'a')).rejects.toBeInstanceOf(LockedError)
    await expect(store.put('draft', 'a', new Uint8Array([1]))).rejects.toBeInstanceOf(LockedError)
    await expect(store.delete('draft', 'a')).rejects.toBeInstanceOf(LockedError)
    await expect(store.list('draft')).rejects.toBeInstanceOf(LockedError)
    await expect(store.pending.append('index', new Uint8Array([1]))).rejects.toBeInstanceOf(LockedError)
    await expect(store.pending.list('index')).rejects.toBeInstanceOf(LockedError)
    await expect(store.objects.names()).rejects.toBeInstanceOf(LockedError)
  })
})
