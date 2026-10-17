import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matchesIntegrity } from '../src/pwa/sri.ts'
import { integrityTransform } from './integrity.ts'

let dir = ''
const files: Record<string, Uint8Array<ArrayBuffer>> = {
  'index.html': new TextEncoder().encode('<!doctype html><title>Aparté</title>'),
  'assets/index-abc123.js': new TextEncoder().encode('console.log(1)\n'),
  'assets/logo.png': Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 255, 128]),
  'sub dir/a b.css': new TextEncoder().encode('a{}'),
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'aparte-integrity-'))
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true })
    await writeFile(join(dir, name), bytes)
  }
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** The digest SRI expects, computed independently with Node's crypto. */
const expected = (bytes: Uint8Array) => `sha256-${createHash('sha256').update(bytes).digest('base64')}`

const entry = (url: string, size: number, revision: string | null = 'r1') => ({ url, revision, size })

test('stamps every entry with the SHA-256 SRI digest of its built bytes, keeping the other fields', async () => {
  // Workbox passes file paths as they are on disk, spaces included.
  const entries = Object.entries(files).map(([name, bytes]) => entry(name, bytes.byteLength))
  const { manifest, warnings } = await integrityTransform(dir)(entries)
  expect(warnings).toEqual([])
  expect(manifest.map((e) => e.url)).toEqual(entries.map((e) => e.url))
  for (const [i, [, bytes]] of Object.entries(files).entries()) {
    const out = manifest[i]
    expect(out?.integrity).toBe(expected(bytes))
    expect(out?.revision).toBe('r1')
    expect(out?.size).toBe(bytes.byteLength)
    expect(await matchesIntegrity(bytes, out?.integrity ?? '')).toBe(true)
  }
})

test('keeps a null revision (hashed assets are not cache-busted)', async () => {
  const bytes = files['assets/index-abc123.js'] as Uint8Array<ArrayBuffer>
  const { manifest } = await integrityTransform(dir)([entry('assets/index-abc123.js', bytes.byteLength, null)])
  expect(manifest[0]?.revision).toBeNull()
  expect(manifest[0]?.integrity).toBe(expected(bytes))
})

test('a missing file fails the build instead of shipping an unverifiable entry', async () => {
  await expect(integrityTransform(dir)([entry('assets/gone.js', 3)])).rejects.toThrow()
})

test('a size that disagrees with the file on disk fails the build', async () => {
  await expect(integrityTransform(dir)([entry('index.html', 1)])).rejects.toThrow(/bytes on disk/)
})

test('entries outside the build output are refused', async () => {
  const transform = integrityTransform(dir)
  await expect(transform([entry('../etc/passwd', 1)])).rejects.toThrow(/outside the build output/)
  await expect(transform([entry('https://cdn.example/x.js', 1)])).rejects.toThrow(/outside the build output/)
  await expect(transform([entry('', 0)])).rejects.toThrow(/outside the build output/)
})

test('an empty manifest stays empty', async () => {
  expect(await integrityTransform(dir)([])).toEqual({ manifest: [], warnings: [] })
})

test('the output directory may be given lazily, once the build has resolved it', async () => {
  const bytes = files['index.html'] as Uint8Array<ArrayBuffer>
  let resolved = ''
  const transform = integrityTransform(() => resolved)
  resolved = dir
  const { manifest } = await transform([entry('index.html', bytes.byteLength)])
  expect(manifest[0]?.integrity).toBe(expected(bytes))
})
