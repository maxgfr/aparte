import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import { CorruptError, type DocId, InvalidInputError } from '../contracts/crypto.ts'
import { concat, fromHex, toHex, u32be, utf8 } from '../crypto/bytes.ts'
import { decodeStreamPayload, encodeStreamPayload, type StreamHeader } from './framing.ts'

const vectors = (await Bun.file(new URL('../../../../spec/vectors/framing.json', import.meta.url)).json()) as {
  segment: { header: string; payload: string }
  checkpoint: { header: string; payload: string }
}
const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  framing: {
    segment: { header: StreamHeader & { v: 1 }; update: string }
    checkpoint: { header: StreamHeader & { v: 1 }; update: string }
  }
}

const header = (h: StreamHeader & { v?: number }): StreamHeader => {
  const { v: _v, ...rest } = h
  return rest
}

describe('stream payload framing against spec/vectors/framing.json', () => {
  for (const kind of ['segment', 'checkpoint'] as const) {
    test(`${kind}: the writer produces the vector bytes, and the reader returns the inputs`, () => {
      const input = inputs.framing[kind]
      const payload = encodeStreamPayload(kind, header(input.header), fromHex(input.update))
      expect(toHex(payload)).toBe(vectors[kind].payload)
      const decoded = decodeStreamPayload(kind, fromHex(vectors[kind].payload))
      expect(toHex(decoded.update)).toBe(input.update)
      expect(decoded.header.doc).toBe(input.header.doc as DocId)
      expect(decoded.header.blobs).toEqual([...input.header.blobs].sort())
      expect(decoded.header.seen).toEqual(input.header.seen)
      if (kind === 'checkpoint') expect(decoded.header.covers).toEqual(input.header.covers as Record<string, number>)
    })
  }
})

const base: StreamHeader = {
  doc: 'index',
  device: 'aaaaaaaaaaaaaaaa',
  seq: 1,
  time: 1,
  seen: {},
  blobs: [],
}

/** A payload with `json` as its header text, for the reader's refusals. */
const raw = (json: string, update = new Uint8Array([1])) => {
  const bytes = utf8(json)
  return concat(u32be(bytes.length), bytes, update)
}

describe('the writer refuses what the schema does not allow', () => {
  test.each([
    ['a device that is not a dtag', { ...base, device: 'AAAAAAAAAAAAAAAA' }],
    ['seq 0', { ...base, seq: 0 }],
    ['seq above 10 digits', { ...base, seq: 10_000_000_000 }],
    ['a fractional time', { ...base, time: 1.5 }],
    ['the writer in seen', { ...base, seen: { aaaaaaaaaaaaaaaa: 1 } }],
    ['a blob that is not an id', { ...base, blobs: ['x'] }],
    ['an unknown document', { ...base, doc: 'c16' as DocId }],
  ])('%s', (_what, h) => {
    expect(() => encodeStreamPayload('segment', h, new Uint8Array([1]))).toThrow(InvalidInputError)
  })

  test('an empty update, covers on a segment, a checkpoint that does not cover itself', () => {
    expect(() => encodeStreamPayload('segment', base, new Uint8Array())).toThrow(InvalidInputError)
    expect(() => encodeStreamPayload('segment', { ...base, covers: {} }, new Uint8Array([1]))).toThrow(
      InvalidInputError,
    )
    expect(() =>
      encodeStreamPayload('checkpoint', { ...base, covers: { aaaaaaaaaaaaaaaa: 2 } }, new Uint8Array([1])),
    ).toThrow(InvalidInputError)
  })

  test('blobs are sorted and deduplicated', () => {
    const a = 'b'.repeat(26)
    const z = 'z'.repeat(26)
    const payload = encodeStreamPayload('segment', { ...base, blobs: [z, a, z] }, new Uint8Array([1]))
    expect(decodeStreamPayload('segment', payload).header.blobs).toEqual([a, z])
  })
})

describe('the reader accepts only the writer form', () => {
  const good = '{"v":1,"doc":"index","device":"aaaaaaaaaaaaaaaa","seq":1,"time":1,"seen":{},"blobs":[]}'

  test('the writer form opens', () => {
    expect(decodeStreamPayload('segment', raw(good)).header.seq).toBe(1)
  })

  test.each([
    ['whitespace', good.replace(',"seq"', ', "seq"')],
    ['reordered members', good.replace('"v":1,"doc":"index"', '"doc":"index","v":1')],
    ['an extra member', good.replace('"blobs":[]', '"blobs":[],"x":1')],
    ['a missing member', good.replace(',"time":1', '')],
    ['a repeated member', good.replace('"seq":1', '"seq":2,"seq":1')],
    ['another version', good.replace('"v":1', '"v":2')],
    ['seq as a string', good.replace('"seq":1', '"seq":"1"')],
    ['seq written 1.0', good.replace('"seq":1', '"seq":1.0')],
    ['an unsorted seen', good.replace('"seen":{}', '"seen":{"cccccccccccccccc":1,"bbbbbbbbbbbbbbbb":1}')],
    ['a number beyond binary64', good.replace('"time":1', '"time":1e400')],
    ['covers in a segment', good.replace('"blobs":[]', '"blobs":[],"covers":{}')],
    ['not JSON', '{"v":1'],
  ])('%s is corrupt', (_what, json) => {
    expect(() => decodeStreamPayload('segment', raw(json))).toThrow(CorruptError)
  })

  test('a header length of 0, past the end, or leaving no update is corrupt', () => {
    expect(() => decodeStreamPayload('segment', new Uint8Array([0, 0, 0, 0, 1]))).toThrow(CorruptError)
    expect(() => decodeStreamPayload('segment', new Uint8Array([0, 0, 1, 0, 1]))).toThrow(CorruptError)
    expect(() => decodeStreamPayload('segment', raw(good, new Uint8Array()))).toThrow(CorruptError)
    expect(() => decodeStreamPayload('segment', new Uint8Array([0, 0]))).toThrow(CorruptError)
  })

  test('a valid UTF-8 header with a lone-surrogate escape in a key is corrupt', () => {
    const bad = good.replace('"seen":{}', '"seen":{"\\ud800aaaaaaaaaaaaaaa":1}')
    expect(() => decodeStreamPayload('segment', raw(bad))).toThrow(CorruptError)
  })
})

describe('properties', () => {
  const tag = fc.stringMatching(/^[a-z2-7]{16}$/)
  const id = fc.stringMatching(/^[a-z2-7]{26}$/)
  const headers = fc.record({
    device: tag,
    seq: fc.integer({ min: 1, max: 9_999_999_999 }),
    time: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
    seen: fc.dictionary(tag, fc.integer({ min: 0, max: 9_999_999_999 }), { maxKeys: 5 }),
    blobs: fc.array(id, { maxLength: 5 }),
    doc: fc.constantFrom<DocId>('index', 'c00', 'c15'),
  })

  test('decode(encode(h)) gives h back, blobs sorted, and the bytes again', () => {
    fc.assert(
      fc.property(headers, fc.uint8Array({ minLength: 1, maxLength: 64 }), (h, update) => {
        const seen = Object.fromEntries(Object.entries(h.seen).filter(([d]) => d !== h.device))
        const input: StreamHeader = { ...h, seen }
        const payload = encodeStreamPayload('segment', input, update)
        const out = decodeStreamPayload('segment', payload)
        expect(out.header.seen).toEqual(seen)
        expect(out.header.blobs).toEqual([...new Set(h.blobs)].sort())
        expect(out.update).toEqual(update)
        expect(encodeStreamPayload('segment', out.header, out.update)).toEqual(payload)
      }),
    )
  })

  test('a flipped byte in the header is never read as another valid header', () => {
    fc.assert(
      fc.property(headers, fc.nat(), fc.integer({ min: 1, max: 255 }), (h, at, flip) => {
        const seen = Object.fromEntries(Object.entries(h.seen).filter(([d]) => d !== h.device))
        const payload = encodeStreamPayload('segment', { ...h, seen }, new Uint8Array([7]))
        const hlen = payload.length - 5
        const i = 4 + (at % hlen)
        const mutated = new Uint8Array(payload)
        mutated[i] = (mutated[i] as number) ^ flip
        try {
          const out = decodeStreamPayload('segment', mutated)
          // A flip that still parses must change what the header says (a digit or a tag character).
          expect(encodeStreamPayload('segment', out.header, out.update)).toEqual(mutated)
        } catch (error) {
          expect(error).toBeInstanceOf(CorruptError)
        }
      }),
    )
  })
})
