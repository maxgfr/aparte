/*
 * The first module the WebLLM worker evaluates, before WebLLM itself: it confines the worker's network to the pinned
 * model files (web/src/security/workerNet.ts) and replaces `caches` with the verifying, prefixed model cache
 * (web/src/core/ai/local/pinnedCache.ts), so not one request or cache access of the library escapes either.
 */
import { pinnedUrls, WEBLLM_MODELS } from '../core/ai/local/catalog.ts'
import { type CacheStorageLike, pinnedCaches } from '../core/ai/local/pinnedCache.ts'
import { confineFetch } from '../security/workerNet.ts'
import pins from './webllm-files.json'

const files: Readonly<Record<string, Readonly<Record<string, string>>>> = pins.files

/** Every URL the engine may fetch, with its SHA-256. */
export const DIGESTS: ReadonlyMap<string, string> = new Map(
  WEBLLM_MODELS.flatMap((m) => [...pinnedUrls(m, files[m.id] ?? {})]),
)

/** Whether the load being served may download (the model screen) or must use the cache only (a chat). */
export const downloads = { allowed: false }

const download = confineFetch((url) => {
  const sha256 = DIGESTS.get(url.href)
  return sha256 === undefined ? null : { purpose: 'download', sha256 }
})

const scope = globalThis as unknown as { caches: CacheStorageLike }
const native = scope.caches
Object.defineProperty(globalThis, 'caches', {
  configurable: true,
  value: pinnedCaches(native, {
    digest: (url) => DIGESTS.get(url) ?? null,
    download: (url, signal) => download(url, signal ? { signal } : {}),
    allowDownload: () => downloads.allowed,
  }),
})
