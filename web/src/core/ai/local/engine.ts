/*
 * The protocol between the page and the WebLLM worker (src/workers/webllm.worker.ts), both ends: `serveEngine` in the
 * worker over an `EngineBackend`, `connectEngine` in the page over the worker. Messages are plain structured-clone
 * data; anything that is not one of ours (an extension's post, a stray message) is ignored. Pure and structural, so the
 * page and the worker are tested against each other in Bun.
 */
import {
  type EngineChatRequest,
  type EngineChunk,
  LOCAL_ERROR_CODES,
  type LoadOptions,
  type LoadProgress,
  type LocalEngine,
  type LocalErrorCode,
  LocalModelError,
} from '../../contracts/local.ts'

export type EngineRequest =
  | { readonly id: number; readonly op: 'load'; readonly modelId: string; readonly download: boolean }
  | { readonly id: number; readonly op: 'chat'; readonly request: EngineChatRequest }
  | { readonly id: number; readonly op: 'abort'; readonly target: number }

export interface WireError {
  readonly name: string
  readonly message: string
  readonly code?: LocalErrorCode
}

export type EngineResponse =
  | { readonly id: number; readonly kind: 'progress'; readonly progress: LoadProgress }
  | { readonly id: number; readonly kind: 'loaded' }
  | { readonly id: number; readonly kind: 'chunk'; readonly chunk: EngineChunk }
  | { readonly id: number; readonly kind: 'error'; readonly error: WireError }

const OPS: ReadonlySet<string> = new Set(['load', 'chat', 'abort'])
const KINDS: ReadonlySet<string> = new Set(['progress', 'loaded', 'chunk', 'error'])

const isObject = (d: unknown): d is Record<string, unknown> => typeof d === 'object' && d !== null

export function isEngineRequest(d: unknown): d is EngineRequest {
  return isObject(d) && typeof d.id === 'number' && typeof d.op === 'string' && OPS.has(d.op)
}

export function isEngineResponse(d: unknown): d is EngineResponse {
  return isObject(d) && typeof d.id === 'number' && typeof d.kind === 'string' && KINDS.has(d.kind)
}

export function toWire(e: unknown): WireError {
  if (e instanceof LocalModelError) return { name: e.name, message: e.message, code: e.code }
  if (e instanceof Error) return { name: e.name, message: e.message }
  return { name: 'Error', message: String(e) }
}

export function fromWire(w: WireError): Error {
  if (w.code !== undefined && LOCAL_ERROR_CODES.includes(w.code)) return new LocalModelError(w.code, w.message)
  if (w.name === 'AbortError') return new DOMException(w.message, 'AbortError')
  const e = new Error(w.message)
  e.name = w.name
  return e
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError')
}

/** What the worker runs (WebLLM there; a fake in tests and e2e). */
export interface EngineBackend {
  load(modelId: string, download: boolean, onProgress: (p: LoadProgress) => void): Promise<void>
  chat(request: EngineChatRequest, signal: AbortSignal): AsyncIterable<EngineChunk>
}

/** A message or error event, as both ends of the worker see it. */
export interface WorkerEvent {
  readonly data?: unknown
  readonly message?: string
}

export interface WorkerScopeLike {
  postMessage(message: EngineResponse): void
  addEventListener(type: 'message', listener: (event: WorkerEvent) => void): void
}

/** Answers the page in the worker. */
export function serveEngine(scope: WorkerScopeLike, backend: EngineBackend): void {
  const running = new Map<number, AbortController>()
  const send = (message: EngineResponse) => scope.postMessage(message)
  const handle = async (req: EngineRequest): Promise<void> => {
    switch (req.op) {
      case 'abort':
        running.get(req.target)?.abort()
        return
      case 'load':
        await backend.load(req.modelId, req.download === true, (progress) =>
          send({ id: req.id, kind: 'progress', progress }),
        )
        send({ id: req.id, kind: 'loaded' })
        return
      case 'chat': {
        const controller = new AbortController()
        running.set(req.id, controller)
        try {
          for await (const chunk of backend.chat(req.request, controller.signal)) {
            send({ id: req.id, kind: 'chunk', chunk })
          }
        } finally {
          running.delete(req.id)
        }
        return
      }
    }
  }
  scope.addEventListener('message', (event) => {
    const req = event.data
    if (!isEngineRequest(req)) return
    handle(req).catch((e: unknown) => send({ id: req.id, kind: 'error', error: toWire(e) }))
  })
}

/** The page's side of the worker: a `Worker`, structurally. */
export interface WorkerLike {
  postMessage(message: EngineRequest): void
  addEventListener(type: 'message' | 'error', listener: (event: WorkerEvent) => void): void
  terminate(): void
}

/** A `LocalEngine` over a worker that runs `serveEngine`. */
export function connectEngine(worker: WorkerLike): LocalEngine {
  let next = 1
  let dead: Error | null = null
  const pending = new Map<number, (res: EngineResponse) => void>()
  const fail = (error: Error) => {
    if (dead === null) dead = error
    for (const [id, on] of [...pending]) on({ id, kind: 'error', error: toWire(error) })
    pending.clear()
  }
  worker.addEventListener('message', (event) => {
    const res = event.data
    if (isEngineResponse(res)) pending.get(res.id)?.(res)
  })
  worker.addEventListener('error', (event) =>
    fail(new LocalModelError('engine', event.message || 'The model worker failed')),
  )

  const request = (make: (id: number) => EngineRequest, on: (res: EngineResponse) => void): number => {
    const id = next++
    if (dead !== null) {
      const error = toWire(dead)
      queueMicrotask(() => on({ id, kind: 'error', error }))
      return id
    }
    pending.set(id, on)
    worker.postMessage(make(id))
    return id
  }

  const dispose = () => {
    if (dead !== null) return
    worker.terminate()
    fail(new LocalModelError('engine', 'The engine was stopped'))
  }

  return {
    load: (modelId: string, options: LoadOptions) =>
      new Promise<void>((resolve, reject) => {
        const signal = options.signal
        if (signal?.aborted) {
          reject(abortError(signal))
          return
        }
        // WebLLM cannot stop a download half-way: the worker goes, the files it cached stay.
        const onAbort = () => {
          if (signal) reject(abortError(signal))
          dispose()
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        const id = request(
          (rid) => ({ id: rid, op: 'load', modelId, download: options.download }),
          (res) => {
            if (res.kind === 'progress') {
              options.onProgress?.(res.progress)
              return
            }
            signal?.removeEventListener('abort', onAbort)
            pending.delete(id)
            if (res.kind === 'loaded') resolve()
            else if (res.kind === 'error') reject(fromWire(res.error))
          },
        )
      }),
    chat(chatRequest: EngineChatRequest, signal: AbortSignal): AsyncIterable<EngineChunk> {
      return {
        [Symbol.asyncIterator]() {
          const queue: EngineChunk[] = []
          let error: Error | null = null
          let ended = false
          let wake: (() => void) | null = null
          const notify = () => {
            wake?.()
            wake = null
          }
          let id = 0
          const onAbort = () => {
            if (!ended) worker.postMessage({ id: next++, op: 'abort', target: id })
          }
          if (!signal.aborted) {
            signal.addEventListener('abort', onAbort, { once: true })
            id = request(
              (rid) => ({ id: rid, op: 'chat', request: chatRequest }),
              (res) => {
                if (res.kind === 'chunk') {
                  queue.push(res.chunk)
                  if (res.chunk.type === 'done') {
                    ended = true
                    pending.delete(id)
                  }
                } else if (res.kind === 'error') {
                  error = fromWire(res.error)
                  ended = true
                  pending.delete(id)
                }
                notify()
              },
            )
          } else ended = true
          const finish = () => {
            signal.removeEventListener('abort', onAbort)
            pending.delete(id)
          }
          return {
            async next(): Promise<IteratorResult<EngineChunk>> {
              for (;;) {
                if (signal.aborted) {
                  finish()
                  return { done: true, value: undefined }
                }
                const chunk = queue.shift()
                if (chunk !== undefined) return { done: false, value: chunk }
                if (error !== null) {
                  finish()
                  throw error
                }
                if (ended) {
                  finish()
                  return { done: true, value: undefined }
                }
                await new Promise<void>((resolve) => {
                  wake = resolve
                  signal.addEventListener('abort', () => resolve(), { once: true })
                })
              }
            },
            async return(): Promise<IteratorResult<EngineChunk>> {
              if (!ended) onAbort()
              finish()
              return { done: true, value: undefined }
            },
          }
        },
      }
    },
    dispose,
  }
}
