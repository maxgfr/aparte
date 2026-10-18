import { afterAll, describe, expect, test } from 'bun:test'
import { createBlobWorker, createWorker } from './workers.ts'

const g = globalThis as Record<string, unknown>
const saved = { Worker: g.Worker, location: g.location }
const started: Array<{ url: unknown; options: WorkerOptions | undefined }> = []

g.location = new URL('https://maxgfr.github.io/')
g.Worker = class {
  constructor(url: unknown, options?: WorkerOptions) {
    started.push({ url, options })
  }
}

afterAll(() => {
  Object.assign(g, saved)
})

describe('createWorker', () => {
  test('starts a module worker from a built chunk, keeping the other options', () => {
    createWorker('/assets/engine-abc123.js', { name: 'engine', type: 'classic' })
    expect(started).toHaveLength(1)
    const [worker] = started
    // A TrustedScriptURL where the page has Trusted Types (init.test.ts may have installed a fake), else the href.
    expect(JSON.stringify(worker?.url)).toContain('https://maxgfr.github.io/assets/engine-abc123.js')
    expect(worker?.options).toEqual({ name: 'engine', type: 'module' })
  })

  test.each([
    'https://evil.example/assets/engine.js',
    'data:text/javascript,postMessage(1)',
    'blob:https://maxgfr.github.io/1234',
    '/assets/engine.js?x=1',
  ])('refuses %s before starting anything', (url) => {
    const before = started.length
    expect(() => createWorker(url)).toThrow(TypeError)
    expect(started).toHaveLength(before)
  })
})

describe('createBlobWorker', () => {
  test('starts a classic worker from a blob: URL only', () => {
    const before = started.length
    createBlobWorker('blob:null/5e1b0c2a-2d3c-4b8e-9a0f-1c2d3e4f5a6b')
    expect(started).toHaveLength(before + 1)
    expect(started.at(-1)).toEqual({ url: 'blob:null/5e1b0c2a-2d3c-4b8e-9a0f-1c2d3e4f5a6b', options: undefined })
  })

  test.each([
    'https://evil.example/w.js',
    'data:text/javascript,postMessage(1)',
    '/aparte/sandbox/runner.js',
    ' blob:null/x',
  ])('refuses %s', (url) => {
    const before = started.length
    expect(() => createBlobWorker(url)).toThrow(TypeError)
    expect(started).toHaveLength(before)
  })
})
