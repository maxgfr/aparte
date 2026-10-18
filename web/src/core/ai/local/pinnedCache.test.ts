import { describe, expect, test } from 'bun:test'
import { LocalModelError } from '../../contracts/local.ts'
import { memoryCaches } from './fakes.ts'
import { CACHE_PREFIX, modelCacheState, pinnedCaches, removeModelFiles, sha256Hex } from './pinnedCache.ts'

const enc = new TextEncoder()
const BASE = 'https://huggingface.co/mlc-ai/m/resolve/0123/'
const LIB = 'https://raw.githubusercontent.com/mlc-ai/libs/abcd/m.wasm'

async function setup(files: Record<string, string>) {
  const digests = new Map<string, string>()
  for (const [url, body] of Object.entries(files)) digests.set(url, await sha256Hex(enc.encode(body)))
  const served = new Map(Object.entries(files))
  const downloads: string[] = []
  const inner = memoryCaches()
  let allow = true
  const caches = pinnedCaches(inner.caches, {
    digest: (url) => digests.get(url) ?? null,
    download: async (url) => {
      downloads.push(url)
      const body = served.get(url)
      return body === undefined ? new Response(null, { status: 404 }) : new Response(body)
    },
    allowDownload: () => allow,
  })
  return {
    caches,
    inner,
    downloads,
    served,
    setAllow: (v: boolean) => {
      allow = v
    },
  }
}

describe('pinnedCaches', () => {
  test('names caches with the app prefix', async () => {
    const { caches, inner } = await setup({})
    await caches.open('webllm/model')
    expect(await inner.caches.keys()).toEqual([`${CACHE_PREFIX}webllm/model`])
    expect(await caches.keys()).toEqual(['webllm/model'])
    expect(await caches.has('webllm/model')).toBe(true)
  })

  test('downloads a pinned file, checks it, and serves it back', async () => {
    const url = `${BASE}mlc-chat-config.json`
    const { caches, downloads } = await setup({ [url]: '{"a":1}' })
    const cache = await caches.open('webllm/config')
    expect(await cache.match(url)).toBeUndefined()
    await cache.add(new Request(url))
    expect(downloads).toEqual([url])
    expect(await (await cache.match(url))?.text()).toBe('{"a":1}')
  })

  test('refuses an unpinned URL without downloading', async () => {
    const { caches, downloads } = await setup({})
    const cache = await caches.open('webllm/model')
    const error = await cache.add('https://evil.example/x.bin').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(LocalModelError)
    expect((error as LocalModelError).code).toBe('unpinned')
    expect(downloads).toEqual([])
  })

  test('refuses a download whose bytes do not match, and stores nothing', async () => {
    const url = `${BASE}params_shard_0.bin`
    const { caches, served, inner } = await setup({ [url]: 'good' })
    served.set(url, 'evil')
    const cache = await caches.open('webllm/model')
    const error = await cache.add(url).catch((e: unknown) => e)
    expect((error as LocalModelError).code).toBe('integrity')
    expect(await (await inner.caches.open(`${CACHE_PREFIX}webllm/model`)).match(url)).toBeUndefined()
  })

  test('drops a planted entry instead of serving it', async () => {
    const url = `${BASE}params_shard_0.bin`
    const { caches, inner } = await setup({ [url]: 'good' })
    const raw = await inner.caches.open(`${CACHE_PREFIX}webllm/model`)
    await raw.put(url, new Response('planted'))
    await raw.put('https://huggingface.co/other/x', new Response('unpinned'))
    const cache = await caches.open('webllm/model')
    expect(await cache.match(url)).toBeUndefined()
    expect(await raw.match(url)).toBeUndefined()
    expect(await cache.match('https://huggingface.co/other/x')).toBeUndefined()
  })

  test('without download permission a missing file is not-downloaded', async () => {
    const url = `${BASE}params_shard_0.bin`
    const { caches, setAllow, downloads } = await setup({ [url]: 'good' })
    setAllow(false)
    const error = await (await caches.open('webllm/model')).add(url).catch((e: unknown) => e)
    expect((error as LocalModelError).code).toBe('not-downloaded')
    expect(downloads).toEqual([])
  })

  test('put checks the bytes as add does', async () => {
    const url = `${BASE}tensor-cache.json`
    const { caches } = await setup({ [url]: '[]' })
    const cache = await caches.open('webllm/model')
    await cache.put(url, new Response('[]'))
    await expect(cache.put(url, new Response('[1]'))).rejects.toBeInstanceOf(LocalModelError)
  })
})

describe('modelCacheState and removeModelFiles', () => {
  const list = JSON.stringify({
    records: [
      { dataPath: 'params_shard_0.bin', nbytes: 100 },
      { dataPath: 'params_shard_1.bin', nbytes: 50 },
    ],
  })
  const model = { baseUrl: BASE, libUrl: LIB, libBytes: 10, totalBytes: 999 }

  test('empty, partial, complete', async () => {
    const { caches } = memoryCaches()
    expect(await modelCacheState(caches, model)).toEqual({ complete: false, cachedBytes: 0, totalBytes: 999 })
    const m = await caches.open(`${CACHE_PREFIX}webllm/model`)
    await m.put(`${BASE}tensor-cache.json`, new Response(list))
    await m.put(`${BASE}params_shard_0.bin`, new Response('x'))
    expect(await modelCacheState(caches, model)).toEqual({ complete: false, cachedBytes: 100, totalBytes: 160 })
    await m.put(`${BASE}params_shard_1.bin`, new Response('x'))
    await (await caches.open(`${CACHE_PREFIX}webllm/wasm`)).put(LIB, new Response('x'))
    expect((await modelCacheState(caches, model)).complete).toBe(false)
    await (await caches.open(`${CACHE_PREFIX}webllm/config`)).put(`${BASE}mlc-chat-config.json`, new Response('{}'))
    expect(await modelCacheState(caches, model)).toEqual({ complete: true, cachedBytes: 160, totalBytes: 160 })

    const removed = await removeModelFiles(caches, (url) => url.startsWith(BASE) || url === LIB)
    expect(removed).toBe(5)
    expect((await modelCacheState(caches, model)).complete).toBe(false)
  })

  test('a malformed tensor list is incomplete', async () => {
    const { caches } = memoryCaches()
    await (await caches.open(`${CACHE_PREFIX}webllm/model`)).put(`${BASE}tensor-cache.json`, new Response('nope'))
    expect((await modelCacheState(caches, model)).complete).toBe(false)
  })
})
