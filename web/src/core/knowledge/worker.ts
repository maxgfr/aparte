/*
 * The protocol between the page and the knowledge worker (src/workers/knowledge.worker.ts), both ends: the worker
 * reads the text of DOCX, PPTX, HTML, Markdown and plain-text files off the main thread (core/knowledge/extract.ts).
 * PDF goes to pdf.js's own worker instead (core/knowledge/pdfText.ts).
 */
import { type DocumentFormat, ExtractError, type ExtractErrorKind, type Extracted } from '../contracts/knowledge.ts'
import { extractText } from './extract.ts'

export type ExtractRequest = {
  readonly id: number
  readonly op: 'extract'
  readonly bytes: ArrayBuffer
  readonly format: Exclude<DocumentFormat, 'pdf'>
}

export type ExtractResponse =
  | { readonly id: number; readonly kind: 'extracted'; readonly extracted: Extracted }
  | { readonly id: number; readonly kind: 'error'; readonly error: { readonly kind: string; readonly message: string } }

const KINDS: ReadonlySet<string> = new Set<ExtractErrorKind>([
  'unsupported',
  'corrupt',
  'encrypted',
  'too-large',
  'unsafe',
  'empty',
])
const FORMATS: ReadonlySet<string> = new Set(['docx', 'pptx', 'html', 'markdown', 'text'])

const isObject = (d: unknown): d is Record<string, unknown> => typeof d === 'object' && d !== null

export interface ExtractScopeLike {
  postMessage(message: ExtractResponse): void
  addEventListener(type: 'message', listener: (event: { readonly data?: unknown }) => void): void
}

/** Answers the page in the worker, one file at a time. */
export function serveExtractor(scope: ExtractScopeLike): void {
  scope.addEventListener('message', (event) => {
    const req = event.data
    if (!isObject(req) || typeof req.id !== 'number' || req.op !== 'extract') return
    const id = req.id
    try {
      if (!(req.bytes instanceof ArrayBuffer) || typeof req.format !== 'string' || !FORMATS.has(req.format)) {
        throw new ExtractError('unsupported', 'A malformed request')
      }
      const extracted = extractText(new Uint8Array(req.bytes), req.format as ExtractRequest['format'])
      scope.postMessage({ id, kind: 'extracted', extracted })
    } catch (e) {
      const error =
        e instanceof ExtractError
          ? { kind: e.kind, message: e.message }
          : { kind: 'corrupt', message: 'The document cannot be read' }
      scope.postMessage({ id, kind: 'error', error })
    }
  })
}

export interface ExtractWorkerLike {
  postMessage(message: ExtractRequest, transfer?: Transferable[]): void
  addEventListener(
    type: 'message' | 'error',
    listener: (event: { readonly data?: unknown; readonly message?: string }) => void,
  ): void
  terminate(): void
}

export interface WorkerExtractor {
  extract(bytes: Uint8Array, format: ExtractRequest['format'], signal?: AbortSignal): Promise<Extracted>
  dispose(): void
}

function checkExtracted(value: unknown, format: DocumentFormat): Extracted {
  if (!isObject(value) || !Array.isArray(value.sections)) throw new ExtractError('corrupt', 'A malformed answer')
  const sections = value.sections.map((s) => {
    if (!isObject(s) || typeof s.text !== 'string') throw new ExtractError('corrupt', 'A malformed answer')
    return {
      text: s.text,
      ...(typeof s.page === 'number' && Number.isSafeInteger(s.page) ? { page: s.page } : {}),
      ...(typeof s.heading === 'string' ? { heading: s.heading } : {}),
    }
  })
  return { format, sections }
}

/** The page's end: starts the worker on first use; an abort terminates it (a parse cannot be interrupted). */
export function connectExtractor(start: () => ExtractWorkerLike): WorkerExtractor {
  let worker: ExtractWorkerLike | null = null
  let next = 1
  const pending = new Map<
    number,
    { resolve: (v: Extracted) => void; reject: (e: unknown) => void; format: DocumentFormat }
  >()
  const fail = (error: unknown) => {
    for (const p of pending.values()) p.reject(error)
    pending.clear()
  }
  const stop = (error: unknown) => {
    worker?.terminate()
    worker = null
    fail(error)
  }
  const get = (): ExtractWorkerLike => {
    if (worker !== null) return worker
    const w = start()
    w.addEventListener('message', (event) => {
      const res = event.data
      if (!isObject(res) || typeof res.id !== 'number') return
      const p = pending.get(res.id)
      if (!p) return
      pending.delete(res.id)
      if (res.kind === 'extracted') {
        try {
          p.resolve(checkExtracted(res.extracted, p.format))
        } catch (e) {
          p.reject(e)
        }
      } else {
        const error = isObject(res.error) ? res.error : {}
        const kind =
          typeof error.kind === 'string' && KINDS.has(error.kind) ? (error.kind as ExtractErrorKind) : 'corrupt'
        p.reject(new ExtractError(kind, typeof error.message === 'string' ? error.message : 'Unreadable'))
      }
    })
    w.addEventListener('error', (event) => {
      worker = null
      fail(new ExtractError('corrupt', event.message || 'The knowledge worker failed'))
    })
    worker = w
    return w
  }
  return {
    extract(bytes, format, signal) {
      return new Promise<Extracted>((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
          return
        }
        const w = get()
        const id = next++
        const onAbort = () => stop(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
        signal?.addEventListener('abort', onAbort, { once: true })
        pending.set(id, {
          format,
          resolve: (v) => {
            signal?.removeEventListener('abort', onAbort)
            resolve(v)
          },
          reject: (e) => {
            signal?.removeEventListener('abort', onAbort)
            reject(e)
          },
        })
        const copy = new Uint8Array(bytes).buffer
        w.postMessage({ id, op: 'extract', bytes: copy, format }, [copy])
      })
    },
    dispose() {
      stop(new ExtractError('corrupt', 'The knowledge worker was stopped'))
    },
  }
}
