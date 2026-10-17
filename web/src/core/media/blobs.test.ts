import { describe, expect, test } from 'bun:test'
import { type Bytes, InvalidInputError } from '../contracts/crypto.ts'
import type { ObjectMirror } from '../contracts/store.ts'
import { fromHex } from '../crypto/bytes.ts'
import { MAX_CHUNK } from '../crypto/envelope.ts'
import { deriveSubkeys } from '../crypto/keys.ts'
import { cryptoRng } from '../crypto/rng.ts'
import { createLocalBlobs, splitChunks } from './blobs.ts'

const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  mk: string
  vaultId: string
}
const subkeys = await deriveSubkeys(fromHex(inputs.mk), fromHex(inputs.vaultId))

class MemoryObjects implements ObjectMirror {
  readonly map = new Map<string, Bytes>()
  writes = 0
  async put(name: string, envelope: Uint8Array) {
    this.writes++
    this.map.set(name, new Uint8Array(envelope))
  }
  async get(name: string) {
    const v = this.map.get(name)
    return v ? v.slice() : null
  }
  async delete(name: string) {
    this.map.delete(name)
  }
  async names(prefix = '') {
    return [...this.map.keys()].filter((n) => n.startsWith(prefix)).sort()
  }
}

const setup = () => {
  const objects = new MemoryObjects()
  return { objects, blobs: createLocalBlobs({ objects, subkeys, rng: cryptoRng() }) }
}

const bytesOf = (n: number, seed = 7) => {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff
  return out
}

describe('local blobs', () => {
  test('round-trips and stores nothing readable, under content-addressed names', async () => {
    const { objects, blobs } = setup()
    const photo = bytesOf(5000)
    const id = await blobs.put(photo, 'image/jpeg')
    expect(id).toMatch(/^[a-z2-7]{26}$/)
    expect(await blobs.get(id)).toEqual(photo)
    expect(await blobs.info(id)).toEqual({ mediaType: 'image/jpeg', size: 5000 })
    const names = await objects.names()
    expect(names).toContain(`m/${id.slice(0, 2)}/${id}`)
    expect(names.filter((n) => n.startsWith('b/'))).toHaveLength(1)
    for (const sealed of objects.map.values()) {
      expect([...sealed.subarray(0, 4)]).toEqual([0x41, 0x50, 0x54, 0x31])
      expect(Buffer.from(sealed).includes(Buffer.from('image/jpeg'))).toBe(false)
    }
  })

  test('the same bytes give the same id and are stored once', async () => {
    const { objects, blobs } = setup()
    const a = await blobs.put(bytesOf(100), 'image/png')
    const writes = objects.writes
    expect(await blobs.put(bytesOf(100), 'image/png')).toBe(a)
    expect(objects.writes).toBe(writes)
    expect(await blobs.put(bytesOf(100), 'image/webp')).not.toBe(a)
  })

  test('large files are cut into 2 MiB chunks, the last one shorter; an empty file has none', async () => {
    expect(splitChunks(new Uint8Array(MAX_CHUNK * 2 + 3)).map((c) => c.length)).toEqual([MAX_CHUNK, MAX_CHUNK, 3])
    expect(splitChunks(new Uint8Array(0))).toEqual([])
    const { objects, blobs } = setup()
    const big = bytesOf(MAX_CHUNK + 10)
    const id = await blobs.put(big, 'application/pdf')
    expect((await objects.names('b/')).length).toBe(2)
    expect(await blobs.get(id)).toEqual(big)
    const empty = await blobs.put(new Uint8Array(0), 'text/plain')
    expect(await blobs.get(empty)).toEqual(new Uint8Array(0))
  })

  test('a missing manifest or chunk reads as null; an envelope moved to another name does not open', async () => {
    const { objects, blobs } = setup()
    expect(await blobs.get('a'.repeat(26))).toBeNull()
    expect(await blobs.get('not an id')).toBeNull()
    const id = await blobs.put(bytesOf(300, 1), 'image/jpeg')
    const [chunk] = (await objects.names('b/')) as [string]
    const other = await blobs.put(bytesOf(300, 2), 'image/jpeg')
    const otherChunk = (await objects.names('b/')).find((n) => n !== chunk) as string
    await objects.put(chunk, (await objects.get(otherChunk)) as Bytes)
    await expect(blobs.get(id)).rejects.toThrow()
    expect(await blobs.get(other)).toEqual(bytesOf(300, 2))
    await objects.delete(chunk)
    expect(await blobs.get(id)).toBeNull()
  })

  test('refuses a malformed media type', async () => {
    const { blobs } = setup()
    await expect(blobs.put(bytesOf(10), 'jpeg')).rejects.toBeInstanceOf(InvalidInputError)
    await expect(blobs.put(bytesOf(10), 'image/jpeg; q=1')).rejects.toBeInstanceOf(InvalidInputError)
  })
})
