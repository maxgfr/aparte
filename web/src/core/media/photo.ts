/*
 * Photo preparation on this device (ported from cursus `preparePhoto`): decode with the camera's orientation applied,
 * downscale to 2048 px on the longest side, and re-encode as JPEG (or WebP for a source that may be transparent).
 * A canvas re-encode writes pixels only, and the metadata segments an encoder may add are then removed from the JPEG
 * (stripJpegMetadata), so the camera's metadata (EXIF, GPS location, maker notes) never reaches the store or a
 * provider.
 *
 * The work runs in a module worker (photo.worker.ts) with an OffscreenCanvas, started through
 * web/src/security/workers.ts; where a worker or OffscreenCanvas is missing it runs on the main thread, on the
 * surface the caller provides. Like argon2.ts, the worker modules are imported dynamically, on the worker path only,
 * so this module loads without a DOM and under `bun test`.
 */

import type { Bytes } from '../contracts/crypto.ts'
import {
  checkInput,
  cleanName,
  type FileLike,
  fitWithin,
  ImageError,
  type ImageErrorCode,
  isHeic,
  JPEG_QUALITY,
  MAX_OUTPUT_BYTES,
  mayHaveAlpha,
  type PreparedType,
  stripJpegMetadata,
  WEBP_QUALITY,
} from './image.ts'

export interface PreparedPhoto {
  readonly bytes: Bytes
  readonly mediaType: PreparedType
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** A 2D drawing surface and its encoder: an OffscreenCanvas, or a DOM canvas on the main-thread fallback. */
export interface Surface {
  readonly ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
  encode(type: PreparedType, quality: number): Promise<Blob>
}

export type SurfaceFactory = (width: number, height: number) => Surface

/** The OffscreenCanvas surface; null where the platform has none or no 2D context for it. */
export function offscreenSurface(width: number, height: number): Surface | null {
  if (typeof OffscreenCanvas === 'undefined') return null
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (ctx === null) return null
  return { ctx, encode: (type, quality) => canvas.convertToBlob({ type, quality }) }
}

/** Lower qualities tried, in order, when an encoding is still above the provider limit. */
const FALLBACK_QUALITIES = [0.7, 0.55] as const

async function decode(file: Blob, described: FileLike): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch (cause) {
    // A HEIC photo this browser cannot decode (Chrome, Firefox) is said as such, with what to do.
    throw new ImageError(isHeic(described) ? 'unsupported' : 'decode', `cannot decode image: ${String(cause)}`)
  }
}

async function draw(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  type: PreparedType,
  quality: number,
  surface: SurfaceFactory,
): Promise<Blob> {
  const s = surface(width, height)
  s.ctx.imageSmoothingEnabled = true
  s.ctx.imageSmoothingQuality = 'high'
  if (type === 'image/jpeg') {
    // JPEG has no transparency: a transparent screenshot lands on white, not black.
    s.ctx.fillStyle = '#ffffff'
    s.ctx.fillRect(0, 0, width, height)
  }
  s.ctx.drawImage(bitmap, 0, 0, width, height)
  return s.encode(type, quality)
}

/**
 * Prepares a photo on the current thread. Throws ImageError: `too-large` above the input limit or when no quality
 * fits the output limit, `unsupported` for a type the pipeline refuses (or a HEIC the platform cannot decode),
 * `decode` for a damaged file.
 */
export async function encodePhoto(
  file: Blob & { readonly name?: string },
  surface: SurfaceFactory,
  givenName: string | undefined = file.name,
): Promise<PreparedPhoto> {
  const described = { type: file.type, size: file.size, ...(givenName === undefined ? {} : { name: givenName }) }
  checkInput(described)
  const bitmap = await decode(file, described)
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height)
    const name = cleanName(givenName)
    const done = async (blob: Blob, mediaType: PreparedType): Promise<PreparedPhoto> => {
      const encoded = new Uint8Array(await blob.arrayBuffer())
      return {
        // The encoder may add an EXIF segment of its own (WebKit does): only the pixels and what decodes them stay.
        bytes: mediaType === 'image/jpeg' ? stripJpegMetadata(encoded) : encoded,
        mediaType,
        width,
        height,
        ...(name === undefined ? {} : { name }),
      }
    }
    if (mayHaveAlpha(described)) {
      const webp = await draw(bitmap, width, height, 'image/webp', WEBP_QUALITY, surface)
      // An encoder without WebP silently returns PNG: then the photo goes the JPEG way below.
      if (webp.type === 'image/webp' && webp.size <= MAX_OUTPUT_BYTES) return done(webp, 'image/webp')
    }
    for (const quality of [JPEG_QUALITY, ...FALLBACK_QUALITIES]) {
      const jpeg = await draw(bitmap, width, height, 'image/jpeg', quality, surface)
      if (jpeg.size <= MAX_OUTPUT_BYTES) return done(jpeg, 'image/jpeg')
    }
    throw new ImageError('too-large', 'no JPEG quality fits the output limit')
  } finally {
    bitmap.close()
  }
}

// The worker protocol.

export interface PhotoRequest {
  readonly file: Blob
  readonly name?: string
}

export type PhotoResponse =
  | {
      readonly ok: true
      readonly bytes: Bytes
      readonly mediaType: PreparedType
      readonly width: number
      readonly height: number
      readonly name?: string
    }
  | { readonly ok: false; readonly code: ImageErrorCode | 'no-canvas' | null; readonly message: string }

/** Runs `encodePhoto` for a worker request; never throws. */
export async function answerPhotoRequest(request: PhotoRequest): Promise<PhotoResponse> {
  try {
    const surface: SurfaceFactory = (w, h) => {
      const s = offscreenSurface(w, h)
      if (s === null) throw new NoCanvasError()
      return s
    }
    const photo = await encodePhoto(request.file, surface, request.name)
    return { ok: true, ...photo }
  } catch (error) {
    const code = error instanceof ImageError ? error.code : error instanceof NoCanvasError ? 'no-canvas' : null
    return { ok: false, code, message: error instanceof Error ? error.message : String(error) }
  }
}

class NoCanvasError extends Error {
  constructor() {
    super('OffscreenCanvas has no 2D context here')
  }
}

/** True only under Bun (the test runtime), which cannot load a Vite worker chunk. */
const inProcess = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'

/** Whether the worker path can work here: a Worker, an OffscreenCanvas and createImageBitmap. */
function workerCapable(): boolean {
  return (
    !inProcess &&
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap !== 'undefined'
  )
}

async function inWorker(file: Blob & { readonly name?: string }): Promise<PhotoResponse> {
  const [{ createWorker }, { default: url }] = await Promise.all([
    import('../../security/workers.ts'),
    import('./photo.worker.ts?worker&url'),
  ])
  const worker = createWorker(url, { name: 'photo' })
  try {
    return await new Promise<PhotoResponse>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<PhotoResponse>) => resolve(event.data)
      worker.onerror = (event: ErrorEvent) => {
        event.preventDefault()
        reject(new Error(`Photo worker failed: ${event.message}`))
      }
      worker.onmessageerror = () => reject(new Error('Photo worker sent an unreadable message'))
      const request: PhotoRequest = file.name === undefined ? { file } : { file, name: file.name }
      worker.postMessage(request)
    })
  } finally {
    worker.terminate()
  }
}

/**
 * Prepares a photo for storing and sending: in a worker when the platform allows it, else on this thread with an
 * OffscreenCanvas, else on `fallback` (a DOM canvas the interface provides). Throws ImageError.
 */
export async function preparePhoto(
  file: Blob & { readonly name?: string },
  options: { readonly fallback?: SurfaceFactory } = {},
): Promise<PreparedPhoto> {
  checkInput({ type: file.type, size: file.size, ...(file.name === undefined ? {} : { name: file.name }) })
  if (workerCapable()) {
    try {
      const response = await inWorker(file)
      if (response.ok) {
        const { ok: _ok, ...photo } = response
        return photo
      }
      if (response.code !== 'no-canvas' && response.code !== null) throw new ImageError(response.code, response.message)
    } catch (error) {
      if (error instanceof ImageError) throw error
      // The worker could not run (blocked, or an engine without OffscreenCanvas 2D in workers): this thread does it.
    }
  }
  const surface: SurfaceFactory = (w, h) => {
    const s = offscreenSurface(w, h) ?? options.fallback?.(w, h) ?? null
    if (s === null) throw new ImageError('unsupported', 'no canvas to draw the photo on')
    return s
  }
  return encodePhoto(file, surface)
}
