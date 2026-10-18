/*
 * The knowledge bases of an unlocked session, wired to this page: pdf.js (pinned, loaded on first PDF, given its
 * worker as a `workerPort` made through web/src/security/workers.ts), the knowledge worker for the other formats, the
 * local embedding worker (app/local.ts) and the providers' embeddings APIs (with the keys of this device). Loaded with
 * the session, never with the first paint; pdf.js and the workers are chunks of their own, fetched only when used and
 * never precached.
 */
import { providerFetch } from '../core/ai/fetch.ts'
import type { ProviderKeys } from '../core/contracts/ai.ts'
import type { DocumentFormat, EmbedderPort, Extracted, KnowledgeService } from '../core/contracts/knowledge.ts'
import type { Clock } from '../core/contracts/vault.ts'
import type { BlobPort, EmbedderRef, Workspace } from '../core/contracts/workspace.ts'
import { createApiEmbedder, EMBEDDING_MODELS, embeddingKind, providerEmbedderKey } from '../core/knowledge/embedders.ts'
import { extractPdf, type PdfJsLike, type PdfRuntime } from '../core/knowledge/pdfText.ts'
import { createKnowledge } from '../core/knowledge/service.ts'
import { connectExtractor, type ExtractWorkerLike, type WorkerExtractor } from '../core/knowledge/worker.ts'
import { createWorker } from '../security/workers.ts'
import pins from '../workers/embedding-pins.json'
import knowledgeWorkerUrl from '../workers/knowledge.worker.ts?worker&url'
import pdfWorkerUrl from '../workers/pdf.worker.ts?worker&url'
import { localEmbedder } from './local.ts'

/** The embedder a new knowledge base starts with: the pinned on-device model. */
export const LOCAL_EMBEDDER: EmbedderRef = { kind: 'local', model: pins.repo }

/** What the on-device model's vectors are named by: its repository at the pinned commit. */
export const LOCAL_EMBEDDER_KEY = `local:${pins.repo}@${pins.commit}`

export { EMBEDDING_MODELS, embeddingKind }

export function embedderKey(ref: EmbedderRef): string {
  return ref.kind === 'local' ? LOCAL_EMBEDDER_KEY : providerEmbedderKey(ref.provider, ref.model)
}

interface PdfState {
  readonly runtime: PdfRuntime
  readonly release: () => void
}

let pdf: Promise<PdfState> | null = null
let extractor: WorkerExtractor | null = null

/** pdf.js and its worker, loaded once; the worker is ours, so pdf.js never starts one (or evaluates a script URL). */
function pdfRuntime(): Promise<PdfState> {
  pdf ??= import('pdfjs-dist').then((pdfjs) => {
    const port = createWorker(pdfWorkerUrl, { name: 'pdf' })
    const worker = new pdfjs.PDFWorker({ port: port as never, verbosity: pdfjs.VerbosityLevel.ERRORS })
    return {
      runtime: { pdfjs: pdfjs as unknown as PdfJsLike, worker },
      release: () => {
        worker.destroy()
        port.terminate()
      },
    }
  })
  pdf.catch(() => {
    pdf = null
  })
  return pdf
}

function workerExtractor(): WorkerExtractor {
  extractor ??= connectExtractor(
    () => createWorker(knowledgeWorkerUrl, { name: 'knowledge' }) as unknown as ExtractWorkerLike,
  )
  return extractor
}

/** Reads a document: PDF in pdf.js's worker, any other format in the knowledge worker. */
export function extractDocument(bytes: Uint8Array, format: DocumentFormat, signal?: AbortSignal): Promise<Extracted> {
  if (format === 'pdf') return extractPdf(bytes, () => pdfRuntime().then((s) => s.runtime), signal)
  return workerExtractor().extract(bytes, format, signal)
}

export interface KnowledgeSessionDeps {
  readonly workspace: Workspace
  readonly keys: ProviderKeys
  readonly blobs: BlobPort
  readonly clock: Clock
}

/** The knowledge service of a session. */
export function openKnowledge(deps: KnowledgeSessionDeps): KnowledgeService {
  const { workspace, keys } = deps
  const embedder = async (ref: EmbedderRef): Promise<EmbedderPort | null> => {
    if (ref.kind === 'local') {
      return { key: LOCAL_EMBEDDER_KEY, embed: (texts, signal) => localEmbedder().embed(texts, signal) }
    }
    const provider = workspace.providers.get(ref.provider)
    if (provider === undefined || provider.deletedAt !== undefined || !embeddingKind(provider.kind)) return null
    const apiKey = await keys.get(provider.id)
    if (apiKey === null && provider.kind !== 'openai-compatible') return null
    return createApiEmbedder({ provider, model: ref.model, apiKey, fetch: providerFetch })
  }
  return createKnowledge({
    bases: workspace.knowledge,
    blobs: deps.blobs,
    extract: extractDocument,
    embedder,
    keyOf: embedderKey,
    clock: deps.clock,
  })
}

/** Stops the document workers (on lock): nothing of a document stays in this page's memory. */
export function releaseKnowledge(): void {
  extractor?.dispose()
  extractor = null
  const current = pdf
  pdf = null
  current?.then(
    (s) => s.release(),
    () => undefined,
  )
}
