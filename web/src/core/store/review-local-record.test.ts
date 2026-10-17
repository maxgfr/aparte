/*
 * Review of the local record reader against spec/FORMAT.md sections 2, 9.6 and 12.
 *
 * 1. Section 9.6: "A reader recomputes the record name from purpose and id and rejects a mismatch (corrupt)", and
 *    section 12 makes every malformed framing `corrupt`. unframeRecord does not validate the framed purpose, and it
 *    decodes purpose and id with fromUtf8 (InvalidInputError); the recomputation then throws InvalidInputError for a
 *    purpose outside [a-z][a-z0-9-]{0,31}. An authenticated record with such framing makes `list` reject with
 *    `invalid-input` (a caller error) instead of `corrupt`. The Rust reader (decode_local_record) says `corrupt`.
 * 2. Section 2: every comparison of a recomputed name MUST run in constant time. unseal compares the recomputed local
 *    record name with `!==`, an early-exit string comparison.
 */
import { describe, expect, test } from 'bun:test'
import { CorruptError } from '../contracts/crypto.ts'
import type { LocalDb } from '../contracts/store.ts'
import * as B from '../crypto/bytes.ts'
import * as E from '../crypto/envelope.ts'
import * as K from '../crypto/keys.ts'
import * as R from '../crypto/rng.ts'
import * as S from './localStore.ts'

const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  mk: string
  vaultId: string
}
const subkeys = await K.deriveSubkeys(B.fromHex(inputs.mk), B.fromHex(inputs.vaultId))

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
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

/** A kind-6 envelope that authenticates under `name` but frames `payload` the writer would never produce. */
async function plant(payload: Uint8Array): Promise<LocalDb> {
  const dbName = `review-local-${crypto.randomUUID()}`
  const db = await S.openLocalDb({ name: dbName })
  const name = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'
  const bytes = await E.sealEnvelope(subkeys, { kind: 6, name, payload }, R.cryptoRng())
  await rawPut(dbName, 'local', name, bytes)
  return db
}

describe('review: malformed local record framing is corrupt (FORMAT.md 9.6)', () => {
  test('a purpose outside [a-z][a-z0-9-]{0,31}', async () => {
    const purpose = new TextEncoder().encode('Bad!')
    const payload = B.concat(new Uint8Array([purpose.length]), purpose, new Uint8Array([0, 0]))
    const db = await plant(payload)
    const store = S.createLocalStore({ db, subkeys, rng: R.cryptoRng() })
    await expect(store.list('draft')).rejects.toBeInstanceOf(CorruptError)
    db.close()
  })

  test('an id that is not UTF-8', async () => {
    const purpose = new TextEncoder().encode('draft')
    const payload = B.concat(new Uint8Array([purpose.length]), purpose, new Uint8Array([0, 1, 0xff]))
    const db = await plant(payload)
    const store = S.createLocalStore({ db, subkeys, rng: R.cryptoRng() })
    await expect(store.list('draft')).rejects.toBeInstanceOf(CorruptError)
    db.close()
  })
})

describe('review: the recomputed local record name is compared in constant time (FORMAT.md section 2)', () => {
  test('unseal does not compare the recomputed name with an early-exit operator', async () => {
    const source = await Bun.file(new URL('./localStore.ts', import.meta.url)).text()
    expect(source).not.toMatch(/await N\.localName\(k, record\.purpose, record\.id\)\)\s*!==\s*name/)
  })
})
