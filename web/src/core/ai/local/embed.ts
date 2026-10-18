/*
 * Text embeddings off the main thread: the protocol between the page and the transformers.js worker
 * (src/workers/transformers.worker.ts), both ends, and the `Embedder` the retrieval (M7) and voice (M8) milestones
 * build on. The worker runs one pinned sentence-embedding model on ONNX Runtime's WebAssembly backend, self-hosted
 * under the app's base and single-threaded; it is started on first use and never precached.
 */
import type { Embedder } from '../../contracts/local.ts'
import { fromWire, toWire, type WireError } from './engine.ts'

export type EmbedRequest =
  | { readonly id: number; readonly op: 'embed'; readonly texts: readonly string[] }
  | { readonly id: number; readonly op: 'abort'; readonly target: number }

export type EmbedResponse =
  | { readonly id: number; readonly kind: 'vectors'; readonly vectors: readonly Float32Array[] }
  | { readonly id: number; readonly kind: 'error'; readonly error: WireError }

/** Texts sent in one request at most; longer lists are split, so a request never holds the worker for long. */
export const EMBED_BATCH = 32

const isObject = (d: unknown): d is Record<string, unknown> => typeof d === 'object' && d !== null

function isRequest(d: unknown): d is EmbedRequest {
  return isObject(d) && typeof d.id === 'number' && (d.op === 'embed' || d.op === 'abort')
}

function isResponse(d: unknown): d is EmbedResponse {
  return isObject(d) && typeof d.id === 'number' && (d.kind === 'vectors' || d.kind === 'error')
}

/** What the worker runs: transformers.js there, a fake in tests. Vectors come back mean-pooled and unit-length. */
export interface EmbedBackend {
  embed(texts: readonly string[]): Promise<Float32Array[]>
}

export interface EmbedScopeLike {
  postMessage(message: EmbedResponse, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: { readonly data?: unknown }) => void): void
}

/** Answers the page in the worker, one request at a time (the runtime is single-threaded anyway). */
export function serveEmbedder(scope: EmbedScopeLike, backend: EmbedBackend): void {
  const aborted = new Set<number>()
  let queue = Promise.resolve()
  scope.addEventListener('message', (event) => {
    const req = event.data
    if (!isRequest(req)) return
    if (req.op === 'abort') {
      aborted.add(req.target)
      return
    }
    queue = queue.then(async () => {
      if (aborted.delete(req.id)) return
      try {
        if (!Array.isArray(req.texts) || req.texts.some((t) => typeof t !== 'string')) {
          throw new TypeError('embed takes a list of strings')
        }
        const vectors = await backend.embed(req.texts)
        if (aborted.delete(req.id)) return
        scope.postMessage(
          { id: req.id, kind: 'vectors', vectors },
          vectors.map((v) => v.buffer as ArrayBuffer),
        )
      } catch (e) {
        scope.postMessage({ id: req.id, kind: 'error', error: toWire(e) })
      }
    })
  })
}

export interface EmbedWorkerLike {
  postMessage(message: EmbedRequest): void
  addEventListener(
    type: 'message' | 'error',
    listener: (event: { readonly data?: unknown; readonly message?: string }) => void,
  ): void
  terminate(): void
}

/** Scales a vector to unit length (a zero vector stays zero). */
export function normalize(v: Float32Array): Float32Array {
  let sum = 0
  for (const x of v) sum += x * x
  const norm = Math.sqrt(sum)
  if (norm === 0 || Math.abs(norm - 1) < 1e-6) return v
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) / norm
  return out
}

/** Cosine similarity of two unit-length vectors (their dot product). */
export function similarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new RangeError('Vectors of different dimensions')
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number)
  return dot
}

/** An `Embedder` over a worker that runs `serveEmbedder`; `start` makes the worker on first use. */
export function connectEmbedder(start: () => EmbedWorkerLike): Embedder {
  let worker: EmbedWorkerLike | null = null
  let next = 1
  const pending = new Map<number, { resolve: (v: readonly Float32Array[]) => void; reject: (e: unknown) => void }>()
  const fail = (error: Error) => {
    for (const p of pending.values()) p.reject(error)
    pending.clear()
  }
  const get = (): EmbedWorkerLike => {
    if (worker !== null) return worker
    const w = start()
    w.addEventListener('message', (event) => {
      const res = event.data
      if (!isResponse(res)) return
      const p = pending.get(res.id)
      if (!p) return
      pending.delete(res.id)
      if (res.kind === 'vectors') p.resolve(res.vectors)
      else p.reject(fromWire(res.error))
    })
    w.addEventListener('error', (event) => {
      worker = null
      fail(new Error(event.message || 'The embedding worker failed'))
    })
    worker = w
    return w
  }
  const batch = (texts: readonly string[], signal?: AbortSignal) =>
    new Promise<readonly Float32Array[]>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        return
      }
      const w = get()
      const id = next++
      const onAbort = () => {
        pending.delete(id)
        w.postMessage({ id: next++, op: 'abort', target: id })
        reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      pending.set(id, {
        resolve: (v) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(v)
        },
        reject: (e) => {
          signal?.removeEventListener('abort', onAbort)
          reject(e)
        },
      })
      w.postMessage({ id, op: 'embed', texts: [...texts] })
    })
  return {
    async embed(texts, signal) {
      const out: Float32Array[] = []
      for (let i = 0; i < texts.length; i += EMBED_BATCH) {
        const part = texts.slice(i, i + EMBED_BATCH)
        const vectors = await batch(part, signal)
        if (vectors.length !== part.length) throw new Error('The embedding worker returned the wrong number of vectors')
        const dim = (vectors[0] ?? out[0])?.length
        for (const v of vectors) {
          if (!(v instanceof Float32Array) || v.length !== dim)
            throw new Error('The embedding worker returned a malformed vector')
          out.push(normalize(v))
        }
      }
      return out
    },
    dispose() {
      worker?.terminate()
      worker = null
      fail(new Error('The embedder was stopped'))
    },
  }
}
