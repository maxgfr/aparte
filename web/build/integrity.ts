import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { sriDigest } from '../src/pwa/sri.ts'

/** A precache manifest entry as Workbox hands it to a `manifestTransforms` step (`size` is dropped afterwards). */
export interface ManifestEntry {
  url: string
  revision: string | null
  integrity?: string
  size: number
}

/** What a Workbox manifest transform returns. */
export interface ManifestTransformResult {
  manifest: ManifestEntry[]
  warnings?: string[]
}

/** The Workbox `ManifestTransform` shape (its optional webpack `compilation` argument is never set by Vite). */
export type ManifestTransform = (entries: ManifestEntry[]) => Promise<ManifestTransformResult>

/**
 * A Workbox manifest transform that stamps every precached file with the SRI digest of its built bytes
 * (`integrity: 'sha256-...'`). The service worker installs each entry with `fetch(url, { integrity })` and checks
 * the digest again before every response it serves from CacheStorage, which every app on the shared
 * `maxgfr.github.io` origin can write to.
 *
 * `dir` is the build output the entries are relative to (Workbox's `globDirectory`, Vite's `outDir`), or a function
 * returning it once the build has resolved it: Workbox passes no compilation to transforms outside webpack, so the
 * files are read back from disk. A file that cannot be
 * read fails the build rather than ship an entry the worker could not verify. Entries Workbox appends after the
 * transforms (`additionalManifestEntries`, such as vite-plugin-pwa's own copy of the web manifest) carry no
 * integrity; the worker never precaches those.
 */
export function integrityTransform(dir: string | (() => string)): ManifestTransform {
  return async (entries) => {
    const root = resolve(typeof dir === 'function' ? dir() : dir)
    const manifest = await Promise.all(
      entries.map(async (entry) => {
        // Workbox builds `url` from the file path as is (not URL-encoded), relative to `globDirectory`.
        const path = resolve(root, entry.url)
        const rel = relative(root, path)
        if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || /^[a-z][a-z0-9+.-]*:/i.test(entry.url))
          throw new Error(`integrity: precache entry outside the build output: ${entry.url}`)
        const bytes = await readFile(path)
        if (bytes.byteLength !== entry.size)
          throw new Error(`integrity: ${entry.url} is ${bytes.byteLength} bytes on disk, Workbox saw ${entry.size}`)
        return { ...entry, integrity: await sriDigest(bytes) }
      }),
    )
    return { manifest, warnings: [] }
  }
}
