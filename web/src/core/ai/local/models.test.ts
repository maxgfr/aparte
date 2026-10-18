import { describe, expect, test } from 'bun:test'
import { type LoadOptions, type LocalEngine, LocalModelError } from '../../contracts/local.ts'
import { modelBaseUrl, pinnedModel } from './catalog.ts'
import { fakeGpu, memoryCaches } from './fakes.ts'
import { createLocalModels } from './models.ts'
import { CACHE_PREFIX } from './pinnedCache.ts'

const SMOL = 'SmolLM2-360M-Instruct-q4f16_1-MLC'
const GiB = 1024 ** 3

/** An engine whose load "downloads" a model by writing its files in WebLLM's layout. */
function writingEngine(caches: ReturnType<typeof memoryCaches>['caches'], hold?: Promise<void>) {
  const loads: { id: string; options: LoadOptions }[] = []
  let disposed = 0
  const start = (): LocalEngine => ({
    async load(id, options) {
      loads.push({ id, options })
      if (!options.download) return
      const m = pinnedModel(id)
      if (!m) throw new Error('unknown')
      const base = modelBaseUrl(m)
      const model = await caches.open(`${CACHE_PREFIX}webllm/model`)
      await model.put(
        `${base}tensor-cache.json`,
        new Response(JSON.stringify({ records: [{ dataPath: 'params_shard_0.bin', nbytes: 1000 }] })),
      )
      options.onProgress?.({ fraction: 0.5, text: '' })
      if (hold) {
        await Promise.race([
          hold,
          new Promise((_, reject) =>
            options.signal?.addEventListener('abort', () => reject(new DOMException('stop', 'AbortError'))),
          ),
        ])
      }
      await model.put(`${base}params_shard_0.bin`, new Response('x'))
      await (await caches.open(`${CACHE_PREFIX}webllm/config`)).put(`${base}mlc-chat-config.json`, new Response('{}'))
      await (await caches.open(`${CACHE_PREFIX}webllm/wasm`)).put(m.lib.url, new Response('x'))
      options.onProgress?.({ fraction: 1, text: '' })
    },
    async *chat() {},
    dispose() {
      disposed++
    },
  })
  return { start, loads, disposed: () => disposed }
}

function service(
  o: { estimate?: { usage?: number; quota?: number } | null; gpu?: ReturnType<typeof fakeGpu> } = {},
  hold?: Promise<void>,
) {
  const { caches } = memoryCaches()
  const engine = writingEngine(caches, hold)
  const models = createLocalModels({
    env: () => ({ gpu: o.gpu ?? fakeGpu(), deviceMemory: 8 }),
    startEngine: engine.start,
    caches: () => caches,
    storage: () => {
      const e = o.estimate === undefined ? { usage: 0, quota: 100 * GiB } : o.estimate
      return e === null ? undefined : { estimate: async () => e }
    },
  })
  return { models, engine, caches }
}

describe('local models service', () => {
  test('download checks space, loads with download, and the model is then complete', async () => {
    const { models, engine } = service()
    expect((await models.state(SMOL)).complete).toBe(false)
    const progress: number[] = []
    await models.download(SMOL, (p) => progress.push(p.fraction))
    expect(progress).toEqual([0.5, 1])
    expect(engine.loads.map((l) => l.options.download)).toEqual([true])
    expect((await models.state(SMOL)).complete).toBe(true)
  })

  test('no space, unknown space, an unpinned model, a GPU that cannot run it', async () => {
    const tight = service({ estimate: { usage: 0, quota: GiB } })
    await expect(tight.models.download(SMOL)).rejects.toMatchObject({ code: 'no-space' })
    const unknown = service({ estimate: null })
    await expect(unknown.models.download(SMOL)).rejects.toMatchObject({ code: 'no-space' })
    expect(tight.engine.loads).toEqual([])
    await expect(service().models.download('nope')).rejects.toBeInstanceOf(LocalModelError)
    const noF16 = service({ gpu: fakeGpu({ shaderF16: false }) })
    await expect(noF16.models.download(SMOL)).rejects.toMatchObject({ code: 'unavailable' })
    const noGpu = createLocalModels({
      env: () => ({}),
      startEngine: () => {
        throw new Error('never')
      },
      caches: () => memoryCaches().caches,
      storage: () => undefined,
    })
    await expect(noGpu.download(SMOL)).rejects.toMatchObject({ code: 'unavailable' })
  })

  test('stopping a download keeps what was fetched; the next one resumes', async () => {
    let release = () => {}
    const hold = new Promise<void>((r) => {
      release = r
    })
    const { models } = service({}, hold)
    const controller = new AbortController()
    const first = models.download(SMOL, undefined, controller.signal)
    await new Promise((r) => setTimeout(r, 5))
    controller.abort()
    await expect(first).rejects.toBeDefined()
    const partial = await models.state(SMOL)
    expect(partial.complete).toBe(false)
    expect(partial.totalBytes).toBeGreaterThan(0)
    release()
    await models.download(SMOL)
    expect((await models.state(SMOL)).complete).toBe(true)
  })

  test('the chat engine never downloads, and remove deletes the files and frees the engine', async () => {
    const { models, engine } = service()
    await models.download(SMOL)
    const chat = models.engine()
    await chat.load(SMOL, { download: true })
    // The model is already the engine's: no second load.
    expect(engine.loads).toHaveLength(1)
    models.release()
    await chat.load(SMOL, { download: true })
    expect(engine.loads.at(-1)?.options.download).toBe(false)
    await models.remove(SMOL)
    expect((await models.state(SMOL)).complete).toBe(false)
    expect(engine.disposed()).toBeGreaterThan(0)
  })

  test('storage estimate and space', async () => {
    const { models } = service({ estimate: { usage: GiB, quota: 10 * GiB } })
    expect(await models.estimate()).toEqual({ usage: GiB, quota: 10 * GiB })
    expect((await models.space(SMOL)).ok).toBe(true)
  })
})
