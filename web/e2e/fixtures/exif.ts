import type { Page } from '@playwright/test'

/*
 * A camera photo with its metadata: a real JPEG (drawn and encoded by the browser) with an EXIF segment added, the
 * way a phone writes it, carrying a GPS position and a canary string in the GPS map datum, the GPS area information
 * and the image description. A photo pipeline that copies bytes instead of re-encoding pixels lets the canary through.
 */

/** The identifier that opens an EXIF APP1 segment. */
export const EXIF_MARKER = Buffer.from('Exif\0\0', 'latin1')

/** A JPEG of `width` x `height` with a gradient, encoded by the page's canvas. */
export async function canvasJpeg(page: Page, width = 96, height = 64): Promise<Buffer> {
  const bytes = await page.evaluate(
    async ([w, h]) => {
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('No 2D canvas')
      const gradient = ctx.createLinearGradient(0, 0, w, h)
      gradient.addColorStop(0, '#2f6f4f')
      gradient.addColorStop(1, '#e8d9a8')
      ctx.fillStyle = gradient
      ctx.fillRect(0, 0, w, h)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
      if (!blob) throw new Error('The canvas did not encode a JPEG')
      return [...new Uint8Array(await blob.arrayBuffer())]
    },
    [width, height] as const,
  )
  return Buffer.from(bytes)
}

type Entry = { tag: number; type: number; count: number; data: Buffer }

const ASCII = 2
const SHORT = 3
const LONG = 4
const RATIONAL = 5
const UNDEFINED = 7
const BYTE = 1

const ascii = (s: string) => Buffer.from(`${s}\0`, 'latin1')

function rationals(values: readonly [number, number][]): Buffer {
  const b = Buffer.alloc(values.length * 8)
  values.forEach(([n, d], i) => {
    b.writeUInt32BE(n, i * 8)
    b.writeUInt32BE(d, i * 8 + 4)
  })
  return b
}

/** Writes one IFD at `offset` (from the TIFF header), its out-of-line values right after it. */
function ifd(entries: Entry[], offset: number): Buffer {
  const sorted = [...entries].sort((a, b) => a.tag - b.tag)
  const head = Buffer.alloc(2 + sorted.length * 12 + 4)
  head.writeUInt16BE(sorted.length, 0)
  const extra: Buffer[] = []
  let dataAt = offset + head.length
  sorted.forEach((e, i) => {
    const at = 2 + i * 12
    head.writeUInt16BE(e.tag, at)
    head.writeUInt16BE(e.type, at + 2)
    head.writeUInt32BE(e.count, at + 4)
    if (e.data.length <= 4) e.data.copy(head, at + 8)
    else {
      head.writeUInt32BE(dataAt, at + 8)
      const padded = e.data.length % 2 ? Buffer.concat([e.data, Buffer.alloc(1)]) : e.data
      extra.push(padded)
      dataAt += padded.length
    }
  })
  head.writeUInt32BE(0, head.length - 4)
  return Buffer.concat([head, ...extra])
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n)
  return b
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

/** The APP1 segment: TIFF big-endian, IFD0 (description, orientation, GPS pointer) and the GPS IFD. */
function exifSegment(canary: string): Buffer {
  const gpsEntries = (): Entry[] => [
    { tag: 0x0000, type: BYTE, count: 4, data: Buffer.from([2, 3, 0, 0]) },
    { tag: 0x0001, type: ASCII, count: 2, data: ascii('N') },
    {
      tag: 0x0002,
      type: RATIONAL,
      count: 3,
      data: rationals([
        [48, 1],
        [51, 1],
        [2964, 100],
      ]),
    },
    { tag: 0x0003, type: ASCII, count: 2, data: ascii('E') },
    {
      tag: 0x0004,
      type: RATIONAL,
      count: 3,
      data: rationals([
        [2, 1],
        [17, 1],
        [4008, 100],
      ]),
    },
    { tag: 0x0012, type: ASCII, count: canary.length + 1, data: ascii(canary) },
    {
      tag: 0x001c,
      type: UNDEFINED,
      count: 8 + canary.length,
      data: Buffer.concat([Buffer.from('ASCII\0\0\0', 'latin1'), Buffer.from(canary, 'latin1')]),
    },
  ]
  const description = `Taken at home ${canary}`
  const ifd0Entries = (gpsOffset: number): Entry[] => [
    { tag: 0x010e, type: ASCII, count: description.length + 1, data: ascii(description) },
    { tag: 0x0112, type: SHORT, count: 1, data: Buffer.concat([u16(1), Buffer.alloc(2)]) },
    { tag: 0x8825, type: LONG, count: 1, data: u32(gpsOffset) },
  ]
  // IFD0 is laid out once to learn its size, then again with the GPS IFD's real offset.
  const ifd0Size = ifd(ifd0Entries(0), 8).length
  const gpsOffset = 8 + ifd0Size
  const tiff = Buffer.concat([
    Buffer.from('MM', 'latin1'),
    u16(42),
    u32(8),
    ifd(ifd0Entries(gpsOffset), 8),
    ifd(gpsEntries(), gpsOffset),
  ])
  const payload = Buffer.concat([EXIF_MARKER, tiff])
  return Buffer.concat([Buffer.from([0xff, 0xe1]), u16(payload.length + 2), payload])
}

/** `jpeg` with the EXIF segment inserted after its JFIF header (or right after SOI when it has none). */
export function withGpsExif(jpeg: Buffer, canary: string): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Not a JPEG')
  let at = 2
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + jpeg.readUInt16BE(4)
  return Buffer.concat([jpeg.subarray(0, at), exifSegment(canary), jpeg.subarray(at)])
}

/** Every base64 payload inside a JSON value (plain or in a `data:` URL), decoded. */
export function decodedPayloads(value: unknown): Buffer[] {
  const out: Buffer[] = []
  const visit = (v: unknown) => {
    if (typeof v === 'string') {
      const data = /^data:[^,]*;base64,(.*)$/s.exec(v)
      const candidate = data ? (data[1] ?? '') : v
      if (candidate.length >= 64 && /^[A-Za-z0-9+/=_-]+$/.test(candidate))
        out.push(Buffer.from(candidate.replaceAll('-', '+').replaceAll('_', '/'), 'base64'))
    } else if (Array.isArray(v)) v.forEach(visit)
    else if (v && typeof v === 'object') Object.values(v).forEach(visit)
  }
  visit(value)
  return out
}

/** Whether `bytes` start like an image the app may send: JPEG, PNG or WebP. */
export function isImage(bytes: Buffer): boolean {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return true
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true
  return bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP'
}
