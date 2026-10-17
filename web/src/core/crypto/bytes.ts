/*
 * Byte strings and the text encodings of spec/FORMAT.md section 3. Every decoder is strict: a byte string has exactly
 * one accepted text form, so two implementations can never read the same text as different bytes.
 */
import { type Bytes, InvalidInputError, type JsonValue } from '../contracts/crypto.ts'

const encoder = new TextEncoder()
// `fatal` refuses invalid UTF-8 instead of substituting U+FFFD; `ignoreBOM` keeps a leading BOM as text, so decoding
// never drops bytes.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/** A lone surrogate is a code point of category Cs once the string is read as code points. */
const LONE_SURROGATE = /\p{Cs}/u

/** True when `text` has no lone surrogate. */
export function isWellFormed(text: string): boolean {
  return !LONE_SURROGATE.test(text)
}

export function utf8(text: string): Bytes {
  if (!isWellFormed(text)) throw new InvalidInputError('Text holds a lone surrogate')
  return encoder.encode(text)
}

export function fromUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes)
  } catch (cause) {
    throw new InvalidInputError('Invalid UTF-8', { cause })
  }
}

export function concat(...parts: readonly Uint8Array[]): Bytes {
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** A copy of `bytes` backed by its own ArrayBuffer. */
export function copy(bytes: Uint8Array): Bytes {
  const out = new Uint8Array(bytes.length)
  out.set(bytes)
  return out
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  // Every byte is visited and folded into one accumulator, so the time does not depend on where a difference is.
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export function u32be(n: number): Bytes {
  if (!Number.isInteger(n) || n < 0 || n >= 2 ** 32) throw new RangeError(`Not a u32: ${n}`)
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, n, false)
  return out
}

export function readU32be(bytes: Uint8Array, offset: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset + 4 > bytes.length) {
    throw new RangeError(`No u32 at offset ${offset}`)
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false)
}

const HEX = /^(?:[0-9a-f]{2})*$/

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

export function fromHex(hex: string): Bytes {
  if (!HEX.test(hex)) throw new InvalidInputError('Not lowercase hex of even length')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16)
  return out
}

// base32 (spec/FORMAT.md section 3.1)

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
const B32_VALUES = new Map([...B32].map((c, i) => [c, i]))

export function base32Encode(bytes: Uint8Array): string {
  let out = ''
  let buffer = 0
  let bits = 0
  for (const b of bytes) {
    buffer = ((buffer << 8) | b) & 0xffff
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += B32.charAt((buffer >> bits) & 31)
    }
  }
  if (bits > 0) out += B32.charAt((buffer << (5 - bits)) & 31)
  return out
}

export function base32Decode(text: string): Bytes {
  // A remainder of 1, 3 or 6 characters cannot end on a byte boundary with fewer than 5 unused bits.
  const rest = text.length % 8
  if (rest === 1 || rest === 3 || rest === 6) throw new InvalidInputError('Invalid base32 length')
  const out = new Uint8Array(Math.floor((text.length * 5) / 8))
  let buffer = 0
  let bits = 0
  let o = 0
  for (const c of text) {
    const value = B32_VALUES.get(c)
    if (value === undefined) throw new InvalidInputError('Invalid base32 character')
    buffer = ((buffer << 5) | value) & 0xffff
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out[o++] = (buffer >> bits) & 0xff
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) throw new InvalidInputError('Non-zero trailing base32 bits')
  return out
}

// base64url (spec/FORMAT.md section 3.2)

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64_VALUES = new Map([...B64].map((c, i) => [c, i]))

export function base64urlEncode(bytes: Uint8Array): string {
  let out = ''
  let buffer = 0
  let bits = 0
  for (const b of bytes) {
    buffer = ((buffer << 8) | b) & 0xffff
    bits += 8
    while (bits >= 6) {
      bits -= 6
      out += B64.charAt((buffer >> bits) & 63)
    }
  }
  if (bits > 0) out += B64.charAt((buffer << (6 - bits)) & 63)
  return out
}

export function base64urlDecode(text: string): Bytes {
  if (text.length % 4 === 1) throw new InvalidInputError('Invalid base64url length')
  const out = new Uint8Array(Math.floor((text.length * 6) / 8))
  let buffer = 0
  let bits = 0
  let o = 0
  for (const c of text) {
    const value = B64_VALUES.get(c)
    if (value === undefined) throw new InvalidInputError('Invalid base64url character')
    buffer = ((buffer << 6) | value) & 0xffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (buffer >> bits) & 0xff
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) throw new InvalidInputError('Non-zero trailing base64url bits')
  return out
}

// Canonical JSON (spec/FORMAT.md section 3.3)

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new InvalidInputError('Canonical JSON takes safe integers only')
    // JSON.stringify writes -0 as 0, as RFC 8785 requires.
    return JSON.stringify(value)
  }
  if (typeof value === 'string') {
    if (!isWellFormed(value)) throw new InvalidInputError('Text holds a lone surrogate')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item: JsonValue) => canonicalJson(item)).join(',')}]`
  const object = value as { readonly [key: string]: JsonValue }
  // The default sort compares UTF-16 code units, which is the order RFC 8785 prescribes.
  const keys = Object.keys(object).sort()
  const members = keys.map((key) => {
    if (!isWellFormed(key)) throw new InvalidInputError('Text holds a lone surrogate')
    return `${JSON.stringify(key)}:${canonicalJson(object[key] as JsonValue)}`
  })
  return `{${members.join(',')}}`
}

/** Overwrites `bytes` with zeros; used on every transient copy of secret material. */
export function zero(...arrays: readonly (Uint8Array | null | undefined)[]): void {
  // A buffer transferred to a worker is detached (byteLength 0): nothing is left to clear and fill() would throw.
  for (const bytes of arrays) if (bytes && bytes.buffer.byteLength > 0) bytes.fill(0)
}
