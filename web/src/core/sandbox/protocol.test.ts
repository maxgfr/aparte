import { describe, expect, test } from 'bun:test'
import { DEFAULT_LIMITS, MAX_LIMITS } from '../contracts/sandbox.ts'
import {
  capText,
  isFileName,
  isLimits,
  isRasterImage,
  MAX_CODE_CHARS,
  MAX_HEIGHT,
  mediaTypeFor,
  PROTOCOL,
  parseFromArtifact,
  parseFromRunner,
  parseFromWorker,
  parseToArtifact,
  parseToRunner,
  parseToWorker,
} from './protocol.ts'

const id = '0123456789abcdef0123456789abcdef'
const sha = 'a'.repeat(64)
const file = () => ({ name: 'data.csv', mediaType: 'text/csv', data: new ArrayBuffer(4) })

const run = (over: Record<string, unknown> = {}) => ({
  p: PROTOCOL,
  type: 'run',
  id,
  language: 'python',
  code: 'print(1)',
  files: [file()],
  assets: [
    { name: 'pyodide.js', sha256: sha, data: new ArrayBuffer(1) },
    { name: 'pyodide.asm.wasm', sha256: sha },
  ],
  packages: ['numpy', 'python-dateutil'],
  limits: { ...DEFAULT_LIMITS },
  ...over,
})

const result = (over: Record<string, unknown> = {}) => ({
  status: 'ok',
  stdout: 'hi\n',
  stderr: '',
  truncated: false,
  files: [file()],
  images: [],
  packages: [],
  durationMs: 12,
  ...over,
})

describe('app → runner', () => {
  test('accepts a well-formed run and a cancel', () => {
    expect(parseToRunner(run())).not.toBeNull()
    expect(parseToRunner({ p: PROTOCOL, type: 'cancel', id })).toEqual({ p: PROTOCOL, type: 'cancel', id })
  })

  test.each([
    ['another protocol', { p: 'aparte-sandbox/0' }],
    ['an unknown language', { language: 'ruby' }],
    ['a short id', { id: 'abc' }],
    ['an uppercase id', { id: id.toUpperCase() }],
    ['code over the limit', { code: 'x'.repeat(MAX_CODE_CHARS + 1) }],
    ['a file with a path', { files: [{ ...file(), name: '../secret' }] }],
    ['a file with a slash', { files: [{ ...file(), name: 'a/b.txt' }] }],
    ['a dot file', { files: [{ ...file(), name: '.env' }] }],
    ['a file whose data is not an ArrayBuffer', { files: [{ ...file(), data: new Uint8Array(2) }] }],
    ['a file with an extra key', { files: [{ ...file(), path: '/etc' }] }],
    ['a bad media type', { files: [{ ...file(), mediaType: 'text/html; charset=utf-8' }] }],
    ['an asset with a bad hash', { assets: [{ name: 'pyodide.js', sha256: 'A'.repeat(64) }] }],
    ['an asset name with a path', { assets: [{ name: '../x.whl', sha256: sha }] }],
    ['an asset with an extra key', { assets: [{ name: 'x.whl', sha256: sha, url: 'https://evil.example/' }] }],
    ['a package with a space', { packages: ['numpy pandas'] }],
    ['limits over the caps', { limits: { ...DEFAULT_LIMITS, timeoutMs: MAX_LIMITS.timeoutMs + 1 } }],
    ['fractional limits', { limits: { ...DEFAULT_LIMITS, memoryBytes: 1.5 } }],
    ['missing limits', { limits: { timeoutMs: 1000 } }],
    ['an unknown key', { origin: 'https://evil.example' }],
  ])('refuses %s', (_name, over) => {
    expect(parseToRunner(run(over))).toBeNull()
  })

  test('refuses what is not a message', () => {
    for (const value of [null, undefined, 'run', 42, [], [run()], { ...run(), type: 'start' }])
      expect(parseToRunner(value)).toBeNull()
  })
})

describe('runner → app', () => {
  test('accepts ready and a result', () => {
    expect(parseFromRunner({ p: PROTOCOL, type: 'ready', frame: 'runner' })).not.toBeNull()
    expect(parseFromRunner({ p: PROTOCOL, type: 'result', id, result: result({ value: '42' }) })).not.toBeNull()
  })

  test.each([
    ['the artifact frame ready', { p: PROTOCOL, type: 'ready', frame: 'artifact' }],
    ['an unknown status', { p: PROTOCOL, type: 'result', id, result: result({ status: 'escaped' }) }],
    ['a negative duration', { p: PROTOCOL, type: 'result', id, result: result({ durationMs: -1 }) }],
    ['stdout over the cap', { p: PROTOCOL, type: 'result', id, result: result({ stdout: 'x'.repeat(200_000) }) }],
    ['an extra result key', { p: PROTOCOL, type: 'result', id, result: result({ html: '<b>' }) }],
    ['an unsafe file', { p: PROTOCOL, type: 'result', id, result: result({ files: [{ ...file(), name: '..' }] }) }],
    ['a non-boolean truncated', { p: PROTOCOL, type: 'result', id, result: result({ truncated: 'no' }) }],
  ])('refuses %s', (_name, value) => {
    expect(parseFromRunner(value)).toBeNull()
  })
})

describe('artifact frame', () => {
  const render = (over: Record<string, unknown> = {}) => ({
    p: PROTOCOL,
    type: 'render',
    id,
    kind: 'html',
    source: '<p>hi</p>',
    run: false,
    theme: 'light',
    assets: [],
    ...over,
  })

  test('accepts a render, and ready, rendered, height and failed back', () => {
    expect(parseToArtifact(render())).not.toBeNull()
    expect(
      parseToArtifact(render({ kind: 'mermaid', assets: [{ name: 'mermaid.min.js', sha256: sha }] })),
    ).not.toBeNull()
    expect(parseFromArtifact({ p: PROTOCOL, type: 'ready', frame: 'artifact' })).not.toBeNull()
    expect(parseFromArtifact({ p: PROTOCOL, type: 'rendered', id, height: 300 })).not.toBeNull()
    expect(parseFromArtifact({ p: PROTOCOL, type: 'height', id, height: 0 })).not.toBeNull()
    expect(parseFromArtifact({ p: PROTOCOL, type: 'failed', id, message: 'Parse error' })).not.toBeNull()
  })

  test.each([
    ['a react artifact', render({ kind: 'react' })],
    ['a run flag that is not a boolean', render({ run: 'yes' })],
    ['an unknown theme', render({ theme: 'sepia' })],
  ])('the frame refuses %s', (_name, value) => {
    expect(parseToArtifact(value)).toBeNull()
  })

  test.each([
    ['a height over the cap', { p: PROTOCOL, type: 'height', id, height: MAX_HEIGHT + 1 }],
    ['a fractional height', { p: PROTOCOL, type: 'rendered', id, height: 10.5 }],
    ['a navigation request', { p: PROTOCOL, type: 'navigate', id, url: 'https://evil.example/' }],
    ['the runner ready', { p: PROTOCOL, type: 'ready', frame: 'runner' }],
  ])('the app refuses %s', (_name, value) => {
    expect(parseFromArtifact(value)).toBeNull()
  })
})

describe('frame ↔ worker', () => {
  test('a start message, output and done', () => {
    const start = {
      p: PROTOCOL,
      type: 'start',
      language: 'javascript',
      code: 'return 1',
      files: [],
      assets: [{ name: 'pyodide.js', data: new ArrayBuffer(1) }],
      packages: [],
      limits: { ...DEFAULT_LIMITS },
    }
    expect(parseToWorker(start)).not.toBeNull()
    expect(parseToWorker({ ...start, assets: [{ name: 'pyodide.js', sha256: sha }] })).toBeNull()
    expect(parseFromWorker({ p: PROTOCOL, type: 'out', stream: 'stdout', text: 'hi\n' })).not.toBeNull()
    expect(parseFromWorker({ p: PROTOCOL, type: 'out', stream: 'stdin', text: 'hi\n' })).toBeNull()
    const done = { p: PROTOCOL, type: 'done', status: 'ok', files: [], images: [], packages: [] }
    expect(parseFromWorker(done)).not.toBeNull()
    expect(parseFromWorker({ ...done, value: '1', error: 'x' })).not.toBeNull()
    // A worker cannot claim a status only the frame decides.
    expect(parseFromWorker({ ...done, status: 'timeout' })).toBeNull()
    expect(parseFromWorker({ ...done, status: 'cancelled' })).toBeNull()
  })
})

describe('helpers', () => {
  test('file names are one plain segment', () => {
    for (const ok of ['data.csv', 'figure 1.png', 'résumé.txt', 'a_b-c(1).json', '数据.csv'])
      expect(isFileName(ok)).toBe(true)
    for (const bad of ['', '.', '..', '.hidden', 'a/b', 'a\\b', 'a..b', 'x\u0000y', 'x\ny', 'c:d', 'x'.repeat(129), 42])
      expect(isFileName(bad)).toBe(false)
  })

  test('limits must all be positive integers within the caps', () => {
    expect(isLimits(DEFAULT_LIMITS)).toBe(true)
    expect(isLimits(MAX_LIMITS)).toBe(true)
    expect(isLimits({ ...DEFAULT_LIMITS, maxFiles: 0 })).toBe(false)
    expect(isLimits({ ...DEFAULT_LIMITS, extra: 1 })).toBe(false)
  })

  test('capText keeps the start and the end', () => {
    expect(capText('short', 10)).toEqual({ text: 'short', cut: false })
    const long = `${'a'.repeat(500)}${'z'.repeat(500)}`
    const { text, cut } = capText(long, 200)
    expect(cut).toBe(true)
    expect(text.length).toBeLessThanOrEqual(200)
    expect(text.startsWith('aaa')).toBe(true)
    expect(text.endsWith('zzz')).toBe(true)
    expect(text).toContain('characters cut')
  })

  test('media types by extension, and which are raster images', () => {
    expect(mediaTypeFor('a.PNG')).toBe('image/png')
    expect(mediaTypeFor('report.csv')).toBe('text/csv')
    expect(mediaTypeFor('page.html')).toBe('text/html')
    expect(mediaTypeFor('noext')).toBe('application/octet-stream')
    expect(isRasterImage('image/png')).toBe(true)
    expect(isRasterImage('image/svg+xml')).toBe(false)
  })
})
