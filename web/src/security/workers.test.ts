import { afterAll, describe, expect, test } from 'bun:test'
import { createWorker } from './workers.ts'

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
