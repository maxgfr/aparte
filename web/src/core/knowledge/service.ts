/*
 * The knowledge service of one unlocked session (KnowledgeService in web/src/core/contracts/knowledge.ts): ingestion
 * (detect, extract, chunk, embed, store encrypted, record in the workspace) and hybrid search over the bases.
 *
 * Invariants:
 * - The original file and the index are stored through the BlobPort (encrypted envelopes); the workspace entity only
 *   names them. Nothing is written for a file that cannot be read.
 * - Decrypted indexes and the passage indexes built from them live in memory only, for the session; `dispose` drops
 *   them, and every later call rejects.
 * - A document whose vectors come from another embedder than its base's current one is searched by keywords only
 *   until it is re-indexed; vectors of two embedders are never compared.
 * - An embedder that fails while a document is added does not lose the document: it is indexed for keywords, and the
 *   result says so (`embedded: false`).
 */
import { InvalidInputError, LockedError } from '../contracts/crypto.ts'
import {
  type DocumentFormat,
  type DocumentIndex,
  type EmbedderPort,
  ExtractError,
  type Extracted,
  type Hit,
  INDEX_MEDIA_TYPE,
  type IngestFile,
  type IngestOptions,
  type KnowledgeService,
} from '../contracts/knowledge.ts'
import type { Clock } from '../contracts/vault.ts'
import type {
  BlobPort,
  EmbedderRef,
  Id,
  KnowledgeBase,
  KnowledgeBases,
  KnowledgeDocument,
  KnowledgePassage,
} from '../contracts/workspace.ts'
import { chunkSections } from './chunk.ts'
import { knowledgePart } from './context.ts'
import { detectFormat, MEDIA_TYPES } from './extract.ts'
import { decodeIndex, encodeIndex, packVectors } from './indexFile.ts'
import { PassageIndex } from './retrieve.ts'

/** Passages embedded in one call, so progress moves and an abort is seen between calls. */
const EMBED_STEP = 32
/** The passages a user turn gets at most. */
export const CONTEXT_PASSAGES = 6

export interface KnowledgeDeps {
  readonly bases: KnowledgeBases
  readonly blobs: BlobPort
  /** Reads a document's text: PDF through pdf.js, the other formats in the knowledge worker. */
  readonly extract: (bytes: Uint8Array, format: DocumentFormat, signal?: AbortSignal) => Promise<Extracted>
  /** The embedder of a reference, or null when it cannot run on this device now (no key, unknown provider). */
  readonly embedder: (ref: EmbedderRef) => Promise<EmbedderPort | null>
  /** The key the vectors of a reference carry, without starting it. */
  readonly keyOf: (ref: EmbedderRef) => string
  readonly clock: Clock
}

const isAbort = (e: unknown): boolean =>
  (e instanceof Error || (typeof DOMException !== 'undefined' && e instanceof DOMException)) &&
  (e as Error).name === 'AbortError'

/** The id a citation names: the first 6 characters of the document's blob id and the 1-based chunk number. */
export function passageId(blob: string, n: number): string {
  return `${blob.slice(0, 6)}-${n}`
}

function passagesOf(base: KnowledgeBase, doc: KnowledgeDocument, index: DocumentIndex): KnowledgePassage[] {
  return index.chunks.map((c, i) => ({
    id: passageId(doc.blob, i + 1),
    base: base.id,
    document: doc.name,
    blob: doc.blob,
    ...(c.page === undefined ? {} : { page: c.page }),
    ...(c.heading === undefined ? {} : { heading: c.heading }),
    text: c.text,
  }))
}

export function createKnowledge(deps: KnowledgeDeps): KnowledgeService {
  let disposed = false
  const live = () => {
    if (disposed) throw new LockedError('The knowledge service is closed')
  }
  /** Decrypted document indexes, by index blob id. */
  const indexes = new Map<string, Promise<DocumentIndex | null>>()
  /** Passage indexes, by the signature of what they cover. */
  const corpora = new Map<string, PassageIndex>()

  const baseOf = (id: Id): KnowledgeBase => {
    const base = deps.bases.get(id)
    if (base === undefined || base.purgedAt !== undefined) throw new InvalidInputError('Unknown knowledge base')
    return base
  }

  const loadIndex = (blob: string): Promise<DocumentIndex | null> => {
    let p = indexes.get(blob)
    if (p === undefined) {
      p = deps.blobs.get(blob).then((bytes) => (bytes === null ? null : decodeIndex(bytes)))
      // An index not on this device yet (or unreadable) is asked for again next time.
      p.then(
        (v) => {
          if (v === null) indexes.delete(blob)
        },
        () => indexes.delete(blob),
      )
      indexes.set(blob, p)
    }
    return p
  }

  async function embedAll(
    port: EmbedderPort,
    texts: readonly string[],
    options: IngestOptions,
  ): Promise<{ dim: number; data: Float32Array }> {
    const out: Float32Array[] = []
    options.onProgress?.({ stage: 'embedding', done: 0, total: texts.length })
    for (let i = 0; i < texts.length; i += EMBED_STEP) {
      options.signal?.throwIfAborted()
      const part = texts.slice(i, i + EMBED_STEP)
      const vectors = await port.embed(part, options.signal)
      if (vectors.length !== part.length) throw new Error('The embedder returned the wrong number of vectors')
      out.push(...vectors)
      options.onProgress?.({ stage: 'embedding', done: out.length, total: texts.length })
    }
    return packVectors(out)
  }

  /** Embeds the chunks with the base's embedder; null vectors when it has none or it fails. */
  async function vectorsFor(
    base: KnowledgeBase,
    texts: readonly string[],
    options: IngestOptions,
  ): Promise<{ embedder: string | null; dim: number; vectors: Float32Array | null; error?: unknown }> {
    if (base.embedder === null || texts.length === 0) return { embedder: null, dim: 0, vectors: null }
    try {
      const port = await deps.embedder(base.embedder)
      if (port === null)
        return { embedder: null, dim: 0, vectors: null, error: new Error('No embedder on this device') }
      const { dim, data } = await embedAll(port, texts, options)
      return { embedder: port.key, dim, vectors: data }
    } catch (error) {
      if (isAbort(error) || options.signal?.aborted) throw error
      return { embedder: null, dim: 0, vectors: null, error }
    }
  }

  /** The passage index over the documents of these bases, built once per set of index blobs. */
  async function corpus(bases: readonly KnowledgeBase[]): Promise<PassageIndex> {
    const docs = bases.flatMap((b) => b.documents.filter((d) => d.index !== undefined).map((d) => ({ b, d })))
    const signature = docs.map(({ b, d }) => `${b.id}:${d.index}:${d.name}`).join('|')
    const cached = corpora.get(signature)
    if (cached) return cached
    const index = new PassageIndex()
    let complete = true
    for (const { b, d } of docs) {
      const file = await loadIndex(d.index as string)
      live()
      if (file === null) {
        complete = false
        continue
      }
      const vectors =
        file.embedder === null || file.vectors === null
          ? null
          : { key: file.embedder, dim: file.dim, data: file.vectors }
      index.add(passagesOf(b, d, file), vectors)
    }
    // A corpus missing a document this device does not have yet is rebuilt on the next search.
    if (complete) {
      if (corpora.size > 16) corpora.clear()
      corpora.set(signature, index)
    }
    return index
  }

  const service: KnowledgeService = {
    async ingest(baseId, file: IngestFile, options = {}) {
      live()
      const base = baseOf(baseId)
      const format = detectFormat(file.bytes, file.mediaType, file.name)
      if (format === null) throw new ExtractError('unsupported', 'This kind of file cannot be added')
      options.onProgress?.({ stage: 'extracting' })
      const extracted = await deps.extract(file.bytes, format, options.signal)
      live()
      const chunks = chunkSections(extracted.sections)
      if (chunks.length === 0) throw new ExtractError('empty', 'The document has no text')
      const embedded = await vectorsFor(
        base,
        chunks.map((c) => c.text),
        options,
      )
      live()
      options.signal?.throwIfAborted()
      options.onProgress?.({ stage: 'saving' })
      const index: DocumentIndex = {
        format,
        embedder: embedded.embedder,
        dim: embedded.dim,
        chunks,
        vectors: embedded.vectors,
      }
      const mediaType = MEDIA_TYPES[format]
      const blob = await deps.blobs.put(file.bytes, mediaType)
      const indexBlob = await deps.blobs.put(encodeIndex(index), INDEX_MEDIA_TYPE)
      live()
      indexes.set(indexBlob, Promise.resolve(index))
      const document: KnowledgeDocument = {
        blob,
        name:
          file.name.trim() === ''
            ? `document.${format === 'markdown' ? 'md' : format === 'text' ? 'txt' : format}`
            : file.name.trim(),
        mediaType,
        size: file.bytes.length,
        index: indexBlob,
        chunks: chunks.length,
        addedAt: Math.max(0, Math.floor(deps.clock.now())),
      }
      // The base may have been trashed meanwhile; the document is still added, and comes back with it.
      deps.bases.addDocument(base.id, document)
      return {
        document,
        embedded: embedded.vectors !== null,
        ...(embedded.error === undefined ? {} : { embedError: embedded.error }),
      }
    },

    async reindex(baseId, options = {}) {
      live()
      const base = baseOf(baseId)
      if (base.embedder === null) return 0
      const key = deps.keyOf(base.embedder)
      const port = await deps.embedder(base.embedder)
      if (port === null) throw new InvalidInputError('The embedder of this knowledge base cannot run on this device')
      let done = 0
      for (const doc of base.documents) {
        if (doc.index === undefined) continue
        const file = await loadIndex(doc.index)
        live()
        if (file === null || file.embedder === key) continue
        const { dim, data } = await embedAll(
          port,
          file.chunks.map((c) => c.text),
          options,
        )
        live()
        options.onProgress?.({ stage: 'saving' })
        const next: DocumentIndex = { ...file, embedder: port.key, dim, vectors: data }
        const indexBlob = await deps.blobs.put(encodeIndex(next), INDEX_MEDIA_TYPE)
        indexes.set(indexBlob, Promise.resolve(next))
        const current = deps.bases.get(base.id)?.documents.find((d) => d.blob === doc.blob)
        if (current !== undefined) deps.bases.addDocument(base.id, { ...current, index: indexBlob })
        done++
      }
      return done
    },

    async needsReindex(baseId) {
      live()
      const base = baseOf(baseId)
      if (base.embedder === null) return false
      const key = deps.keyOf(base.embedder)
      for (const doc of base.documents) {
        if (doc.index === undefined) continue
        const file = await loadIndex(doc.index).catch(() => null)
        if (file !== null && file.embedder !== key) return true
      }
      return false
    },

    async search(baseIds, query, options = {}) {
      live()
      const bases = [...new Set(baseIds)]
        .map((id) => deps.bases.get(id))
        .filter((b): b is KnowledgeBase => b !== undefined && b.deletedAt === undefined && b.purgedAt === undefined)
      if (bases.length === 0 || query.trim() === '') return []
      const index = await corpus(bases)
      live()
      if (index.size === 0) return []
      // One query vector per embedder some passage was embedded with and some base still uses.
      const vectors = new Map<string, Float32Array>()
      const have = index.keys()
      for (const base of bases) {
        if (base.embedder === null) continue
        const key = deps.keyOf(base.embedder)
        if (!have.has(key) || vectors.has(key)) continue
        try {
          const port = await deps.embedder(base.embedder)
          if (port === null) continue
          const [v] = await port.embed([query], options.signal)
          if (v !== undefined) vectors.set(port.key, v)
        } catch (error) {
          // Without the embedder now (offline, no key), the passages are still found by their keywords.
          if (isAbort(error) || options.signal?.aborted) throw error
        }
      }
      live()
      return index.search(query, vectors, Math.max(1, Math.min(20, options.limit ?? CONTEXT_PASSAGES)))
    },

    async context(baseIds, query, options = {}) {
      const hits: readonly Hit[] = await service.search(baseIds, query, options)
      return knowledgePart(
        query,
        hits.map((h) => h.passage),
      )
    },

    original(blob) {
      live()
      return deps.blobs.get(blob)
    },

    dispose() {
      disposed = true
      indexes.clear()
      corpora.clear()
    },
  }
  return service
}
