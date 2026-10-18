/*
 * The RemoteStore contract (web/src/core/contracts/sync.ts), as one suite every provider runs against its fake
 * server: the memory store, GitHub, S3, a folder, a zip archive. A provider passes only if it lists completely and in
 * order, reads back exactly the bytes it was given, ignores a second put of a name, and deletes on request.
 */

import { describe, expect, test } from 'bun:test'
import { CHUNK_SIZE, type RemoteStore } from '../../contracts/sync.ts'

export interface ContractSubject {
  readonly store: RemoteStore
  /** A second handle on the same destination (another device), when the provider has one. */
  readonly again?: () => RemoteStore
}

const seg = (seq: number) => `d/${'a'.repeat(16)}/s/${'b'.repeat(16)}/0000000/${String(seq).padStart(10, '0')}-cccccccc`
const bytesOf = (n: number, seed: number): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff
  return out
}

export function remoteContract(name: string, make: () => Promise<ContractSubject>): void {
  describe(`${name}: RemoteStore contract`, () => {
    test('an empty store lists nothing, and an absent object reads as null', async () => {
      const { store } = await make()
      expect(await store.list('')).toEqual([])
      expect(await store.get({ name: 'fmt/1' })).toBeNull()
    })

    test('put, flush, list and get give back exactly the bytes, every byte value included', async () => {
      const { store, again } = await make()
      const all = new Uint8Array(256).map((_, i) => i)
      await store.put('fmt/1', new TextEncoder().encode('aparte/1\n'))
      await store.put(seg(2), all)
      await store.put(seg(1), bytesOf(300, 1))
      await store.flush()
      const listed = await store.list('')
      expect(listed.map((e) => e.name)).toEqual([seg(1), seg(2), 'fmt/1'])
      const entry = listed.find((e) => e.name === seg(2))
      expect(await store.get(entry as (typeof listed)[number])).toEqual(all)
      expect(await store.get({ name: seg(1) })).toEqual(bytesOf(300, 1))
      if (again) {
        const other = again()
        expect((await other.list('')).map((e) => e.name)).toEqual([seg(1), seg(2), 'fmt/1'])
        expect(await other.get({ name: seg(2) })).toEqual(all)
      }
    })

    test('a listing filters by prefix and stays sorted', async () => {
      const { store } = await make()
      for (const seq of [5, 3, 9, 1]) await store.put(seg(seq), bytesOf(10, seq))
      await store.put(`keys/${'a'.repeat(26)}.json`, new TextEncoder().encode('{}\n'))
      await store.flush()
      expect((await store.list('d/')).map((e) => e.name)).toEqual([1, 3, 5, 9].map(seg))
      expect((await store.list('keys/')).map((e) => e.name)).toEqual([`keys/${'a'.repeat(26)}.json`])
      expect(await store.list('m/')).toEqual([])
    })

    test('a second put of a name stores one object', async () => {
      const { store } = await make()
      await store.put(seg(1), bytesOf(50, 1))
      await store.flush()
      await store.put(seg(1), bytesOf(50, 1))
      await store.flush()
      expect((await store.list('')).map((e) => e.name)).toEqual([seg(1)])
      expect(await store.get({ name: seg(1) })).toEqual(bytesOf(50, 1))
    })

    test('a deleted object is gone from the listing', async () => {
      const { store } = await make()
      const slot = `keys/${'a'.repeat(26)}.json`
      await store.put(slot, new TextEncoder().encode('{}\n'))
      await store.put(seg(1), bytesOf(20, 1))
      await store.flush()
      await store.delete(slot)
      await store.flush()
      expect((await store.list('')).map((e) => e.name)).toEqual([seg(1)])
    })

    test('an object of a full chunk and more round-trips', async () => {
      const { store } = await make()
      const big = bytesOf(CHUNK_SIZE + 120, 9)
      const name = `b/aa/${'a'.repeat(26)}`
      await store.put(name, big)
      await store.flush()
      expect(await store.get({ name })).toEqual(big)
    }, 30_000)
  })
}
