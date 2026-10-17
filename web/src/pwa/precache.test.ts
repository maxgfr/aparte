import { expect, test } from 'bun:test'
import {
  type CacheLike,
  contentTypeFor,
  precachedResponse,
  readVerified,
  unavailableResponse,
  type VerifiedStore,
  verifiableEntries,
  verifyCached,
} from './precache.ts'
import { sriDigest } from './sri.ts'

const enc = (s: string) => new TextEncoder().encode(s)
const text = (b: ArrayBuffer) => new TextDecoder().decode(b)

const KEY = 'https://maxgfr.github.io/aparte/index.html?__WB_REVISION__=abc'
const GOOD = '<!doctype html><title>Aparté</title>'
const EVIL = '<!doctype html><script src="https://evil.example/x.js"></script>'

/** An in-memory cache and a network serving `served` (or failing), recording what happened. */
function fakeStore(opts: { cached?: Response; served?: string | null; failOpen?: boolean; failPut?: boolean }) {
  const entries = new Map<string, Response>()
  if (opts.cached) entries.set(KEY, opts.cached)
  const log: string[] = []
  const cache: CacheLike = {
    match: async (key) => entries.get(key)?.clone(),
    put: async (key, response) => {
      if (opts.failPut) throw new DOMException('Quota exceeded', 'QuotaExceededError')
      log.push(`put ${key}`)
      entries.set(key, response)
    },
    delete: async (key) => {
      log.push(`delete ${key}`)
      return entries.delete(key)
    },
  }
  const fetches: { url: string; init: RequestInit }[] = []
  const store: VerifiedStore = {
    open: async () => {
      if (opts.failOpen) throw new Error('cache storage unavailable')
      return cache
    },
    download: async (url, init) => {
      fetches.push({ url, init })
      if (opts.served == null) throw new TypeError('Failed to fetch')
      return new Response(opts.served)
    },
  }
  return { store, entries, log, fetches }
}

test('a cached copy matching its digest is served from the cache, without touching the network', async () => {
  const integrity = await sriDigest(enc(GOOD))
  const { store, fetches, log } = fakeStore({ cached: new Response(GOOD), served: GOOD })
  const verified = await readVerified(store, KEY, integrity)
  expect(verified?.source).toBe('cache')
  expect(text(verified?.bytes ?? new ArrayBuffer(0))).toBe(GOOD)
  expect(fetches).toEqual([])
  expect(log).toEqual([])
})

test('a poisoned cached copy is deleted, refetched with integrity and no HTTP cache, then repaired', async () => {
  const integrity = await sriDigest(enc(GOOD))
  const { store, entries, fetches, log } = fakeStore({ cached: new Response(EVIL), served: GOOD })
  const verified = await readVerified(store, KEY, integrity)
  expect(verified?.source).toBe('network')
  expect(text(verified?.bytes ?? new ArrayBuffer(0))).toBe(GOOD)
  expect(fetches).toEqual([{ url: KEY, init: { integrity, cache: 'reload', credentials: 'same-origin' } }])
  expect(log).toEqual([`delete ${KEY}`, `put ${KEY}`])
  expect(await entries.get(KEY)?.clone().text()).toBe(GOOD)
  // The repaired copy is served from the cache next time.
  const again = await readVerified(store, KEY, integrity)
  expect(again?.source).toBe('cache')
})

test('a poisoned cache while offline fails closed: nothing is served, the poisoned copy is gone', async () => {
  const integrity = await sriDigest(enc(GOOD))
  const { store, entries } = fakeStore({ cached: new Response(EVIL), served: null })
  expect(await readVerified(store, KEY, integrity)).toBeNull()
  expect(entries.has(KEY)).toBe(false)
})

test('a network copy that mismatches too (an engine not enforcing integrity) is never served nor cached', async () => {
  const integrity = await sriDigest(enc(GOOD))
  const { store, entries } = fakeStore({ cached: new Response(EVIL), served: EVIL })
  expect(await readVerified(store, KEY, integrity)).toBeNull()
  expect(entries.has(KEY)).toBe(false)
})

test('a missing or failed cached copy is fetched; an error status is not served', async () => {
  const integrity = await sriDigest(enc(GOOD))
  const missing = fakeStore({ served: GOOD })
  expect((await readVerified(missing.store, KEY, integrity))?.source).toBe('network')

  const errored = fakeStore({ cached: new Response(GOOD, { status: 500 }), served: GOOD })
  expect((await readVerified(errored.store, KEY, integrity))?.source).toBe('network')
  expect(errored.log[0]).toBe(`delete ${KEY}`)

  const notFound = fakeStore({ served: GOOD })
  notFound.store.download = async () => new Response(GOOD, { status: 404 })
  expect(await readVerified(notFound.store, KEY, integrity)).toBeNull()
})

test('an unusable cache falls back to the verified network copy; a full quota still serves it', async () => {
  const integrity = await sriDigest(enc(GOOD))
  const closed = fakeStore({ failOpen: true, served: GOOD })
  expect((await readVerified(closed.store, KEY, integrity))?.source).toBe('network')
  const full = fakeStore({ failPut: true, served: GOOD })
  expect((await readVerified(full.store, KEY, integrity))?.source).toBe('network')
})

test('an entry without a usable digest is never served', async () => {
  const { store } = fakeStore({ cached: new Response(GOOD), served: GOOD })
  expect(await readVerified(store, KEY, '')).toBeNull()
})

test('only entries with integrity are precached, one per URL, the first with a digest winning', () => {
  expect(
    verifiableEntries([
      'loose.js',
      { url: 'index.html', revision: 'r1', integrity: 'sha256-a' },
      { url: 'manifest.webmanifest', revision: 'm1', integrity: 'sha256-m' },
      { url: 'manifest.webmanifest', revision: 'm1' },
      { url: 'index.html', revision: 'r2', integrity: 'sha256-b' },
      { url: 'assets/a.js', revision: null, integrity: 'sha256-c' },
      { url: 'no-digest.png', revision: 'x' },
    ]),
  ).toEqual([
    { url: 'index.html', revision: 'r1', integrity: 'sha256-a' },
    { url: 'manifest.webmanifest', revision: 'm1', integrity: 'sha256-m' },
    { url: 'assets/a.js', revision: null, integrity: 'sha256-c' },
  ])
})

test('the install check keeps a matching cached copy and rejects a poisoned or failed one', async () => {
  const integrity = await sriDigest(enc(GOOD))
  const kept = await verifyCached(new Response(GOOD, { headers: { 'x-a': '1' } }), integrity)
  expect(await kept?.text()).toBe(GOOD)
  expect(kept?.headers.get('x-a')).toBe('1')
  expect(await verifyCached(new Response(EVIL), integrity)).toBeNull()
  expect(await verifyCached(new Response(GOOD, { status: 404 }), integrity)).toBeNull()
  const used = new Response(GOOD)
  await used.text()
  expect(await verifyCached(used, integrity)).toBeNull()
})

test('served responses carry fresh headers: the type from the extension, nosniff, and the extra headers', async () => {
  const res = precachedResponse(enc(GOOD).buffer as ArrayBuffer, '/aparte/index.html', {
    'Content-Security-Policy': "default-src 'none'",
  })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
  expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  expect(res.headers.get('content-security-policy')).toBe("default-src 'none'")
  expect(await res.text()).toBe(GOOD)
})

test('content types come from the extension', () => {
  expect(contentTypeFor('/aparte/assets/index-abc.js')).toBe('text/javascript; charset=utf-8')
  expect(contentTypeFor('/aparte/assets/w.MJS')).toBe('text/javascript; charset=utf-8')
  expect(contentTypeFor('/aparte/assets/index.css')).toBe('text/css; charset=utf-8')
  expect(contentTypeFor('/aparte/manifest.webmanifest')).toBe('application/manifest+json')
  expect(contentTypeFor('/aparte/logo.svg')).toBe('image/svg+xml')
  expect(contentTypeFor('/aparte/favicon.ico')).toBe('image/x-icon')
  expect(contentTypeFor('/aparte/assets/inter.woff2')).toBe('font/woff2')
  expect(contentTypeFor('/aparte/unknown')).toBe('application/octet-stream')
  expect(contentTypeFor('/aparte/file.exe')).toBe('application/octet-stream')
})

test('the fail-closed response is a 503 that is never cached and keeps the extra headers', async () => {
  const res = unavailableResponse({ 'Cross-Origin-Opener-Policy': 'same-origin' })
  expect(res.status).toBe(503)
  expect(res.headers.get('cache-control')).toBe('no-store')
  expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin')
  expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  expect(await res.text()).toContain('could not verify')
})
