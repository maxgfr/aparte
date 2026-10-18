import type { GeneratedImage, PreparedImage } from '../../core/contracts/media.ts'
import type { BlobPort, Part } from '../../core/contracts/workspace.ts'
import { ImageError, type ImageErrorCode } from '../../core/media/image.ts'
import { preparePhoto, type SurfaceFactory } from '../../core/media/photo.ts'

/*
 * Photos added to a message: prepared on this device (core/media/photo.ts: downscaled, re-encoded, metadata removed),
 * stored as an encrypted blob, and referenced from the message by an `image` part. Only the prepared bytes are ever
 * stored or sent; the original file is never read again.
 */

/** The main-thread fallback surface, for engines without OffscreenCanvas: a detached DOM canvas. */
const domSurface: SurfaceFactory = (width, height) => {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new ImageError('unsupported', 'no 2D canvas')
  return {
    ctx,
    encode: (type, quality) =>
      new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new ImageError('decode', 'encode failed'))),
          type,
          quality,
        ),
      ),
  }
}

export type AttachFailure = ImageErrorCode | 'store'

/** A photo in the composer: being prepared, ready to send, or refused with a reason. */
export type Attachment =
  | { readonly key: string; readonly status: 'preparing'; readonly name: string }
  | {
      readonly key: string
      readonly status: 'ready'
      readonly name: string
      readonly part: Extract<Part, { type: 'image' }>
      /** An object URL of the prepared bytes, for the thumbnail; revoked when the attachment goes. */
      readonly preview: string
    }
  | { readonly key: string; readonly status: 'failed'; readonly name: string; readonly reason: AttachFailure }

/** Prepares and stores one photo; never throws, a failure is an attachment of status `failed`. */
export async function attachPhoto(file: File, key: string, blobs: BlobPort): Promise<Attachment> {
  const name = file.name
  let prepared: Awaited<ReturnType<typeof preparePhoto>>
  try {
    prepared = await preparePhoto(file, { fallback: domSurface })
  } catch (error) {
    return { key, status: 'failed', name, reason: error instanceof ImageError ? error.code : 'decode' }
  }
  let blob: string
  try {
    blob = await blobs.put(prepared.bytes, prepared.mediaType)
  } catch {
    return { key, status: 'failed', name, reason: 'store' }
  }
  const part: Extract<Part, { type: 'image' }> = {
    type: 'image',
    blob,
    mediaType: prepared.mediaType,
    width: prepared.width,
    height: prepared.height,
    ...(prepared.name === undefined ? {} : { name: prepared.name }),
  }
  const preview = URL.createObjectURL(new Blob([prepared.bytes], { type: prepared.mediaType }))
  return { key, status: 'ready', name, part, preview }
}

/** The image files among what was pasted or dropped. */
export function imageFiles(list: FileList | readonly File[] | null | undefined): File[] {
  if (!list) return []
  return [...list].filter((f) => f.type.startsWith('image/') || /\.(?:heic|heif)$/i.test(f.name))
}

/**
 * A provider's generated image, prepared as a photo is (downscaled, re-encoded, metadata such as provenance
 * manifests removed) before it is stored. Throws ImageError for bytes that are not an image this device decodes.
 */
export async function prepareGenerated(image: GeneratedImage): Promise<PreparedImage> {
  const file = new File([image.bytes], 'image', { type: image.mediaType })
  const prepared = await preparePhoto(file, { fallback: domSurface })
  return { bytes: prepared.bytes, mediaType: prepared.mediaType, width: prepared.width, height: prepared.height }
}

/** A shared photo, as a File the composer attaches (src/app/inbox.tsx hands them over). */
export function sharedFile(bytes: Uint8Array, name: string, type: string): File {
  return new File([new Uint8Array(bytes)], name, { type })
}
