/**
 * The service worker's integrity-checked precache, as pure functions over a cache and a fetch it is handed (so it
 * is tested in Bun, without a worker).
 *
 * Why: CacheStorage is per origin, and `maxgfr.github.io` hosts several apps. Any of them (or a script injected
 * into one of them) can open Aparté's precache by name and overwrite `index.html` or a script chunk, and the
 * worker would then serve that code as Aparté, under Aparté's headers, forever. So nothing read from the cache is
 * trusted: every response is checked against the SRI digest the build stamped into the worker itself
 * (build/integrity.ts), which a sibling app cannot change, since the worker script is fetched from the network on
 * every update check (`updateViaCache: 'none'`) and the HTTP cache cannot be written by script.
 */

import { matchesIntegrity } from './sri.ts'

/** A precache manifest entry, as Workbox injects it into `self.__WB_MANIFEST`. */
export interface PrecacheEntry {
  url: string
  revision?: string | null
  integrity?: string
}

/** The part of `Cache` the precache uses. */
export interface CacheLike {
  match(key: string): Promise<Response | undefined>
  put(key: string, response: Response): Promise<void>
  delete(key: string): Promise<boolean>
}

export interface VerifiedStore {
  /** Opens the precache (Workbox's cache name for this scope). */
  open(): Promise<CacheLike>
  /** Downloads from the network: the worker's own `fetch` (src/sw.ts is the one file besides net.ts allowed it). */
  download(url: string, init: RequestInit): Promise<Response>
}

/**
 * The entries the worker precaches: one per URL, and only those carrying integrity. Workbox appends
 * `additionalManifestEntries` (vite-plugin-pwa's copy of the web manifest, already globbed with a digest) after the
 * build's transforms, so they come without one; an entry that cannot be verified is not precached at all and goes
 * to the network like any other request, where a sibling app cannot reach it.
 */
export function verifiableEntries(manifest: ReadonlyArray<string | PrecacheEntry>): PrecacheEntry[] {
  const byUrl = new Map<string, PrecacheEntry>()
  for (const entry of manifest) {
    if (typeof entry === 'string' || !entry.integrity || byUrl.has(entry.url)) continue
    byUrl.set(entry.url, { url: entry.url, revision: entry.revision ?? null, integrity: entry.integrity })
  }
  return [...byUrl.values()]
}

/**
 * Checks a cached response against its digest. Returns an equivalent response (the body has been read) when it
 * matches, null when it does not or cannot be read: Workbox's install then refetches it with `integrity`.
 */
export async function verifyCached(response: Response, integrity: string): Promise<Response | null> {
  if (!response.ok) return null
  try {
    const bytes = await response.arrayBuffer()
    if (!(await matchesIntegrity(bytes, integrity))) return null
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers })
  } catch {
    return null
  }
}

/** Where verified bytes came from: the precache as is, or the network after the cached copy failed its check. */
export interface Verified {
  bytes: ArrayBuffer
  source: 'cache' | 'network'
}

/**
 * The bytes of a precached entry, verified. A cached copy that fails its digest is deleted and refetched from the
 * network with `{ integrity, cache: 'reload' }` (the browser enforces the digest, and the HTTP cache is bypassed);
 * the refetched bytes are checked again, since not every engine enforces `integrity` on worker fetches, and
 * written back to the precache. Null when no verified copy can be had (offline with a poisoned cache, or a
 * network copy that also mismatches): the caller fails closed, it never serves unverified bytes.
 */
export async function readVerified(
  store: VerifiedStore,
  cacheKey: string,
  integrity: string,
): Promise<Verified | null> {
  let cache: CacheLike | null = null
  try {
    cache = await store.open()
    const cached = await cache.match(cacheKey)
    if (cached) {
      if (cached.ok) {
        const bytes = await cached.arrayBuffer()
        if (await matchesIntegrity(bytes, integrity)) return { bytes, source: 'cache' }
      }
      await cache.delete(cacheKey)
    }
  } catch {
    // An unreadable cache is treated as a poisoned one: the network is the only source left.
  }
  let bytes: ArrayBuffer
  try {
    const response = await store.download(cacheKey, { integrity, cache: 'reload', credentials: 'same-origin' })
    if (!response.ok) return null
    bytes = await response.arrayBuffer()
  } catch {
    return null
  }
  if (!(await matchesIntegrity(bytes, integrity))) return null
  try {
    await cache?.put(cacheKey, new Response(bytes.slice(0), { status: 200 }))
  } catch {
    // A full quota only costs the next request a refetch.
  }
  return { bytes, source: 'network' }
}

/** Media types by extension for the files the build precaches; the cached `Content-Type` is never trusted. */
const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  webp: 'image/webp',
  woff2: 'font/woff2',
  wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8',
}

/** The `Content-Type` of a precached path, from its extension. */
export function contentTypeFor(pathname: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(pathname)?.[1]?.toLowerCase()
  return (ext && TYPES[ext]) || 'application/octet-stream'
}

/**
 * A fresh response for verified bytes. Its headers are rebuilt from scratch: a poisoned cache entry may carry the
 * right body with its own headers (a lax `Content-Security-Policy` on a worker script, a sniffable type), and
 * headers are not covered by the digest.
 */
export function precachedResponse(bytes: ArrayBuffer, pathname: string, extra: Record<string, string> = {}): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'Content-Type': contentTypeFor(pathname), 'X-Content-Type-Options': 'nosniff', ...extra },
  })
}

/** Served when no verified copy exists: failing closed beats running code that is not this build's. */
export function unavailableResponse(extra: Record<string, string> = {}): Response {
  return new Response(
    'Aparté could not verify its files. Reconnect to the network and reload; if this persists, clear the site data.',
    {
      status: 503,
      statusText: 'Service Unavailable',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        ...extra,
      },
    },
  )
}
