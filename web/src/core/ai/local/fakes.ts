/*
 * Test doubles of the browser pieces the on-device layer runs on: an in-memory CacheStorage, a worker channel that
 * copies messages the way postMessage does, a WebGPU adapter and a scripted engine. Used by the unit tests only.
 */
import type { EngineChatRequest, EngineChunk, GpuLike, LoadOptions, LocalEngine } from '../../contracts/local.ts'
import type { WorkerEvent, WorkerLike, WorkerScopeLike } from './engine.ts'
import type { CacheLike, CacheStorageLike } from './pinnedCache.ts'

type Key = Parameters<CacheLike['match']>[0]
const urlOf = (k: Key) => (typeof k === 'string' ? k : k instanceof URL ? k.href : k.url)

/** An in-memory CacheStorage; `add` fetches with `fetcher`. */
export function memoryCaches(
  fetcher: (url: string) => Promise<Response> = async () => new Response(null, { status: 404 }),
) {
  const stores = new Map<string, Map<string, { bytes: ArrayBuffer; type: string }>>()
  const open = (name: string): CacheLike => {
    let store = stores.get(name)
    if (!store) {
      store = new Map()
      stores.set(name, store)
    }
    const s = store
    const put = async (k: Key, r: Response) => {
      s.set(urlOf(k), { bytes: await r.arrayBuffer(), type: r.headers.get('content-type') ?? '' })
    }
    return {
      async match(k) {
        const hit = s.get(urlOf(k))
        return hit ? new Response(hit.bytes.slice(0), { headers: { 'content-type': hit.type } }) : undefined
      },
      put,
      async add(k) {
        await put(k, await fetcher(urlOf(k)))
      },
      delete: async (k) => s.delete(urlOf(k)),
      keys: async () => [...s.keys()].map((url) => ({ url })),
    }
  }
  const caches: CacheStorageLike = {
    open: async (name) => open(name),
    has: async (name) => stores.has(name),
    delete: async (name) => stores.delete(name),
    keys: async () => [...stores.keys()],
  }
  return { caches, stores }
}

/** Both ends of a worker: messages are structured-cloned and delivered asynchronously, as postMessage does. */
export function workerChannel() {
  const toWorker = new Set<(e: WorkerEvent) => void>()
  const toPage = new Set<(e: WorkerEvent) => void>()
  const errors = new Set<(e: WorkerEvent) => void>()
  const sent: unknown[] = []
  let terminated = false
  const deliver = (to: Set<(e: WorkerEvent) => void>, data: unknown) => {
    const copy = structuredClone(data)
    queueMicrotask(() => {
      if (terminated) return
      for (const l of to) l({ data: copy })
    })
  }
  const worker: WorkerLike & { readonly terminated: boolean; crash(message: string): void; readonly sent: unknown[] } =
    {
      postMessage(message) {
        sent.push(message)
        deliver(toWorker, message)
      },
      addEventListener(type, listener) {
        ;(type === 'message' ? toPage : errors).add(listener)
      },
      terminate() {
        terminated = true
      },
      get terminated() {
        return terminated
      },
      crash(message) {
        for (const l of errors) l({ message })
      },
      sent,
    }
  const scope: WorkerScopeLike = {
    postMessage: (message) => deliver(toPage, message),
    addEventListener: (_type, listener) => toWorker.add(listener),
  }
  return { worker, scope }
}

/** A WebGPU stand-in. */
export function fakeGpu(
  o: {
    adapter?: boolean
    maxBufferSize?: number
    maxStorageBufferBindingSize?: number
    maxComputeWorkgroupStorageSize?: number
    shaderF16?: boolean
  } = {},
): GpuLike {
  const GiB = 1024 ** 3
  return {
    requestAdapter: async () =>
      o.adapter === false
        ? null
        : {
            limits: {
              maxBufferSize: o.maxBufferSize ?? 4 * GiB,
              maxStorageBufferBindingSize: o.maxStorageBufferBindingSize ?? 4 * GiB,
              maxComputeWorkgroupStorageSize: o.maxComputeWorkgroupStorageSize ?? 32 * 1024,
            },
            features: { has: (name: string) => name === 'shader-f16' && o.shaderF16 !== false },
            info: { vendor: 'fake' },
          },
  }
}

/** An engine that answers every chat with `script` (deltas, then a `done`), recording what it was asked. */
export function scriptedEngine(script: (request: EngineChatRequest) => readonly EngineChunk[] | Error) {
  const loads: { modelId: string; options: LoadOptions }[] = []
  const chats: EngineChatRequest[] = []
  let failLoad: Error | null = null
  const engine: LocalEngine & {
    loads: typeof loads
    chats: typeof chats
    failLoadWith(e: Error): void
    disposed: boolean
  } = {
    loads,
    chats,
    disposed: false,
    failLoadWith(e) {
      failLoad = e
    },
    async load(modelId, options) {
      loads.push({ modelId, options })
      if (failLoad) throw failLoad
    },
    async *chat(request, signal) {
      chats.push(request)
      const out = script(request)
      if (out instanceof Error) throw out
      for (const chunk of out) {
        if (signal.aborted) return
        await Promise.resolve()
        yield chunk
      }
    },
    dispose() {
      engine.disposed = true
    },
  }
  return engine
}
