/*
 * What a photo becomes before it is stored or sent, as pure rules: the size limits, the longest side, which files are
 * accepted and which encoding the result takes. The pixels themselves are handled by photo.ts.
 */

/** Longest side of a prepared photo, in pixels. */
export const MAX_DIMENSION = 2048

/** Files above this size are refused before decoding (a phone photo is well below it). */
export const MAX_INPUT_BYTES = 50 * 1024 * 1024

/** The prepared photo must fit providers' per-image limit (Anthropic accepts 5 MB per image). */
export const MAX_OUTPUT_BYTES = 5 * 1000 * 1000

export const JPEG_QUALITY = 0.85
export const WEBP_QUALITY = 0.9

export type PreparedType = 'image/jpeg' | 'image/webp'

export type ImageErrorCode = 'too-large' | 'unsupported' | 'decode'

/** Why a photo could not be prepared; `code` decides what the interface says. */
export class ImageError extends Error {
  readonly code: ImageErrorCode
  constructor(code: ImageErrorCode, message: string) {
    super(message)
    this.name = 'ImageError'
    this.code = code
  }
}

const HEIC_TYPE = /^image\/hei[cf](?:-sequence)?$/i
const HEIC_NAME = /\.(?:heic|heif)$/i
const IMAGE_NAME = /\.(?:jpe?g|png|webp|gif|avif|bmp|heic|heif)$/i
/** Source types that may carry transparency, which JPEG cannot keep. */
const ALPHA_TYPE = /^image\/(?:png|webp|gif|avif)$/i
const ALPHA_NAME = /\.(?:png|webp|gif|avif)$/i

export interface FileLike {
  readonly type: string
  readonly size: number
  readonly name?: string
}

export function isHeic(file: FileLike): boolean {
  return HEIC_TYPE.test(file.type) || (typeof file.name === 'string' && HEIC_NAME.test(file.name))
}

/** A file the photo pipeline accepts: by type, or by name when the platform gives no type. */
export function isPhotoFile(file: FileLike): boolean {
  if (file.type.startsWith('image/') && file.type !== 'image/svg+xml') return true
  return file.type === '' && typeof file.name === 'string' && IMAGE_NAME.test(file.name)
}

/** Whether the source may be transparent: it is then encoded as WebP when the platform can, so it never turns black. */
export function mayHaveAlpha(file: FileLike): boolean {
  return ALPHA_TYPE.test(file.type) || (file.type === '' && typeof file.name === 'string' && ALPHA_NAME.test(file.name))
}

/** Width and height that fit inside `max` pixels on the longest side, never upscaled, at least 1 by 1. */
export function fitWithin(width: number, height: number, max = MAX_DIMENSION): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** Refuses a file before any decoding: too large, or not an image (SVG included: it is a document, not pixels). */
export function checkInput(file: FileLike): void {
  if (file.size > MAX_INPUT_BYTES) throw new ImageError('too-large', `image is ${file.size} bytes`)
  if (!isPhotoFile(file) && !isHeic(file)) throw new ImageError('unsupported', `unsupported type "${file.type}"`)
}

/** A display name without any directory part, at most 120 characters; undefined when there is none. */
export function cleanName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined
  const base = name.split(/[\\/]/).pop()?.trim() ?? ''
  if (base === '') return undefined
  return base.length > 120 ? base.slice(0, 120) : base
}

const SOI = 0xd8
const EOI = 0xd9
const SOS = 0xda
const COM = 0xfe
const APP0 = 0xe0
const APP2 = 0xe2
const APP14 = 0xee
const APP15 = 0xef

function startsWith(bytes: Uint8Array, at: number, ascii: string): boolean {
  if (at + ascii.length > bytes.length) return false
  for (let k = 0; k < ascii.length; k++) if (bytes[at + k] !== ascii.charCodeAt(k)) return false
  return true
}

/**
 * The JPEG without its metadata segments: every APPn segment (EXIF and XMP in APP1, IPTC in APP13...) and every
 * comment is dropped, except the three a decoder needs to show the same pixels: APP0 (JFIF), the ICC colour profile
 * in APP2 and the Adobe colour transform in APP14. Some canvas encoders (WebKit's among them) write their own EXIF
 * segment into the JPEG they produce, so a re-encode alone does not guarantee a file free of metadata. The scan stops
 * at the first start of scan, after which only entropy-coded data follows. ImageError `decode` for bytes that are not
 * a well-formed JPEG.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const bad = (what: string) => new ImageError('decode', `malformed JPEG: ${what}`)
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) throw bad('no start of image')
  const kept: Uint8Array[] = [bytes.subarray(0, 2)]
  let i = 2
  for (;;) {
    if (i >= bytes.length) throw bad('no start of scan')
    if (bytes[i] !== 0xff) throw bad(`no marker at ${i}`)
    // Any number of 0xFF fill bytes may precede a marker.
    let m = i + 1
    while (m < bytes.length && bytes[m] === 0xff) m++
    if (m >= bytes.length) throw bad('truncated marker')
    const marker = bytes[m] as number
    if (marker === EOI) throw bad('end of image before any scan')
    if (marker === SOS) {
      kept.push(bytes.subarray(i))
      break
    }
    if (m + 2 >= bytes.length) throw bad('truncated segment length')
    const length = ((bytes[m + 1] as number) << 8) | (bytes[m + 2] as number)
    const end = m + 1 + length
    if (length < 2 || end > bytes.length) throw bad(`segment 0x${marker.toString(16)} overruns the file`)
    const payload = m + 3
    const isApp = marker >= APP0 && marker <= APP15
    const keep =
      !(isApp || marker === COM) ||
      marker === APP0 ||
      (marker === APP2 && startsWith(bytes, payload, 'ICC_PROFILE\0')) ||
      (marker === APP14 && startsWith(bytes, payload, 'Adobe'))
    if (keep) kept.push(bytes.subarray(i, end))
    i = end
  }
  const out = new Uint8Array(kept.reduce((n, part) => n + part.length, 0))
  let at = 0
  for (const part of kept) {
    out.set(part, at)
    at += part.length
  }
  return out
}
