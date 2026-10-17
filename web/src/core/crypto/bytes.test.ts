import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import { type BytesModule, InvalidInputError } from '../contracts/crypto.ts'
import * as bytesImpl from './bytes.ts'

// The module must satisfy its contract: this assignment fails to compile otherwise.
const B: BytesModule = bytesImpl

interface TextInputs {
  base32: string[]
  base32Invalid: string[]
  base64url: string[]
  base64urlInvalid: string[]
}
const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  text: TextInputs
}

const ascii = (s: string) => new TextEncoder().encode(s)

describe('utf8', () => {
  test('round trips well-formed text, including astral characters', () => {
    for (const s of ['', 'aparte/1', 'Aparté', 'ﬁ Ⅻ ＃', '😀 emoji']) {
      expect(B.fromUtf8(B.utf8(s))).toBe(s)
    }
    expect([...B.utf8('é')]).toEqual([0xc3, 0xa9])
  })

  test('refuses a lone surrogate instead of replacing it', () => {
    expect(() => B.utf8('a\ud800b')).toThrow(InvalidInputError)
    expect(() => B.utf8('\udc00')).toThrow(InvalidInputError)
  })

  test('refuses invalid UTF-8 instead of replacing it', () => {
    expect(() => B.fromUtf8(new Uint8Array([0xc3]))).toThrow(InvalidInputError)
    expect(() => B.fromUtf8(new Uint8Array([0xff, 0xfe]))).toThrow(InvalidInputError)
  })
})

describe('base32', () => {
  // RFC 4648 section 10, lowercased and without padding.
  const rfc: [string, string][] = [
    ['', ''],
    ['f', 'my'],
    ['fo', 'mzxq'],
    ['foo', 'mzxw6'],
    ['foob', 'mzxw6yq'],
    ['fooba', 'mzxw6ytb'],
    ['foobar', 'mzxw6ytboi'],
  ]

  test.each(rfc)('RFC 4648 vector %p', (plain, encoded) => {
    expect(B.base32Encode(ascii(plain))).toBe(encoded)
    expect(B.base32Decode(encoded)).toEqual(ascii(plain))
  })

  test('ids: 16 bytes are 26 characters, 32 bytes are 52, and the last id character has zero low bits', () => {
    expect(B.base32Encode(new Uint8Array(16))).toBe('a'.repeat(26))
    expect(B.base32Encode(new Uint8Array(32))).toHaveLength(52)
    expect(B.base32Encode(new Uint8Array(16).fill(0x11))).toBe('ceirceirceirceirceirceirce')
    expect(B.base32Encode(Uint8Array.from({ length: 16 }, (_, i) => 0xf0 + i))).toBe('6dy7f47u6x3pp6hz7l57z7p674')
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 16, maxLength: 16 }), (id) => {
        expect('aeimquy4').toContain(B.base32Encode(id).charAt(25))
      }),
    )
  })

  test('encodes only the lowercase alphabet, and round trips any bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 80 }), (bytes) => {
        const text = B.base32Encode(bytes)
        expect(text).toMatch(/^[a-z2-7]*$/)
        expect(text).toHaveLength(Math.ceil((bytes.length * 8) / 5))
        expect(B.base32Decode(text)).toEqual(bytes)
      }),
    )
  })

  test.each(inputs.text.base32)('vector input %p round trips', (hex) => {
    const bytes = B.fromHex(hex)
    expect(B.base32Decode(B.base32Encode(bytes))).toEqual(bytes)
  })

  test.each(inputs.text.base32Invalid)('rejects %p', (text) => {
    expect(() => B.base32Decode(text)).toThrow(InvalidInputError)
  })

  test('rejects every non-canonical last character, so each byte string has one encoding', () => {
    // One byte is 2 characters; the second carries 3 data bits and 2 bits that must be zero.
    for (const c of 'abcdefghijklmnopqrstuvwxyz234567') {
      const value = 'abcdefghijklmnopqrstuvwxyz234567'.indexOf(c)
      if (value % 4 === 0) expect(B.base32Decode(`a${c}`)).toHaveLength(1)
      else expect(() => B.base32Decode(`a${c}`)).toThrow(InvalidInputError)
    }
  })
})

describe('base64url', () => {
  // RFC 4648 section 10, without padding.
  const rfc: [string, string][] = [
    ['', ''],
    ['f', 'Zg'],
    ['fo', 'Zm8'],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg'],
    ['fooba', 'Zm9vYmE'],
    ['foobar', 'Zm9vYmFy'],
  ]

  test.each(rfc)('RFC 4648 vector %p', (plain, encoded) => {
    expect(B.base64urlEncode(ascii(plain))).toBe(encoded)
    expect(B.base64urlDecode(encoded)).toEqual(ascii(plain))
  })

  test('uses - and _ where base64 uses + and /', () => {
    expect(B.base64urlEncode(new Uint8Array([0xfb, 0xff]))).toBe('-_8')
    expect(B.base64urlEncode(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe('-_-_')
    expect(B.base64urlEncode(new Uint8Array(16).fill(0x22))).toBe('IiIiIiIiIiIiIiIiIiIiIg')
  })

  test('round trips any bytes', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 80 }), (bytes) => {
        const text = B.base64urlEncode(bytes)
        expect(text).toMatch(/^[A-Za-z0-9_-]*$/)
        expect(B.base64urlDecode(text)).toEqual(bytes)
      }),
    )
  })

  test.each(inputs.text.base64url)('vector input %p round trips', (hex) => {
    const bytes = B.fromHex(hex)
    expect(B.base64urlDecode(B.base64urlEncode(bytes))).toEqual(bytes)
  })

  test.each(inputs.text.base64urlInvalid)('rejects %p', (text) => {
    expect(() => B.base64urlDecode(text)).toThrow(InvalidInputError)
  })
})

describe('hex', () => {
  test('round trips and is lowercase', () => {
    expect(B.toHex(new Uint8Array([0, 0xab, 0xff]))).toBe('00abff')
    expect(B.fromHex('00abff')).toEqual(new Uint8Array([0, 0xab, 0xff]))
  })

  test.each(['0', 'abc', 'zz', '0g', 'AB', ' 00'])('rejects %p', (hex) => {
    expect(() => B.fromHex(hex)).toThrow(InvalidInputError)
  })
})

describe('helpers', () => {
  test('concat, u32be and readU32be', () => {
    expect(B.concat(new Uint8Array([1]), new Uint8Array(), new Uint8Array([2, 3]))).toEqual(new Uint8Array([1, 2, 3]))
    expect(B.u32be(0x3e)).toEqual(new Uint8Array([0, 0, 0, 0x3e]))
    expect(B.u32be(0xfffffffe)).toEqual(new Uint8Array([0xff, 0xff, 0xff, 0xfe]))
    expect(B.readU32be(new Uint8Array([9, 0, 0, 1, 2]), 1)).toBe(258)
    expect(() => B.u32be(-1)).toThrow(RangeError)
    expect(() => B.u32be(2 ** 32)).toThrow(RangeError)
  })

  test('equal compares contents and lengths', () => {
    expect(B.equal(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(B.equal(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
    expect(B.equal(new Uint8Array([1, 2]), new Uint8Array([1, 2, 0]))).toBe(false)
    expect(B.equal(new Uint8Array(), new Uint8Array())).toBe(true)
  })

  test('returned bytes are backed by an ArrayBuffer', () => {
    expect(B.concat(new Uint8Array([1])).buffer).toBeInstanceOf(ArrayBuffer)
    expect(B.base32Decode('my').buffer).toBeInstanceOf(ArrayBuffer)
  })
})

describe('canonicalJson (RFC 8785)', () => {
  test('sorts members, drops whitespace and keeps integers plain', () => {
    expect(
      B.canonicalJson({
        v: 19,
        alg: 'argon2id',
        m: 19456,
        t: 2,
        p: 1,
        salt: 'IiIiIiIiIiIiIiIiIiIiIg',
        secretKey: true,
      }),
    ).toBe('{"alg":"argon2id","m":19456,"p":1,"salt":"IiIiIiIiIiIiIiIiIiIiIg","secretKey":true,"t":2,"v":19}')
    expect(B.canonicalJson({ b: [3, { y: null, x: false }], a: 'é"\\\n' })).toBe(
      '{"a":"é\\"\\\\\\n","b":[3,{"x":false,"y":null}]}',
    )
    expect(B.canonicalJson({ alg: 'recovery' })).toBe('{"alg":"recovery"}')
  })

  test('sorts by UTF-16 code units', () => {
    expect(B.canonicalJson({ b: 1, B: 2, a: 3, _: 4 })).toBe('{"B":2,"_":4,"a":3,"b":1}')
  })
})
