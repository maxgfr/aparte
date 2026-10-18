/*
 * The pinned runtimes of the sandboxes, as the page fetches them (RuntimeFetcher of contracts/sandbox.ts).
 *
 * Invariants:
 * - Every download goes through web/src/security/net.ts with purpose `download` and is checked here against its
 *   pinned SHA-256 (core/sandbox/runtimes.ts `checkHash`) before anything uses it. The check is ours rather than the
 *   request's `integrity`, so a mismatch is told apart from a network failure and reported as TamperedError.
 * - The runtime cache (CacheStorage `aparte-runtime-v1`) holds public, pinned code only, never user data. It is not
 *   trusted either: a cached copy is used only when it still hashes to its pin, and is dropped otherwise (another
 *   page of the shared origin can write to CacheStorage). Nothing is precached: a runtime is fetched the first time a
 *   run needs it.
 * - A file is fetched at most once at a time; the checked bytes are kept in memory for the session.
 */
import type { PinnedFile, RuntimeFetcher } from '../core/contracts/sandbox.ts'
import { checkHash } from '../core/sandbox/runtimes.ts'
import { request } from '../security/net.ts'

export const RUNTIME_CACHE = 'aparte-runtime-v1'

async function openCache(): Promise<Cache | null> {
  try {
    return typeof caches === 'undefined' ? null : await caches.open(RUNTIME_CACHE)
  } catch {
    return null
  }
}

async function fromCache(file: PinnedFile): Promise<Uint8Array<ArrayBuffer> | null> {
  const cache = await openCache()
  if (cache === null) return null
  try {
    const hit = await cache.match(file.url)
    if (hit === undefined) return null
    const bytes = new Uint8Array(await hit.arrayBuffer())
    try {
      await checkHash(bytes, file.sha256)
      return bytes
    } catch {
      await cache.delete(file.url)
      return null
    }
  } catch {
    return null
  }
}

async function download(file: PinnedFile, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const response = await request(file.url, {
    purpose: 'download',
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`The download of ${file.url} failed (HTTP ${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  await checkHash(bytes, file.sha256)
  const cache = await openCache()
  try {
    await cache?.put(file.url, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }))
  } catch {
    // A full or unavailable cache only means the next run downloads it again.
  }
  return bytes
}

/** The page's fetcher of pinned files. */
export function createRuntimeFetcher(): RuntimeFetcher {
  const memory = new Map<string, Promise<Uint8Array<ArrayBuffer>>>()
  return {
    get(file, signal) {
      const key = `${file.sha256} ${file.url}`
      let pending = memory.get(key)
      if (pending === undefined) {
        pending = (async () => (await fromCache(file)) ?? (await download(file, signal)))()
        memory.set(key, pending)
        // A failed fetch is tried again next time; a mismatch is reported as such.
        pending.catch(() => memory.delete(key))
      }
      return pending
    },
  }
}
