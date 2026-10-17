/*
 * Rules of the device store beyond the contract tests: what the object mirror and `meta` refuse, how a local record
 * that does not match its name is reported, and that concurrent queue appends never share a position.
 */
import { describe, expect, test } from 'bun:test'
import {
  type BytesModule,
  CorruptError,
  type EnvelopeModule,
  InvalidInputError,
  type KeysModule,
  type NamesModule,
  type RngModule,
} from '../contracts/crypto.ts'
import type { LocalStoreModule } from '../contracts/store.ts'
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
}
const subkeys = await K.deriveSubkeys(B.fromHex(inputs.mk), B.fromHex(inputs.vaultId))

let count = 0
async function fresh() {
  const db = await S.openLocalDb({ name: `store-rules-${++count}-${crypto.randomUUID()}` })
  return { db, store: S.createLocalStore({ db, subkeys, rng: R.cryptoRng() }) }
}

function rawPut(name: string, store: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction(store, 'readwrite')
      tx.objectStore(store).put(value, key)
      tx.oncomplete = () => {
        open.result.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
  })
}

describe('object mirror', () => {
  test('refuses a name that is not a remote envelope name, or an envelope of another kind than its name', async () => {
    const { store } = await fresh()
    const chunk = 'b/aa/aaaaaaaaaaaaaaaaaaaaaaaaaa'
    const envelope = await E.sealEnvelope(subkeys, { kind: 3, name: chunk, payload: new Uint8Array(10) }, R.cryptoRng())
    for (const name of ['fmt/1', 'keys/aaaaaaaaaaaaaaaaaaaaaaaaaa.json', 'b/ab/aaaaaaaaaaaaaaaaaaaaaaaaaa', 'notes']) {
      await expect(store.objects.put(name, envelope)).rejects.toBeInstanceOf(InvalidInputError)
    }
    await expect(store.objects.put('m/aa/aaaaaaaaaaaaaaaaaaaaaaaaaa', envelope)).rejects.toBeInstanceOf(
      InvalidInputError,
    )
    expect(await store.objects.names()).toEqual([])
    await store.objects.put(chunk, envelope)
    expect(await store.objects.names()).toEqual([chunk])
  })
})

describe('local records', () => {
  test('a record whose framed purpose and id do not name it is corrupt', async () => {
    const { db, store } = await fresh()
    const name = await N.localName(subkeys, 'draft', 'a')
    // Sealed under the right name and key, but framing another id: only a writer bug or a key holder can do this.
    const payload = B.concat(
      new Uint8Array([5]),
      B.utf8('draft'),
      new Uint8Array([0, 1]),
      B.utf8('b'),
      new Uint8Array([7]),
    )
    const bytes = await E.sealEnvelope(subkeys, { kind: 6, name, payload }, R.cryptoRng())
    await rawPut(db.name, 'local', name, bytes)
    await expect(store.get('draft', 'a')).rejects.toBeInstanceOf(CorruptError)
    await expect(store.list('draft')).rejects.toBeInstanceOf(CorruptError)
  })

  test('refuses an id longer than 1024 bytes and an unknown purpose', async () => {
    const { store } = await fresh()
    await expect(store.put('draft', 'x'.repeat(1025), new Uint8Array(1))).rejects.toBeInstanceOf(InvalidInputError)
    await store.put('draft', 'x'.repeat(1024), new Uint8Array(1))
    expect(await store.list('draft')).toEqual(['x'.repeat(1024)])
    await expect(store.list('Not A Purpose' as 'draft')).rejects.toBeInstanceOf(InvalidInputError)
  })
})

describe('pending queue', () => {
  test('concurrent appends to one document take distinct, consecutive positions', async () => {
    const { db, store } = await fresh()
    const other = S.createLocalStore({ db, subkeys, rng: R.cryptoRng() })
    const positions = await Promise.all([
      store.pending.append('c01', new Uint8Array([1])),
      other.pending.append('c01', new Uint8Array([2])),
      store.pending.append('c01', new Uint8Array([3])),
      other.pending.append('c01', new Uint8Array([4])),
    ])
    expect([...positions].sort()).toEqual([1, 2, 3, 4])
    expect((await store.pending.list('c01')).map((u) => u.n)).toEqual([1, 2, 3, 4])
  })

  test('refuses an unknown document', async () => {
    const { store } = await fresh()
    await expect(store.pending.append('c16' as 'c15', new Uint8Array(1))).rejects.toBeInstanceOf(InvalidInputError)
  })
})

describe('meta', () => {
  test('refuses an extractable device key and a wrapped Secret Key of the wrong size', async () => {
    const { db } = await fresh()
    const meta = S.createLocalMeta(db)
    const extractable = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
    await expect(meta.put('device-key', extractable)).rejects.toBeInstanceOf(InvalidInputError)
    await expect(meta.put('secret-key', new Uint8Array(43))).rejects.toBeInstanceOf(InvalidInputError)
    await expect(meta.putKeyslot('not-a-slot', new Uint8Array(1))).rejects.toBeInstanceOf(InvalidInputError)
    expect(await meta.get('device-key')).toBeUndefined()
  })

  test('a closed database rejects every call', async () => {
    const { db } = await fresh()
    const meta = S.createLocalMeta(db)
    db.close()
    await expect(meta.get('fmt')).rejects.toThrow()
  })
})
