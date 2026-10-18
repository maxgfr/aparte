/*
 * The model cache, as the WebLLM worker hands it to the engine in place of `caches`. WebLLM reads and writes its files
 * through the Cache API only (`caches.open(scope)`, then `match`, `add`, `keys`, `delete`), so this wrapper sees every
 * byte: it names the caches `aparte-<scope>`, downloads only pinned URLs (through the app's network wrapper), checks
 * each file's SHA-256 before storing it, and checks it again the first time it is read back in the worker's life,
 * because any app of the shared origin can write into CacheStorage. A file that fails is deleted and never served.
 * Pure over structural interfaces, so it is tested in Bun without a browser.
 */
import { LocalModelError, type ModelCacheState } from '../../contracts/local.ts'

/** Every cache name the app creates starts with this; WebLLM's `webllm/*` scopes become `aparte-webllm/*`. */
export const CACHE_PREFIX = 'aparte-'
/** The scopes WebLLM writes to (hard-coded in @mlc-ai/web-llm). */
export const WEBLLM_SCOPES = ['webllm/model', 'webllm/config', 'webllm/wasm'] as const

type Key = string | URL | { readonly url: string }

/** The part of `Cache` WebLLM and the cache state use. */
export interface CacheLike {
  match(request: Key): Promise<Response | undefined>
  put(request: Key, response: Response): Promise<void>
  add(request: Key): Promise<void>
  delete(request: Key): Promise<boolean>
  keys(): Promise<readonly { readonly url: string }[]>
}

/** The part of `CacheStorage` they use. */
export interface CacheStorageLike {
  open(name: string): Promise<CacheLike>
  has(name: string): Promise<boolean>
  delete(name: string): Promise<boolean>
  keys(): Promise<string[]>
}

export interface PinnedCacheOptions {
  /** The pinned SHA-256 (hex) of a URL, or null when it is not pinned. */
  readonly digest: (url: string) => string | null
  /** Downloads a pinned URL (the app's network wrapper). */
  readonly download: (url: string, signal?: AbortSignal) => Promise<Response>
  /** Whether a missing file may be downloaded now (false while a chat loads its model). */
  readonly allowDownload: () => boolean
  readonly prefix?: string
}

function urlOf(key: Key): string {
  if (typeof key === 'string') return key
  if (key instanceof URL) return key.href
  return key.url
}

function signalOf(key: Key): AbortSignal | undefined {
  return typeof Request !== 'undefined' && key instanceof Request ? key.signal : undefined
}

/** Lower-case hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The verifying cache storage (see the file comment). */
export function pinnedCaches(inner: CacheStorageLike, options: PinnedCacheOptions): CacheStorageLike {
  const prefix = options.prefix ?? CACHE_PREFIX
  /** URLs whose cached bytes were checked in this worker's life. */
  const verified = new Set<string>()

  const wrap = (cache: CacheLike): CacheLike => {
    const store = async (url: string, bytes: ArrayBuffer, type: string | null): Promise<void> => {
      const expected = options.digest(url)
      if (expected === null) throw new LocalModelError('unpinned', `Refused to cache an unpinned file: ${url}`)
      if ((await sha256Hex(bytes)) !== expected) {
        throw new LocalModelError('integrity', `A downloaded file does not match its pinned digest: ${url}`)
      }
      await cache.put(url, new Response(bytes, { headers: { 'content-type': type ?? 'application/octet-stream' } }))
      verified.add(url)
    }
    return {
      async match(request) {
        const url = urlOf(request)
        const hit = await cache.match(url)
        if (hit === undefined) return undefined
        if (verified.has(url)) return hit
        const expected = options.digest(url)
        const bytes = await hit.arrayBuffer()
        if (expected === null || (await sha256Hex(bytes)) !== expected) {
          // Planted, truncated or stale: dropped, so the engine fetches the pinned file again.
          await cache.delete(url)
          return undefined
        }
        verified.add(url)
        return new Response(bytes, { status: hit.status, headers: hit.headers })
      },
      async add(request) {
        const url = urlOf(request)
        if (options.digest(url) === null) throw new LocalModelError('unpinned', `Refused an unpinned download: ${url}`)
        if (!options.allowDownload()) {
          throw new LocalModelError('not-downloaded', 'The model is not fully on this device; download it first')
        }
        const response = await options.download(url, signalOf(request))
        if (!response.ok) throw new LocalModelError('engine', `Download failed with HTTP ${response.status}: ${url}`)
        await store(url, await response.arrayBuffer(), response.headers.get('content-type'))
      },
      async put(request, response) {
        await store(urlOf(request), await response.arrayBuffer(), response.headers.get('content-type'))
      },
      async delete(request) {
        const url = urlOf(request)
        verified.delete(url)
        return cache.delete(url)
      },
      keys: () => cache.keys(),
    }
  }

  return {
    open: async (name) => wrap(await inner.open(prefix + name)),
    has: (name) => inner.has(prefix + name),
    delete: (name) => inner.delete(prefix + name),
    keys: async () => (await inner.keys()).filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length)),
  }
}

/**
 * What of a model is cached, read from the page the way WebLLM lays its caches out: complete once its library, its
 * chat config, its tensor list and every shard that list names are present. Presence only; the worker checks the bytes
 * when it loads them. `baseUrl` is the model's pinned base URL, `libUrl` its library, `totalBytes` the pinned size
 * (used until the tensor list is cached).
 */
export async function modelCacheState(
  caches: Pick<CacheStorageLike, 'open' | 'has'>,
  model: { readonly baseUrl: string; readonly libUrl: string; readonly libBytes: number; readonly totalBytes: number },
): Promise<ModelCacheState> {
  const opened = new Map<string, CacheLike>()
  for (const scope of WEBLLM_SCOPES) {
    const name = CACHE_PREFIX + scope
    if (await caches.has(name)) opened.set(scope, await caches.open(name))
  }
  const keysOf = async (scope: string) => new Set((await opened.get(scope)?.keys())?.map((r) => r.url) ?? [])
  const modelKeys = await keysOf('webllm/model')
  const configKeys = await keysOf('webllm/config')
  const hasLib = (await keysOf('webllm/wasm')).has(model.libUrl)
  const hasConfig = configKeys.has(new URL('mlc-chat-config.json', model.baseUrl).href)
  const listUrl = new URL('tensor-cache.json', model.baseUrl).href
  const list = await opened.get('webllm/model')?.match(listUrl)
  if (list === undefined) {
    return { complete: false, cachedBytes: hasLib ? model.libBytes : 0, totalBytes: model.totalBytes }
  }
  let records: unknown
  try {
    records = ((await list.json()) as { records?: unknown }).records
  } catch {
    records = undefined
  }
  if (!Array.isArray(records)) return { complete: false, cachedBytes: 0, totalBytes: model.totalBytes }
  let cachedBytes = hasLib ? model.libBytes : 0
  let totalBytes = model.libBytes
  let allShards = true
  for (const r of records as { dataPath?: unknown; nbytes?: unknown }[]) {
    if (typeof r?.dataPath !== 'string' || typeof r.nbytes !== 'number') {
      allShards = false
      continue
    }
    totalBytes += r.nbytes
    if (modelKeys.has(new URL(r.dataPath, model.baseUrl).href)) cachedBytes += r.nbytes
    else allShards = false
  }
  return { complete: allShards && hasLib && hasConfig, cachedBytes, totalBytes }
}

/** Deletes the cached entries whose URL `mine` claims, in every WebLLM scope; returns how many went. */
export async function removeModelFiles(
  caches: Pick<CacheStorageLike, 'open' | 'has'>,
  mine: (url: string) => boolean,
): Promise<number> {
  let removed = 0
  for (const scope of WEBLLM_SCOPES) {
    const name = CACHE_PREFIX + scope
    if (!(await caches.has(name))) continue
    const cache = await caches.open(name)
    for (const { url } of await cache.keys()) if (mine(url) && (await cache.delete(url))) removed++
  }
  return removed
}
