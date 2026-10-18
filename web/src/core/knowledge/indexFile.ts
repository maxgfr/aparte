/*
 * The index blob of a knowledge base document (media type INDEX_MEDIA_TYPE): its passages and their vectors, as
 * UTF-8 JSON, stored encrypted like every blob (core/media/blobs.ts). Vectors are little-endian float32 rows, base64url.
 *
 *   {"v": 1, "format": "pdf", "embedder": "local:Xenova/all-MiniLM-L6-v2@751bff3", "dim": 384,
 *    "chunks": [{"text": "...", "page": 3, "heading": "..."}], "vectors": "<base64url>"}
 *
 * `embedder` and `vectors` are null for a document indexed for keywords only. A reader refuses anything else
 * (CorruptError): an index is never repaired or guessed at.
 */
import { type Bytes, CorruptError } from '../contracts/crypto.ts'
import type { Chunk, DocumentFormat, DocumentIndex } from '../contracts/knowledge.ts'
import { base64urlDecode, base64urlEncode, fromUtf8, utf8 } from '../crypto/bytes.ts'

const FORMATS: ReadonlySet<string> = new Set<DocumentFormat>(['pdf', 'docx', 'pptx', 'html', 'markdown', 'text'])

/** Rows of unit-length vectors as little-endian float32 bytes. */
export function vectorBytes(vectors: Float32Array): Bytes {
  const out = new Uint8Array(vectors.length * 4)
  const view = new DataView(out.buffer)
  for (let i = 0; i < vectors.length; i++) view.setFloat32(i * 4, vectors[i] as number, true)
  return out as Bytes
}

function vectorsOf(bytes: Uint8Array): Float32Array {
  if (bytes.length % 4 !== 0) throw new CorruptError('An index has a partial vector')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out = new Float32Array(bytes.length / 4)
  for (let i = 0; i < out.length; i++) {
    const v = view.getFloat32(i * 4, true)
    if (!Number.isFinite(v)) throw new CorruptError('An index holds a vector that is not finite')
    out[i] = v
  }
  return out
}

/** Packs one vector per chunk into the rows of a document index. */
export function packVectors(vectors: readonly Float32Array[]): { dim: number; data: Float32Array } {
  const dim = vectors[0]?.length ?? 0
  const data = new Float32Array(vectors.length * dim)
  vectors.forEach((v, i) => {
    if (v.length !== dim) throw new RangeError('Vectors of different dimensions')
    data.set(v, i * dim)
  })
  return { dim, data }
}

export function encodeIndex(index: DocumentIndex): Bytes {
  const chunks = index.chunks.map((c) => ({
    text: c.text,
    ...(c.page === undefined ? {} : { page: c.page }),
    ...(c.heading === undefined ? {} : { heading: c.heading }),
  }))
  const hasVectors = index.vectors !== null && index.embedder !== null
  if (hasVectors && (index.vectors as Float32Array).length !== index.chunks.length * index.dim) {
    throw new RangeError('One vector per chunk')
  }
  return utf8(
    JSON.stringify({
      v: 1,
      format: index.format,
      embedder: hasVectors ? index.embedder : null,
      dim: hasVectors ? index.dim : 0,
      chunks,
      vectors: hasVectors ? base64urlEncode(vectorBytes(index.vectors as Float32Array)) : null,
    }),
  )
}

function chunkOf(value: unknown): Chunk {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CorruptError('A bad chunk')
  const c = value as Record<string, unknown>
  if (typeof c.text !== 'string') throw new CorruptError('A chunk without text')
  if (c.page !== undefined && !(Number.isSafeInteger(c.page) && (c.page as number) > 0)) {
    throw new CorruptError('A chunk with a bad page')
  }
  if (c.heading !== undefined && typeof c.heading !== 'string') throw new CorruptError('A chunk with a bad heading')
  return {
    text: c.text,
    ...(c.page === undefined ? {} : { page: c.page as number }),
    ...(c.heading === undefined ? {} : { heading: c.heading as string }),
  }
}

export function decodeIndex(bytes: Uint8Array): DocumentIndex {
  let value: unknown
  try {
    value = JSON.parse(fromUtf8(bytes))
  } catch (cause) {
    throw new CorruptError('A knowledge index is not JSON', { cause })
  }
  const v = value as Record<string, unknown> | null
  if (v === null || typeof v !== 'object' || v.v !== 1) throw new CorruptError('Not a knowledge index')
  if (typeof v.format !== 'string' || !FORMATS.has(v.format)) throw new CorruptError('An index of no known format')
  if (!Array.isArray(v.chunks)) throw new CorruptError('An index without chunks')
  const chunks = v.chunks.map(chunkOf)
  if (v.embedder === null || v.vectors === null) {
    return { format: v.format as DocumentFormat, embedder: null, dim: 0, chunks, vectors: null }
  }
  if (typeof v.embedder !== 'string' || typeof v.vectors !== 'string') throw new CorruptError('Bad index vectors')
  if (!Number.isSafeInteger(v.dim) || (v.dim as number) <= 0) throw new CorruptError('Bad index dimension')
  let raw: Uint8Array
  try {
    raw = base64urlDecode(v.vectors)
  } catch (cause) {
    throw new CorruptError('Bad index vectors', { cause })
  }
  const vectors = vectorsOf(raw)
  if (vectors.length !== chunks.length * (v.dim as number)) throw new CorruptError('An index has the wrong vectors')
  return { format: v.format as DocumentFormat, embedder: v.embedder, dim: v.dim as number, chunks, vectors }
}
