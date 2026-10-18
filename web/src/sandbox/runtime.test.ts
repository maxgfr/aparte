import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { TamperedError } from '../core/contracts/crypto.ts'
import type { PinnedFile } from '../core/contracts/sandbox.ts'
import { toHex, utf8 } from '../core/crypto/bytes.ts'
import { sha256 } from '../core/crypto/keys.ts'
import { resetNetworkLog } from '../security/net.ts'
import { createRuntimeFetcher } from './runtime.ts'

/*
 * The runtime fetcher checks every pinned download against its SHA-256 before anything uses it, and reaches the
 * network only through security/net.ts. CacheStorage is absent under bun test, so this covers the download path; a
 * mismatch is TamperedError, and the bytes are fetched once.
 */

const g = globalThis as { fetch?: typeof fetch; location?: unknown }
const savedFetch = g.fetch
const savedLocation = g.location
g.location = new URL('https://maxgfr.github.io/aparte/')

afterEach(() => {
  g.fetch = savedFetch
  resetNetworkLog()
})

afterAll(() => {
  g.fetch = savedFetch
  g.location = savedLocation
})

async function pin(url: string, bytes: Uint8Array): Promise<PinnedFile> {
  return { url, sha256: toHex(await sha256(bytes)) }
}

function serve(map: Record<string, Uint8Array<ArrayBuffer>>): () => string[] {
  const seen: string[] = []
  g.fetch = (async (input: string | URL) => {
    const url = String(input)
    seen.push(url)
    const bytes = map[url]
    if (bytes === undefined) return new Response('no', { status: 404 })
    return new Response(new Blob([bytes]), { status: 200 })
  }) as typeof fetch
  return () => seen
}

describe('createRuntimeFetcher', () => {
  test('returns the bytes when the hash matches, fetching once', async () => {
    const bytes = utf8('pyodide')
    const file = await pin('https://cdn.jsdelivr.net/pyodide/v0.29.5/full/pyodide.js', bytes)
    const seen = serve({ [file.url]: bytes })
    const fetcher = createRuntimeFetcher()
    expect(new TextDecoder().decode(await fetcher.get(file))).toBe('pyodide')
    await fetcher.get(file)
    // Fetched once and kept in memory; no CacheStorage under bun test.
    expect(seen()).toEqual([file.url])
  })

  test('a byte that does not match the pin is TamperedError', async () => {
    const bytes = utf8('pyodide')
    const file = await pin('https://cdn.jsdelivr.net/pyodide/v0.29.5/full/pyodide.asm.wasm', bytes)
    serve({ [file.url]: utf8('tampered') })
    await expect(createRuntimeFetcher().get(file)).rejects.toBeInstanceOf(TamperedError)
  })

  test('a failed download rejects and is retried next time', async () => {
    const bytes = utf8('mermaid')
    const file = await pin('https://cdn.jsdelivr.net/npm/mermaid@12.0.0/dist/mermaid.min.js', bytes)
    const fetcher = createRuntimeFetcher()
    serve({})
    await expect(fetcher.get(file)).rejects.toThrow()
    const seen = serve({ [file.url]: bytes })
    expect(new TextDecoder().decode(await fetcher.get(file))).toBe('mermaid')
    expect(seen()).toEqual([file.url])
  })

  test('only https (or loopback) is reached, through security/net.ts', async () => {
    const bytes = utf8('x')
    const file = { url: 'http://cdn.jsdelivr.net/x', sha256: toHex(await sha256(bytes)) }
    serve({ [file.url]: bytes })
    await expect(createRuntimeFetcher().get(file)).rejects.toThrow(/plain HTTP/)
  })
})
