/*
 * Speech to text off the main thread: the protocol between the page and the transformers.js worker
 * (src/workers/transformers.worker.ts), both ends, and the `Transcriber` dictation uses. The worker runs one pinned
 * Whisper model (src/workers/whisper-pins.json) on ONNX Runtime's WebAssembly backend; the model is downloaded on first
 * use, hash-checked, and cached by the verifying cache. Audio crosses to the worker as transferred samples and is never
 * stored. The operations are named apart from the embedder's, which shares the worker script.
 */
import type { DownloadProgress, Transcriber } from '../../contracts/media.ts'
import { fromWire, toWire, type WireError } from './engine.ts'

export type TranscribeRequest =
  | { readonly id: number; readonly op: 'transcribe'; readonly audio: Float32Array; readonly language?: string }
  | { readonly id: number; readonly op: 'transcribe-abort'; readonly target: number }

export type TranscribeResponse =
  | { readonly id: number; readonly kind: 'transcript'; readonly text: string }
  | { readonly id: number; readonly kind: 'download'; readonly progress: DownloadProgress }
  | { readonly id: number; readonly kind: 'transcribe-error'; readonly error: WireError }

const isObject = (d: unknown): d is Record<string, unknown> => typeof d === 'object' && d !== null

function isRequest(d: unknown): d is TranscribeRequest {
  return isObject(d) && typeof d.id === 'number' && (d.op === 'transcribe' || d.op === 'transcribe-abort')
}

function isResponse(d: unknown): d is TranscribeResponse {
  return (
    isObject(d) &&
    typeof d.id === 'number' &&
    (d.kind === 'transcript' || d.kind === 'download' || d.kind === 'transcribe-error')
  )
}

/** What the worker runs: Whisper there, a fake in tests. */
export interface TranscribeBackend {
  /** `language` is an ISO 639-1 code (`fr`), or undefined for the model's default. */
  transcribe(audio: Float32Array, onProgress: (p: DownloadProgress) => void, language?: string): Promise<string>
}

/** An ISO 639-1 code, as Whisper names its languages; anything else is ignored. */
const LANGUAGE = /^[a-z]{2,3}$/

export interface TranscribeScopeLike {
  postMessage(message: TranscribeResponse): void
  addEventListener(type: 'message', listener: (event: { readonly data?: unknown }) => void): void
}

/** Answers the page in the worker, one recording at a time. */
export function serveTranscriber(scope: TranscribeScopeLike, backend: TranscribeBackend): void {
  const aborted = new Set<number>()
  let queue = Promise.resolve()
  scope.addEventListener('message', (event) => {
    const req = event.data
    if (!isRequest(req)) return
    if (req.op === 'transcribe-abort') {
      aborted.add(req.target)
      return
    }
    queue = queue.then(async () => {
      if (aborted.delete(req.id)) return
      try {
        if (!(req.audio instanceof Float32Array)) throw new TypeError('transcribe takes Float32Array samples')
        const language = typeof req.language === 'string' && LANGUAGE.test(req.language) ? req.language : undefined
        const text = await backend.transcribe(
          req.audio,
          (progress) => scope.postMessage({ id: req.id, kind: 'download', progress }),
          language,
        )
        if (aborted.delete(req.id)) return
        scope.postMessage({ id: req.id, kind: 'transcript', text: text.trim() })
      } catch (e) {
        if (aborted.delete(req.id)) return
        scope.postMessage({ id: req.id, kind: 'transcribe-error', error: toWire(e) })
      }
    })
  })
}

export interface TranscribeWorkerLike {
  postMessage(message: TranscribeRequest, transfer?: Transferable[]): void
  addEventListener(
    type: 'message' | 'error',
    listener: (event: { readonly data?: unknown; readonly message?: string }) => void,
  ): void
  terminate(): void
}

interface Pending {
  resolve: (text: string) => void
  reject: (e: unknown) => void
  onProgress?: (p: DownloadProgress) => void
}

/** A `Transcriber` over a worker that runs `serveTranscriber`; `start` makes the worker on first use. */
export function connectTranscriber(start: () => TranscribeWorkerLike): Transcriber {
  let worker: TranscribeWorkerLike | null = null
  let next = 1
  const pending = new Map<number, Pending>()
  const fail = (error: Error) => {
    for (const p of pending.values()) p.reject(error)
    pending.clear()
  }
  const get = (): TranscribeWorkerLike => {
    if (worker !== null) return worker
    const w = start()
    w.addEventListener('message', (event) => {
      const res = event.data
      if (!isResponse(res)) return
      const p = pending.get(res.id)
      if (!p) return
      if (res.kind === 'download') {
        p.onProgress?.(res.progress)
        return
      }
      pending.delete(res.id)
      if (res.kind === 'transcript') p.resolve(res.text)
      else p.reject(fromWire(res.error))
    })
    w.addEventListener('error', (event) => {
      worker = null
      fail(new Error(event.message || 'The speech worker failed'))
    })
    worker = w
    return w
  }
  return {
    transcribe(audio, options = {}) {
      const { signal, onProgress, language } = options
      return new Promise<string>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          return
        }
        const w = get()
        const id = next++
        const onAbort = () => {
          pending.delete(id)
          w.postMessage({ id: next++, op: 'transcribe-abort', target: id })
          reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        pending.set(id, {
          resolve: (text) => {
            signal?.removeEventListener('abort', onAbort)
            resolve(text)
          },
          reject: (e) => {
            signal?.removeEventListener('abort', onAbort)
            reject(e)
          },
          ...(onProgress === undefined ? {} : { onProgress }),
        })
        // A copy of the samples is transferred to the worker, not cloned once more on the way.
        const samples = new Float32Array(audio)
        w.postMessage({ id, op: 'transcribe', audio: samples, ...(language === undefined ? {} : { language }) }, [
          samples.buffer,
        ])
      })
    },
    dispose() {
      worker?.terminate()
      worker = null
      fail(new Error('The transcriber was stopped'))
    },
  }
}
