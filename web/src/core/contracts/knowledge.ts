/*
 * Contract of the knowledge bases (M7): documents the user adds, their text cut into passages, the encrypted search
 * index of each document, hybrid retrieval over it, and how retrieved passages reach a model and come back as
 * citations. Implemented by web/src/core/knowledge/*.ts:
 *
 *   xml.ts, zip.ts   bounded readers for Office files (no DTD, no zip bomb)
 *   extract.ts       detectFormat, extractText: DOCX, PPTX, HTML, Markdown and plain text
 *   pdfText.ts       extractPdf over an injected pdf.js
 *   chunk.ts         chunkSections: passages of about CHUNK_CHARS characters with an overlap
 *   indexFile.ts     encodeIndex, decodeIndex: the document index blob
 *   retrieve.ts      BM25 (MiniSearch) and cosine rankings fused by reciprocal rank
 *   context.ts       the anti-injection framing of passages, for the user turn and the tool result
 *   citations.ts     the passages a path offers and the citations an answer makes, validated
 *   embedders.ts     embeddings through a provider's API (OpenAI, Gemini, Mistral)
 *   service.ts       createKnowledge: ingestion and search for one unlocked session
 *   tool.ts          the `search_knowledge` tool (contracts/tools.ts)
 *
 * Invariants:
 * - Nothing readable is stored. The original file and the document's index (its passages and their vectors) are
 *   encrypted blobs (spec/FORMAT.md section 8.6); the knowledge base entity (its name, its documents' names and blob
 *   ids, its embedder) lives in the encrypted workspace index. Decrypted indexes are held in memory for the session
 *   only and dropped on lock.
 * - Retrieved text is data, never instructions: it reaches a model only inside the delimiters of context.ts, with
 *   any delimiter look-alike inside it neutralised, and with a rule telling the model so.
 * - Retrieved context goes into the user turn (a `knowledge` part of the user message), never into the system prompt:
 *   the frozen prefix of a conversation never changes (spec/DATA-MODEL.md section 5).
 * - A citation is shown only when the passage it names was given to the model on that branch; any other is dropped.
 * - Vectors are only compared when they come from the same embedder (`embedderKey`); otherwise a document is ranked
 *   by keywords alone.
 */
import type { Bytes } from './crypto.ts'
import type { EmbedderRef, Id, KnowledgeDocument, KnowledgePassage, Part } from './workspace.ts'

export type ExtractErrorKind = 'unsupported' | 'corrupt' | 'encrypted' | 'too-large' | 'unsafe' | 'empty'

/** A document that cannot be read: its format is not supported, it is damaged, locked, too large or has no text. */
export class ExtractError extends Error {
  constructor(
    readonly kind: ExtractErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'ExtractError'
  }
}

export type DocumentFormat = 'pdf' | 'docx' | 'pptx' | 'html' | 'markdown' | 'text'

/** A stretch of a document's text: a page of a PDF, a slide, the text under a heading. */
export interface Section {
  readonly text: string
  /** 1-based page (PDF) or slide (PPTX). */
  readonly page?: number
  /** The heading the text sits under (DOCX, Markdown, HTML) or the slide's title. */
  readonly heading?: string
}

export interface Extracted {
  readonly format: DocumentFormat
  readonly sections: readonly Section[]
}

/** One passage of a document, as indexed. */
export interface Chunk {
  readonly text: string
  readonly page?: number
  readonly heading?: string
}

/** The search index of one document, stored encrypted as its index blob (`INDEX_MEDIA_TYPE`). */
export interface DocumentIndex {
  readonly format: DocumentFormat
  /** The `embedderKey` of the vectors; null when the document has none (it is then found by keywords only). */
  readonly embedder: string | null
  /** Floats per vector; 0 without vectors. */
  readonly dim: number
  readonly chunks: readonly Chunk[]
  /** `chunks.length * dim` floats, one unit-length row per chunk; null without vectors. */
  readonly vectors: Float32Array | null
}

export const INDEX_MEDIA_TYPE = 'application/vnd.aparte.knowledge-index+json'

/** What turns texts into unit-length vectors: the local transformers.js worker or a provider's embeddings API. */
export interface EmbedderPort {
  /** Names the model the vectors come from; vectors of two different keys are never compared. */
  readonly key: string
  embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>
}

/** A passage found by a search, with its fused score and where it ranked by keywords and by meaning. */
export interface Hit {
  readonly passage: KnowledgePassage
  readonly score: number
  readonly keywordRank: number | null
  readonly vectorRank: number | null
}

export type IngestStage = 'extracting' | 'embedding' | 'saving'

export interface IngestProgress {
  readonly stage: IngestStage
  /** Passages embedded so far, during `embedding`. */
  readonly done?: number
  readonly total?: number
}

export interface IngestFile {
  readonly bytes: Uint8Array
  readonly name: string
  /** As the browser reported it; may be empty, the format is then detected from the name and the bytes. */
  readonly mediaType: string
}

export interface IngestOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: IngestProgress) => void
}

export interface IngestResult {
  readonly document: KnowledgeDocument
  /** False when the document was indexed for keywords only (no embedder, or the embedder failed: `embedError`). */
  readonly embedded: boolean
  readonly embedError?: unknown
}

export interface SearchOptions {
  /** At most this many passages (default 6). */
  readonly limit?: number
  readonly signal?: AbortSignal
}

/** Ingestion and retrieval over the knowledge bases of one unlocked session. */
export interface KnowledgeService {
  /**
   * Reads a file, cuts its text into passages, embeds them (when the base has an embedder that works now; otherwise
   * the document is indexed for keywords only), stores the original and the index as encrypted blobs and adds the
   * document to the base (replacing one with the same content). ExtractError when the file cannot be read.
   */
  ingest(base: Id, file: IngestFile, options?: IngestOptions): Promise<IngestResult>
  /** Embeds again every document of the base whose vectors come from another embedder, or have none. */
  reindex(base: Id, options?: IngestOptions): Promise<number>
  /** The best passages of these bases for `query`: keyword and vector rankings fused by reciprocal rank. */
  search(bases: readonly Id[], query: string, options?: SearchOptions): Promise<readonly Hit[]>
  /**
   * The `knowledge` part a user message gets (contracts/workspace.ts), the best passages of these bases for its text,
   * or null when there are none (no base, nothing related).
   */
  context(bases: readonly Id[], query: string, options?: SearchOptions): Promise<Part | null>
  /** Whether the base's documents all have vectors of its current embedder. */
  needsReindex(base: Id): Promise<boolean>
  /** The original file of a document, decrypted, or null when this device does not have it. */
  original(blob: string): Promise<Bytes | null>
  /** Drops every decrypted index held in memory (on lock). */
  dispose(): void
}

export type { EmbedderRef, KnowledgeDocument, KnowledgePassage }
