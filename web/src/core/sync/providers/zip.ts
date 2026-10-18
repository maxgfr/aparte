/*
 * A zip archive as a sync store, for export and import (`.aparte.zip`): every entry is one object of the store, byte
 * for byte under its name, plus a README. Exporting is a sync round into an empty archive; importing is a sync round
 * from one. The writer stores entries uncompressed (envelopes do not compress) with a fixed 1980-01-01 timestamp, so an
 * archive reveals nothing the store would not; the reader also accepts deflated entries (an archive repacked by a zip
 * tool) and checks every CRC-32.
 *
 * Limits: no ZIP64, so at most 65 535 entries and 4 GiB; a larger store is refused rather than written broken.
 */

import { type Bytes, CorruptError, InvalidInputError } from '../../contracts/crypto.ts'
import type { RemoteEntry, RemoteStore } from '../../contracts/sync.ts'
import { concat, utf8 } from '../../crypto/bytes.ts'
import { inflateRaw } from '../../crypto/envelope.ts'

export const ZIP_EXTENSION = '.aparte.zip'
export const ZIP_MEDIA_TYPE = 'application/zip'
/** Written at the root of every archive; not an object name, so a reader ignores it. */
export const ZIP_README = 'README.txt'
export const ZIP_README_TEXT = [
  'Aparte vault archive (aparte/1)',
  '',
  'Every entry is one object of an encrypted Aparte vault, stored byte for byte under its name:',
  '  fmt/1              format marker',
  '  keys/<slot>.json   keyslots (open the vault with its passphrase and Secret Key)',
  '  d/...              encrypted document segments and checkpoints',
  '  b/... and m/...    encrypted blob chunks and manifests (photos, files)',
  '',
  'Importing merges: objects already present are kept, so importing an old archive loses nothing.',
  '',
].join('\n')

const MAX_ENTRIES = 0xffff
const MAX_BYTES = 0xffffffff
/** 1980-01-01, the earliest DOS date: the archive carries no time. */
const DOS_DATE = 0x21
const DOS_TIME = 0

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function writer(size: number) {
  const buf = new Uint8Array(size)
  const view = new DataView(buf.buffer)
  let at = 0
  return {
    u16(v: number) {
      view.setUint16(at, v, true)
      at += 2
    },
    u32(v: number) {
      view.setUint32(at, v >>> 0, true)
      at += 4
    },
    bytes(b: Uint8Array) {
      buf.set(b, at)
      at += b.length
    },
    done: () => buf as Bytes,
  }
}

/** A stored (uncompressed) zip of `entries`, in the given order, UTF-8 names. */
export function writeZip(entries: readonly { readonly name: string; readonly bytes: Uint8Array }[]): Bytes {
  if (entries.length > MAX_ENTRIES) throw new InvalidInputError('Too many objects for one archive (65 535 at most)')
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const { name, bytes } of entries) {
    const n = utf8(name)
    const crc = crc32(bytes)
    const local = writer(30 + n.length)
    local.u32(0x04034b50)
    local.u16(20)
    local.u16(0x0800) // UTF-8 names
    local.u16(0) // stored
    local.u16(DOS_TIME)
    local.u16(DOS_DATE)
    local.u32(crc)
    local.u32(bytes.length)
    local.u32(bytes.length)
    local.u16(n.length)
    local.u16(0)
    local.bytes(n)
    const central = writer(46 + n.length)
    central.u32(0x02014b50)
    central.u16(20)
    central.u16(20)
    central.u16(0x0800)
    central.u16(0)
    central.u16(DOS_TIME)
    central.u16(DOS_DATE)
    central.u32(crc)
    central.u32(bytes.length)
    central.u32(bytes.length)
    central.u16(n.length)
    central.u16(0)
    central.u16(0)
    central.u16(0)
    central.u16(0)
    central.u32(0)
    central.u32(offset)
    central.bytes(n)
    const head = local.done()
    locals.push(head, bytes)
    centrals.push(central.done())
    offset += head.length + bytes.length
    if (offset > MAX_BYTES) throw new InvalidInputError('The archive would exceed 4 GiB')
  }
  const cd = concat(...centrals)
  const end = writer(22)
  end.u32(0x06054b50)
  end.u16(0)
  end.u16(0)
  end.u16(entries.length)
  end.u16(entries.length)
  end.u32(cd.length)
  end.u32(offset)
  end.u16(0)
  return concat(...locals, cd, end.done())
}

/** The entries of a zip (stored or deflated), each checked against its CRC-32; CorruptError otherwise. */
export async function readZip(zip: Uint8Array): Promise<Map<string, Bytes>> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new CorruptError('Not a zip archive')
  const count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)
  const out = new Map<string, Bytes>()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || view.getUint32(at, true) !== 0x02014b50) throw new CorruptError('Bad zip directory')
    const method = view.getUint16(at + 10, true)
    const crc = view.getUint32(at + 16, true)
    const csize = view.getUint32(at + 20, true)
    const usize = view.getUint32(at + 24, true)
    const nlen = view.getUint16(at + 28, true)
    const xlen = view.getUint16(at + 30, true)
    const clen = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    let name: string
    try {
      name = decoder.decode(zip.subarray(at + 46, at + 46 + nlen))
    } catch (cause) {
      throw new CorruptError('A zip entry name is not UTF-8', { cause })
    }
    at += 46 + nlen + xlen + clen
    if (name.endsWith('/')) continue
    if (local + 30 > zip.length || view.getUint32(local, true) !== 0x04034b50) throw new CorruptError('Bad zip entry')
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    if (start + csize > zip.length) throw new CorruptError('Truncated zip entry')
    const raw = zip.subarray(start, start + csize)
    let bytes: Bytes
    if (method === 0) bytes = new Uint8Array(raw) as Bytes
    else if (method === 8) bytes = await inflateRaw(raw, usize)
    else throw new CorruptError(`Unsupported zip compression method ${method}`)
    if (bytes.length !== usize || crc32(bytes) !== crc) throw new CorruptError(`Zip entry ${name} is damaged`)
    out.set(name, bytes)
  }
  return out
}

export interface ZipStore extends RemoteStore {
  /** The archive: the README, then every object, sorted by name. */
  toBytes(): Bytes
  readonly size: number
}

/** A store held in memory, written out as a zip; `from` starts it with the objects of an archive read before. */
export function zipStore(from: ReadonlyMap<string, Uint8Array> = new Map(), id = 'zip'): ZipStore {
  const objects = new Map<string, Bytes>()
  for (const [name, bytes] of from) if (name !== ZIP_README) objects.set(name, new Uint8Array(bytes) as Bytes)
  return {
    id,
    kind: 'zip',
    keepsHistory: false,
    get size() {
      return objects.size
    },
    async list(prefix = '') {
      return [...objects.keys()]
        .filter((n) => n.startsWith(prefix))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((name): RemoteEntry => ({ name, size: objects.get(name)?.length ?? 0 }))
    },
    async get(entry) {
      const v = objects.get(entry.name)
      return v === undefined ? null : (new Uint8Array(v) as Bytes)
    },
    async put(name, bytes) {
      objects.set(name, new Uint8Array(bytes) as Bytes)
    },
    async flush() {},
    async delete(name) {
      objects.delete(name)
    },
    toBytes() {
      const names = [...objects.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      return writeZip([
        { name: ZIP_README, bytes: utf8(ZIP_README_TEXT) },
        ...names.map((name) => ({ name, bytes: objects.get(name) as Bytes })),
      ])
    },
  }
}
