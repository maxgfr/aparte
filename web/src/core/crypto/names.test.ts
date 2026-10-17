/*
 * Object names of spec/FORMAT.md section 8. Each tag and suffix is recomputed here from its HMAC formula with the raw
 * subkey bytes, so names.ts is pinned to the spec rather than to itself.
 */
import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import {
  type BytesModule,
  type DocId,
  InvalidInputError,
  type KeysModule,
  type NamesModule,
  type ShardId,
} from '../contracts/crypto.ts'
import * as bytesImpl from './bytes.ts'
import * as keysImpl from './keys.ts'
import * as namesImpl from './names.ts'

const B: BytesModule = bytesImpl
const K: KeysModule = keysImpl
const N: NamesModule = namesImpl

interface StreamCase {
  doc: DocId
  device: 'a' | 'b'
  seq: number
  payload: string
}
const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  mk: string
  vaultId: string
  deviceIds: { a: string; b: string }
  names: {
    docIds: DocId[]
    convIds: string[]
    segments: StreamCase[]
    checkpoints: StreamCase[]
    chunks: string[]
    manifests: string[]
    secrets: { id: string; seq: number; payload: string }[]
    local: { purpose: string; id: string }[]
  }
}

const mk = B.fromHex(inputs.mk)
const vaultId = B.fromHex(inputs.vaultId)
const subkeys = await K.deriveSubkeys(mk, vaultId)
const utf8 = (s: string) => new TextEncoder().encode(s)
const raw = (purpose: string) =>
  K.hkdfSha256(mk, B.concat(utf8('aparte/1/vault'), vaultId), utf8(`aparte/1/${purpose}`))
const rawObjName = await raw('obj-name')
const rawBlobId = await raw('blob-id')
const rawLocalName = await raw('local-name')
const tag = async (key: Uint8Array, message: Uint8Array, chars: number) =>
  B.base32Encode(await K.hmacSha256(key, message)).slice(0, chars)
const device = (d: 'a' | 'b') => B.fromHex(inputs.deviceIds[d])
const seq10 = (n: number) => String(n).padStart(10, '0')
const B32 = /^[a-z2-7]+$/

describe('tags', () => {
  test('dtag = b32(HMAC(K_obj-name, "dtag|" || deviceId))[0..16]', async () => {
    for (const d of ['a', 'b'] as const) {
      const expected = await tag(rawObjName, B.concat(utf8('dtag|'), device(d)), 16)
      expect(await N.deviceTag(subkeys, device(d))).toBe(expected)
      expect(expected).toMatch(B32)
    }
  })

  test.each(inputs.names.docIds)('stag of %p = b32(HMAC(K_obj-name, "doc|" || docId))[0..16]', async (docId) => {
    expect(await N.docTag(subkeys, docId)).toBe(await tag(rawObjName, utf8(`doc|${docId}`), 16))
  })

  test('every document has a distinct tag', async () => {
    const all: DocId[] = ['index', ...Array.from({ length: 16 }, (_, i) => `c${String(i).padStart(2, '0')}` as DocId)]
    const tags = await Promise.all(all.map((d) => N.docTag(subkeys, d)))
    expect(new Set(tags).size).toBe(17)
  })

  test.each(inputs.names.convIds)('shard of %p is "c" + 2 digits of HMAC[0] & 15', async (hex) => {
    const mac = await K.hmacSha256(rawObjName, B.concat(utf8('shard|'), B.fromHex(hex)))
    const expected = `c${String((mac[0] ?? 0) & 0x0f).padStart(2, '0')}`
    expect<string>(await N.shardOf(subkeys, B.fromHex(hex))).toBe(expected)
  })

  test('shards spread over c00..c15', async () => {
    const seen = new Set<ShardId>()
    for (let i = 0; i < 400; i++)
      seen.add(
        await N.shardOf(
          subkeys,
          Uint8Array.from({ length: 16 }, (_, j) => i * j),
        ),
      )
    expect([...seen].every((s) => /^c(0\d|1[0-5])$/.test(s))).toBe(true)
    expect(seen.size).toBe(16)
  })

  test('ktag = b32(HMAC(K_obj-name, "secret|" || secretId))[0..16]', async () => {
    const id = B.fromHex(inputs.names.secrets[0]?.id ?? '')
    expect(await N.secretTag(subkeys, id)).toBe(await tag(rawObjName, B.concat(utf8('secret|'), id), 16))
  })
})

describe('segment and checkpoint names', () => {
  test.each(inputs.names.segments)('segment $doc/$device/$seq', async (c) => {
    const stag = await tag(rawObjName, utf8(`doc|${c.doc}`), 16)
    const dtag = await tag(rawObjName, B.concat(utf8('dtag|'), device(c.device)), 16)
    const digest = await K.sha256(B.fromHex(c.payload))
    const r8 = await tag(rawObjName, B.concat(utf8(`seg|${stag}${dtag}${seq10(c.seq)}`), digest), 8)
    const bucket = String(Math.floor(c.seq / 1000)).padStart(7, '0')
    const name = await N.segmentName(subkeys, {
      docId: c.doc,
      deviceId: device(c.device),
      seq: c.seq,
      payload: B.fromHex(c.payload),
    })
    expect(name).toBe(`d/${stag}/s/${dtag}/${bucket}/${seq10(c.seq)}-${r8}`)
    expect(N.parseName(name)).toEqual({ type: 'segment', stag, dtag, seq: c.seq, r: r8 })
  })

  test('buckets group a thousand sequence numbers', async () => {
    const at = async (seq: number) =>
      (await N.segmentName(subkeys, { docId: 'index', deviceId: device('a'), seq, payload: new Uint8Array() })).split(
        '/',
      )[4]
    expect(await at(1)).toBe('0000000')
    expect(await at(999)).toBe('0000000')
    expect(await at(1000)).toBe('0000001')
    expect(await at(1234567)).toBe('0001234')
    expect(await at(9999999999)).toBe('9999999')
  })

  test('the name is stable for one payload and changes with it', async () => {
    const input = { docId: 'c07' as const, deviceId: device('b'), seq: 5, payload: utf8('update') }
    const a = await N.segmentName(subkeys, input)
    expect(await N.segmentName(subkeys, { ...input })).toBe(a)
    expect(await N.segmentName(subkeys, { ...input, payload: utf8('update2') })).not.toBe(a)
    expect(await N.segmentName(subkeys, { ...input, seq: 6 })).not.toBe(a)
  })

  test.each([0, -1, 1.5, 10_000_000_000])('refuses seq %p', async (seq) => {
    await expect(
      N.segmentName(subkeys, { docId: 'index', deviceId: device('a'), seq, payload: new Uint8Array() }),
    ).rejects.toBeInstanceOf(InvalidInputError)
  })

  test.each(inputs.names.checkpoints)('checkpoint $doc/$device/$seq uses the "ckpt|" label', async (c) => {
    const stag = await tag(rawObjName, utf8(`doc|${c.doc}`), 16)
    const dtag = await tag(rawObjName, B.concat(utf8('dtag|'), device(c.device)), 16)
    const digest = await K.sha256(B.fromHex(c.payload))
    const r8 = await tag(rawObjName, B.concat(utf8(`ckpt|${stag}${dtag}${seq10(c.seq)}`), digest), 8)
    const name = await N.checkpointName(subkeys, {
      docId: c.doc,
      deviceId: device(c.device),
      seq: c.seq,
      payload: B.fromHex(c.payload),
    })
    expect(name).toBe(`d/${stag}/c/${dtag}/${seq10(c.seq)}-${r8}`)
    expect(N.parseName(name)).toEqual({ type: 'checkpoint', stag, dtag, seq: c.seq, r: r8 })
  })
})

describe('blob names', () => {
  test.each(inputs.names.chunks)('chunk id = b32(HMAC(K_blob-id, "chunk|" || SHA-256(chunk)))[0..26]', async (hex) => {
    const chunk = B.fromHex(hex)
    const id = await tag(rawBlobId, B.concat(utf8('chunk|'), await K.sha256(chunk)), 26)
    expect(await N.chunkId(subkeys, chunk)).toBe(id)
    expect(N.chunkName(id)).toBe(`b/${id.slice(0, 2)}/${id}`)
    expect(N.parseName(N.chunkName(id))).toEqual({ type: 'chunk', id })
  })

  test.each(inputs.names.manifests)('manifest id uses the "manifest|" label', async (json) => {
    const bytes = utf8(json)
    const id = await tag(rawBlobId, B.concat(utf8('manifest|'), await K.sha256(bytes)), 26)
    expect(await N.manifestId(subkeys, bytes)).toBe(id)
    expect(N.manifestName(id)).toBe(`m/${id.slice(0, 2)}/${id}`)
    expect(N.parseName(N.manifestName(id))).toEqual({ type: 'manifest', id })
  })

  test('chunk and manifest ids of the same bytes differ', async () => {
    const bytes = utf8('same bytes')
    expect(await N.chunkId(subkeys, bytes)).not.toBe(await N.manifestId(subkeys, bytes))
  })
})

describe('secret version names', () => {
  test.each(inputs.names.secrets)('k/<ktag>/<seq10>-<r8> with the "sec|" label', async (c) => {
    const id = B.fromHex(c.id)
    const ktag = await tag(rawObjName, B.concat(utf8('secret|'), id), 16)
    const digest = await K.sha256(B.fromHex(c.payload))
    const r8 = await tag(rawObjName, B.concat(utf8(`sec|${ktag}${seq10(c.seq)}`), digest), 8)
    const name = await N.secretVersionName(subkeys, { secretId: id, seq: c.seq, payload: B.fromHex(c.payload) })
    expect(name).toBe(`k/${ktag}/${seq10(c.seq)}-${r8}`)
    expect(N.parseName(name)).toEqual({ type: 'secret', ktag, seq: c.seq, r: r8 })
  })
})

describe('local record names', () => {
  test.each(inputs.names.local)('$purpose|$id = b32(HMAC(K_local-name, purpose || "|" || id))[0..26]', async (c) => {
    const expected = await tag(rawLocalName, utf8(`${c.purpose}|${c.id}`), 26)
    expect(await N.localName(subkeys, c.purpose, c.id)).toBe(expected)
  })

  test.each(['', 'Device', 'a|b', '1abc', 'x'.repeat(33), 'with space'])('refuses purpose %p', async (purpose) => {
    await expect(N.localName(subkeys, purpose, 'id')).rejects.toBeInstanceOf(InvalidInputError)
  })
})

describe('keyslot and marker names', () => {
  test('keys/<slot b32>.json and fmt/1', () => {
    expect(N.keyslotName(new Uint8Array(16).fill(0x11))).toBe('keys/ceirceirceirceirceirceirce.json')
    expect(N.parseName('keys/ceirceirceirceirceirceirce.json')).toEqual({
      type: 'keyslot',
      slot: 'ceirceirceirceirceirceirce',
    })
    expect(N.parseName('fmt/1')).toEqual({ type: 'fmt' })
  })
})

describe('parseName is strict', () => {
  const stag = 'aaaaaaaaaaaaaaaa'
  const dtag = 'bbbbbbbbbbbbbbbb'
  test.each([
    '',
    'fmt/2',
    'fmt/1/',
    `d/${stag}/s/${dtag}/0000000/0000000001-ccccccc`,
    `d/${stag}/s/${dtag}/0000000/0000000001-cccccccc/x`,
    `d/${stag}/s/${dtag}/0000001/0000000001-cccccccc`,
    `d/${stag}/s/${dtag}/0000000/0000000000-cccccccc`,
    `d/${stag.toUpperCase()}/s/${dtag}/0000000/0000000001-cccccccc`,
    `d/${stag}/s/${dtag}/0000000/0000000001-cccccccc 2`,
    `d/${stag}/x/${dtag}/0000000/0000000001-cccccccc`,
    `d/${stag}/c/${dtag}/0000000/0000000001-cccccccc`,
    `d/${stag}/c/${dtag}/0000000000-cccccccc`,
    'b/ab/bbbbbbbbbbbbbbbbbbbbbbbbbb',
    'b/bb/bbbbbbbbbbbbbbbbbbbbbbbbb',
    'm/bb/bbbbbbbbbbbbbbbbbbbbbbbbb1',
    'k/iiiiiiiiiiiiiiii/0000000000-jjjjjjjj',
    'keys/ceirceirceirceirceirceirc.json',
    'keys/ceirceirceirceirceirceircf.json',
    'keys/CEIRCEIRCEIRCEIRCEIRCEIRCE.json',
    'keys/ceirceirceirceirceirceirce.JSON',
  ])('ignores %p', (name) => {
    expect(N.parseName(name)).toBeNull()
  })

  test('every generated name is lowercase and parses back', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        fc.integer({ min: 1, max: 9_999_999_999 }),
        fc.uint8Array({ maxLength: 64 }),
        async (deviceId, seq, payload) => {
          const name = await N.segmentName(subkeys, { docId: 'c03', deviceId, seq, payload })
          expect(name).toBe(name.toLowerCase())
          expect(N.parseName(name)).toMatchObject({ type: 'segment', seq })
        },
      ),
      { numRuns: 50 },
    )
  })
})
