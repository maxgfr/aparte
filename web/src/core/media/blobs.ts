/*
 * Encrypted content-addressed blobs on this device (spec/FORMAT.md sections 8.6, 9.3 and 9.4): the BlobPort the chat
 * stores photos and large parts through. A file is cut into 2 MiB chunks, each sealed as a kind-3 envelope under
 * `b/<h2>/<bid>`, and described by a manifest sealed as a kind-4 envelope under `m/<h2>/<mid>`; the manifest id is
 * what a message part references. Envelopes go to the LocalStore object mirror exactly as the remote will hold them,
 * so the sync layer uploads them unchanged.
 *
 * Invariants:
 * - Nothing readable is stored: every byte written is an envelope, and every name is a keyed hash of the content.
 * - The same bytes with the same media type always give the same manifest id (the manifest is serialized in writer
 *   order, spec/FORMAT.md section 3.4), so storing a file twice stores it once.
 * - A read verifies everything the manifest promises (each chunk's recomputed id, the total size, the file's SHA-256)
 *   and throws CorruptError otherwise; a missing envelope reads as null (not on this device yet).
 */

import { type Bytes, CorruptError, InvalidInputError, type Rng, type Subkeys } from '../contracts/crypto.ts'
import type { ObjectMirror } from '../contracts/store.ts'
import type { BlobPort } from '../contracts/workspace.ts'
import { base64urlEncode, concat, fromUtf8, utf8 } from '../crypto/bytes.ts'
import { MAX_CHUNK, openEnvelope, sealEnvelope } from '../crypto/envelope.ts'
import { sha256 } from '../crypto/keys.ts'
import { chunkId, chunkName, manifestId, manifestName } from '../crypto/names.ts'

/** Kind numbers of spec/FORMAT.md section 7.2. */
const KIND_CHUNK = 3
const KIND_MANIFEST = 4

/** A MIME type as the manifest records it: `type/subtype`, lowercase, no parameters. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/

/** The manifest of spec/FORMAT.md section 9.4, members in writer order. */
interface Manifest {
  readonly v: 1
  readonly type: string
  readonly size: number
  readonly sha256: string
  readonly chunks: readonly string[]
  readonly name?: string
}

export interface LocalBlobsDeps {
  readonly objects: ObjectMirror
  readonly subkeys: Subkeys
  readonly rng: Rng
}

export interface LocalBlobs extends BlobPort {
  /** The manifest's media type and size, or null when the manifest is not on this device. */
  info(id: string): Promise<{ readonly mediaType: string; readonly size: number } | null>
}

/** The chunks of a file: 2 MiB each, the last one shorter; none for an empty file. */
export function splitChunks(bytes: Uint8Array, size = MAX_CHUNK): Uint8Array[] {
  const out: Uint8Array[] = []
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, Math.min(bytes.length, at + size)))
  return out
}

/** The manifest bytes: `JSON.stringify` of an object built in the order section 9.4 lists its members. */
export function manifestBytes(m: Manifest): Bytes {
  const ordered: Manifest = {
    v: m.v,
    type: m.type,
    size: m.size,
    sha256: m.sha256,
    chunks: [...m.chunks],
    ...(m.name === undefined ? {} : { name: m.name }),
  }
  return utf8(JSON.stringify(ordered))
}

function parseManifest(bytes: Uint8Array): Manifest {
  let value: unknown
  try {
    value = JSON.parse(fromUtf8(bytes))
  } catch (cause) {
    throw new CorruptError('A blob manifest is not JSON', { cause })
  }
  const m = value as Partial<Record<keyof Manifest, unknown>> | null
  if (
    typeof m !== 'object' ||
    m === null ||
    m.v !== 1 ||
    typeof m.type !== 'string' ||
    typeof m.size !== 'number' ||
    !Number.isSafeInteger(m.size) ||
    m.size < 0 ||
    typeof m.sha256 !== 'string' ||
    !Array.isArray(m.chunks) ||
    !m.chunks.every((c) => typeof c === 'string') ||
    (m.name !== undefined && typeof m.name !== 'string')
  ) {
    throw new CorruptError('A blob manifest has the wrong shape')
  }
  const manifest: Manifest = {
    v: 1,
    type: m.type,
    size: m.size,
    sha256: m.sha256,
    chunks: m.chunks as string[],
    ...(m.name === undefined ? {} : { name: m.name as string }),
  }
  // The canonical-form check: a manifest with extra or reordered members was not written by this format.
  if (fromUtf8(manifestBytes(manifest)) !== fromUtf8(bytes)) throw new CorruptError('A blob manifest is not canonical')
  if (manifest.chunks.length !== Math.ceil(manifest.size / MAX_CHUNK)) {
    throw new CorruptError('A blob manifest lists the wrong number of chunks')
  }
  return manifest
}

/** A BlobPort over the LocalStore object mirror of an unlocked vault. */
export function createLocalBlobs(deps: LocalBlobsDeps): LocalBlobs {
  const { objects, subkeys, rng } = deps

  async function readManifest(id: string): Promise<Manifest | null> {
    let name: string
    try {
      name = manifestName(id)
    } catch {
      return null
    }
    const sealed = await objects.get(name)
    if (sealed === null) return null
    return parseManifest(await openEnvelope(subkeys, { kind: KIND_MANIFEST, name, bytes: sealed }))
  }

  return {
    async put(bytes, mediaType) {
      if (!MEDIA_TYPE.test(mediaType)) throw new InvalidInputError('A blob needs a media type such as image/jpeg')
      const ids: string[] = []
      for (const chunk of splitChunks(bytes)) {
        const id = await chunkId(subkeys, chunk)
        const name = chunkName(id)
        // Content addressed: a chunk already stored holds these very bytes.
        if ((await objects.get(name)) === null) {
          await objects.put(name, await sealEnvelope(subkeys, { kind: KIND_CHUNK, name, payload: chunk }, rng))
        }
        ids.push(id)
      }
      const manifest = manifestBytes({
        v: 1,
        type: mediaType,
        size: bytes.length,
        sha256: base64urlEncode(await sha256(bytes)),
        chunks: ids,
      })
      const id = await manifestId(subkeys, manifest)
      const name = manifestName(id)
      if ((await objects.get(name)) === null) {
        await objects.put(name, await sealEnvelope(subkeys, { kind: KIND_MANIFEST, name, payload: manifest }, rng))
      }
      return id
    },

    async get(id) {
      const manifest = await readManifest(id)
      if (manifest === null) return null
      const parts: Uint8Array[] = []
      for (const bid of manifest.chunks) {
        const name = chunkName(bid)
        const sealed = await objects.get(name)
        if (sealed === null) return null
        const chunk = await openEnvelope(subkeys, { kind: KIND_CHUNK, name, bytes: sealed })
        if ((await chunkId(subkeys, chunk)) !== bid) throw new CorruptError('A blob chunk does not match its id')
        parts.push(chunk)
      }
      const bytes = concat(...parts)
      if (bytes.length !== manifest.size) throw new CorruptError('A blob does not add up to its size')
      if (base64urlEncode(await sha256(bytes)) !== manifest.sha256) throw new CorruptError('A blob hash mismatch')
      return bytes
    },

    async info(id) {
      const manifest = await readManifest(id)
      return manifest === null ? null : { mediaType: manifest.type, size: manifest.size }
    },
  }
}
