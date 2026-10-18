import { describe, expect, test } from 'bun:test'
import { type EngineChunk, LocalModelError } from '../../contracts/local.ts'
import { connectEngine, type EngineBackend, fromWire, isEngineRequest, serveEngine, toWire } from './engine.ts'
import { workerChannel } from './fakes.ts'

function backend(over: Partial<EngineBackend> = {}): EngineBackend & { loads: [string, boolean][] } {
  const loads: [string, boolean][] = []
  return {
    loads,
    async load(modelId, download, onProgress) {
      loads.push([modelId, download])
      onProgress({ fraction: 0.5, text: 'half' })
      onProgress({ fraction: 1, text: 'done' })
    },
    async *chat(request) {
      yield { type: 'delta', text: `echo:${request.messages.at(-1)?.content}` }
      yield { type: 'done', finish: 'stop', usage: { input: 3, output: 2 } }
    },
    ...over,
  }
}

async function collect(it: AsyncIterable<EngineChunk>): Promise<EngineChunk[]> {
  const out: EngineChunk[] = []
  for await (const c of it) out.push(c)
  return out
}

const chatRequest = { modelId: 'm', messages: [{ role: 'user' as const, content: 'hi' }] }

describe('engine protocol', () => {
  test('load reports progress and resolves', async () => {
    const { worker, scope } = workerChannel()
    const b = backend()
    serveEngine(scope, b)
    const engine = connectEngine(worker)
    const seen: number[] = []
    await engine.load('m', { download: true, onProgress: (p) => seen.push(p.fraction) })
    expect(seen).toEqual([0.5, 1])
    expect(b.loads).toEqual([['m', true]])
  })

  test('chat streams the chunks in order', async () => {
    const { worker, scope } = workerChannel()
    serveEngine(scope, backend())
    const chunks = await collect(connectEngine(worker).chat(chatRequest, new AbortController().signal))
    expect(chunks).toEqual([
      { type: 'delta', text: 'echo:hi' },
      { type: 'done', finish: 'stop', usage: { input: 3, output: 2 } },
    ])
  })

  test('errors keep their local code across the boundary', async () => {
    const { worker, scope } = workerChannel()
    serveEngine(
      scope,
      backend({
        load: async () => {
          throw new LocalModelError('not-downloaded', 'nope')
        },
      }),
    )
    const error = await connectEngine(worker)
      .load('m', { download: false })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LocalModelError)
    expect((error as LocalModelError).code).toBe('not-downloaded')
  })

  test('aborting a chat tells the worker and ends the iteration', async () => {
    const { worker, scope } = workerChannel()
    let aborted = false
    serveEngine(
      scope,
      backend({
        async *chat(_r, signal) {
          yield { type: 'delta', text: 'a' }
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
          aborted = true
        },
      }),
    )
    const controller = new AbortController()
    const out: EngineChunk[] = []
    for await (const c of connectEngine(worker).chat(chatRequest, controller.signal)) {
      out.push(c)
      controller.abort()
    }
    expect(out).toEqual([{ type: 'delta', text: 'a' }])
    await new Promise((r) => setTimeout(r, 0))
    expect(aborted).toBe(true)
  })

  test('aborting a load stops the worker', async () => {
    const { worker, scope } = workerChannel()
    serveEngine(scope, backend({ load: () => new Promise(() => {}) }))
    const engine = connectEngine(worker)
    const controller = new AbortController()
    const loading = engine.load('m', { download: true, signal: controller.signal })
    controller.abort()
    await expect(loading).rejects.toBeDefined()
    expect(worker.terminated).toBe(true)
    await expect(engine.load('m', { download: true })).rejects.toBeInstanceOf(LocalModelError)
  })

  test('a crashed worker fails what is pending and what comes next', async () => {
    const { worker, scope } = workerChannel()
    serveEngine(scope, backend({ load: () => new Promise(() => {}) }))
    const engine = connectEngine(worker)
    const loading = engine.load('m', { download: true })
    worker.crash('out of memory')
    await expect(loading).rejects.toThrow('out of memory')
    await expect(collect(engine.chat(chatRequest, new AbortController().signal))).rejects.toThrow('out of memory')
  })

  test('ignores messages that are not requests', () => {
    expect(isEngineRequest({ id: 1, op: 'load', modelId: 'm' })).toBe(true)
    expect(isEngineRequest({ id: '1', op: 'load' })).toBe(false)
    expect(isEngineRequest({ id: 1, op: 'eval' })).toBe(false)
    expect(isEngineRequest(null)).toBe(false)
  })

  test('wire errors', () => {
    expect(fromWire(toWire(new DOMException('stop', 'AbortError'))).name).toBe('AbortError')
    expect(fromWire({ name: 'X', message: 'm', code: 'bogus' as never })).not.toBeInstanceOf(LocalModelError)
    expect(toWire('plain')).toEqual({ name: 'Error', message: 'plain' })
  })
})
