/*
 * A bounded reader of the ZIP archives Office files are (DOCX, PPTX). It reads the central directory, then inflates
 * one part at a time with fflate's synchronous inflater, in small steps, so a part that inflates beyond its declared
 * size (a lying header, a zip bomb) is refused while it is read, and the whole archive is capped too.
 */
import { Inflate } from 'fflate'
import { ExtractError } from '../contracts/knowledge.ts'

export interface ZipLimits {
  /** Entries in the central directory. */
  readonly maxEntries: number
  /** One inflated part. */
  readonly maxPartBytes: number
  /** Every part inflated, together. */
  readonly maxTotalBytes: number
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxPartBytes: 32 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
}

interface Entry {
  readonly name: string
  readonly method: number
  readonly flags: number
  readonly compressedSize: number
  readonly size: number
  readonly localOffset: number
}

const u16 = (d: Uint8Array, o: number): number => (d[o] ?? 0) | ((d[o + 1] ?? 0) << 8)
const u32 = (d: Uint8Array, o: number): number => (u16(d, o) | (u16(d, o + 2) << 16)) >>> 0

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const ZIP64 = 0xffffffff
/** Compressed bytes handed to the inflater at a time: bounds what one step can produce. */
const STEP = 4096

/** Whether the bytes start like a ZIP archive. */
export function isZip(data: Uint8Array): boolean {
  return u32(data, 0) === LOCAL
}

/** Inflates exactly `expected` bytes: more (a lying header, a bomb) or fewer (truncation) is an error. */
function inflateBounded(raw: Uint8Array, expected: number, name: string): Uint8Array {
  const out = new Uint8Array(expected)
  let total = 0
  let done = false
  const inflater = new Inflate((chunk, final) => {
    if (total + chunk.length > expected) throw new ExtractError('too-large', `${name} inflates beyond its size`)
    out.set(chunk, total)
    total += chunk.length
    if (final) done = true
  })
  try {
    if (raw.length === 0) inflater.push(raw, true)
    for (let p = 0; p < raw.length; p += STEP) inflater.push(raw.subarray(p, p + STEP), p + STEP >= raw.length)
  } catch (cause) {
    if (cause instanceof ExtractError) throw cause
    throw new ExtractError('corrupt', `Cannot inflate ${name}`)
  }
  if (!done || total !== expected) throw new ExtractError('corrupt', `Size mismatch in ${name}`)
  return out
}

/** Parts of an archive by name (matched case-insensitively, as OOXML requires), inflated on demand. */
export class ZipReader {
  private readonly entries = new Map<string, Entry>()
  private inflated = 0

  constructor(
    private readonly data: Uint8Array,
    private readonly limits: ZipLimits = DEFAULT_ZIP_LIMITS,
  ) {
    let eocd = -1
    const floor = Math.max(0, data.length - 22 - 0xffff)
    for (let i = data.length - 22; i >= floor; i--) {
      if (u32(data, i) === EOCD) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new ExtractError('corrupt', 'Not a readable archive')
    const count = u16(data, eocd + 10)
    const dirOffset = u32(data, eocd + 16)
    if (count === 0xffff || dirOffset === ZIP64) throw new ExtractError('unsupported', 'ZIP64 archives are not read')
    if (count > limits.maxEntries) throw new ExtractError('too-large', `The archive has ${count} entries`)
    let o = dirOffset
    for (let n = 0; n < count; n++) {
      if (o + 46 > data.length || u32(data, o) !== CENTRAL) throw new ExtractError('corrupt', 'Damaged archive')
      const nameLen = u16(data, o + 28)
      const extraLen = u16(data, o + 30)
      const commentLen = u16(data, o + 32)
      if (o + 46 + nameLen > data.length) throw new ExtractError('corrupt', 'Damaged archive')
      const name = new TextDecoder().decode(data.subarray(o + 46, o + 46 + nameLen))
      const entry: Entry = {
        name,
        flags: u16(data, o + 8),
        method: u16(data, o + 10),
        compressedSize: u32(data, o + 20),
        size: u32(data, o + 24),
        localOffset: u32(data, o + 42),
      }
      if (entry.compressedSize === ZIP64 || entry.size === ZIP64 || entry.localOffset === ZIP64) {
        throw new ExtractError('unsupported', 'ZIP64 archives are not read')
      }
      this.entries.set(name.replace(/^\/+/, '').toLowerCase(), entry)
      o += 46 + nameLen + extraLen + commentLen
    }
  }

  has(name: string): boolean {
    return this.entries.has(name.toLowerCase())
  }

  /** Part names, as stored. */
  names(): string[] {
    return [...this.entries.values()].map((e) => e.name)
  }

  /** A part's bytes, inflated; null when absent. */
  read(name: string): Uint8Array | null {
    const e = this.entries.get(name.toLowerCase())
    if (!e) return null
    if (e.flags & 1) throw new ExtractError('encrypted', 'The document is password-protected')
    if (e.size > this.limits.maxPartBytes) throw new ExtractError('too-large', `${e.name} is too large`)
    if (this.inflated + e.size > this.limits.maxTotalBytes)
      throw new ExtractError('too-large', 'The archive is too large')
    const d = this.data
    const lo = e.localOffset
    if (lo + 30 > d.length || u32(d, lo) !== LOCAL) throw new ExtractError('corrupt', `Damaged entry ${e.name}`)
    const start = lo + 30 + u16(d, lo + 26) + u16(d, lo + 28)
    const end = start + e.compressedSize
    if (end > d.length) throw new ExtractError('corrupt', `Truncated entry ${e.name}`)
    const raw = d.subarray(start, end)
    let out: Uint8Array
    if (e.method === 0) {
      if (e.compressedSize !== e.size) throw new ExtractError('corrupt', `Size mismatch in ${e.name}`)
      out = raw.slice()
    } else if (e.method === 8) {
      out = inflateBounded(raw, e.size, e.name)
    } else {
      throw new ExtractError('unsupported', `${e.name} uses compression method ${e.method}`)
    }
    this.inflated += out.length
    return out
  }

  /** A part as UTF-8 text; null when absent. */
  text(name: string): string | null {
    const bytes = this.read(name)
    return bytes === null ? null : new TextDecoder().decode(bytes)
  }
}
