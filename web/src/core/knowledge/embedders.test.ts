import { describe, expect, test } from 'bun:test'
import type { FetchLike, ProviderConfig, ProviderKind } from '../contracts/ai.ts'
import { ExtractError } from '../contracts/knowledge.ts'
import { createApiEmbedder, EmbeddingError, providerEmbedderKey } from './embedders.ts'
import { makeDocx } from './testkit.ts'
import { connectExtractor, type ExtractRequest, type ExtractResponse, serveExtractor } from './worker.ts'

const provider = (kind: ProviderKind, extra: Partial<ProviderConfig> = {}): ProviderConfig =>
  ({ id: 'providerid', kind, label: kind, syncKey: false, createdAt: 0, updatedAt: 0, ...extra }) as ProviderConfig

interface Seen {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function fakeFetch(
  answer: (body: Record<string, unknown>) => unknown,
  status = 200,
): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = []
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    seen.push({ url: String(input), headers, body })
    return new Response(JSON.stringify(answer(body)), { status, headers: { 'content-type': 'application/json' } })
  }
  return { fetch, seen }
}

describe('API embedders', () => {
  test('OpenAI: one batch, its own auth header only, vectors unit-length in input order', async () => {
    const { fetch, seen } = fakeFetch((body) => ({
      data: (body.input as string[]).map((_, i) => ({ index: i, embedding: [3 * (i + 1), 4 * (i + 1)] })).reverse(),
    }))
    const e = createApiEmbedder({
      provider: provider('openai'),
      model: 'text-embedding-3-small',
      apiKey: 'key-1',
      fetch,
    })
    expect(e.key).toBe(providerEmbedderKey('providerid', 'text-embedding-3-small'))
    const out = await e.embed(['a', 'b'])
    expect(out.map((v) => [...v].map((x) => Math.round(x * 100) / 100))).toEqual([
      [0.6, 0.8],
      [0.6, 0.8],
    ])
    expect(seen[0]?.url).toBe('https://api.openai.com/v1/embeddings')
    expect(seen[0]?.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer key-1' })
    expect(seen[0]?.body).toEqual({ model: 'text-embedding-3-small', input: ['a', 'b'], encoding_format: 'float' })
  })

  test('Gemini: batchEmbedContents with its key header and a reduced size', async () => {
    const { fetch, seen } = fakeFetch((body) => ({
      embeddings: (body.requests as unknown[]).map(() => ({ values: [1, 0, 0] })),
    }))
    const e = createApiEmbedder({ provider: provider('google'), model: 'gemini-embedding-001', apiKey: 'key-2', fetch })
    expect(await e.embed(['x'])).toHaveLength(1)
    expect(seen[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
    )
    expect(seen[0]?.headers['x-goog-api-key']).toBe('key-2')
    expect(seen[0]?.body).toEqual({
      requests: [
        { model: 'models/gemini-embedding-001', content: { parts: [{ text: 'x' }] }, outputDimensionality: 768 },
      ],
    })
  })

  test('Mistral and a keyless OpenAI-compatible server; long lists are split', async () => {
    const { fetch, seen } = fakeFetch((body) => ({
      data: (body.input as string[]).map((_, i) => ({ index: i, embedding: [1, 1] })),
    }))
    const m = createApiEmbedder({ provider: provider('mistral'), model: 'mistral-embed', apiKey: 'key-3', fetch })
    expect(await m.embed(Array.from({ length: 130 }, (_, i) => `t${i}`))).toHaveLength(130)
    expect(seen.map((s) => (s.body.input as string[]).length)).toEqual([64, 64, 2])
    expect(seen[0]?.url).toBe('https://api.mistral.ai/v1/embeddings')
    const local = createApiEmbedder({
      provider: provider('openai-compatible', { baseUrl: 'http://localhost:11434/v1' }),
      model: 'nomic-embed-text',
      apiKey: null,
      fetch,
    })
    await local.embed(['x'])
    expect(seen.at(-1)?.url).toBe('http://localhost:11434/v1/embeddings')
    expect(seen.at(-1)?.headers.authorization).toBeUndefined()
  })

  test('an HTTP error or a malformed answer is an error that never carries the key', async () => {
    const denied = fakeFetch(() => ({ error: { message: 'bad key key-4' } }), 401)
    const e = createApiEmbedder({ provider: provider('openai'), model: 'm', apiKey: 'key-4', fetch: denied.fetch })
    const error = await e.embed(['x']).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(EmbeddingError)
    expect((error as EmbeddingError).status).toBe(401)
    expect(String((error as Error).message)).not.toContain('key-4')
    const short = fakeFetch(() => ({ data: [] }))
    const s = createApiEmbedder({ provider: provider('openai'), model: 'm', apiKey: 'k', fetch: short.fetch })
    await expect(s.embed(['x'])).rejects.toBeInstanceOf(EmbeddingError)
    expect(() =>
      createApiEmbedder({ provider: provider('anthropic'), model: 'm', apiKey: 'k', fetch: short.fetch }),
    ).toThrow(EmbeddingError)
    expect(() =>
      createApiEmbedder({ provider: provider('openai'), model: 'm', apiKey: null, fetch: short.fetch }),
    ).toThrow(EmbeddingError)
  })
})

describe('knowledge worker protocol', () => {
  /** A worker and its page joined in memory, as structured clone would deliver. */
  function pair() {
    const toWorker: ((e: { data: unknown }) => void)[] = []
    const toPage: ((e: { data?: unknown; message?: string }) => void)[] = []
    serveExtractor({
      postMessage: (m: ExtractResponse) =>
        queueMicrotask(() => {
          for (const f of toPage) f({ data: structuredClone(m) })
        }),
      addEventListener: (_t, f) => toWorker.push(f),
    })
    let terminated = 0
    const extractor = connectExtractor(() => ({
      postMessage: (m: ExtractRequest) =>
        queueMicrotask(() => {
          for (const f of toWorker) f({ data: m })
        }),
      addEventListener: (_t, f) => toPage.push(f),
      terminate: () => terminated++,
    }))
    return { extractor, terminated: () => terminated }
  }

  test('a file goes over, its sections come back; a refusal keeps its kind', async () => {
    const { extractor } = pair()
    const out = await extractor.extract(makeDocx([{ heading: 'H' }, { p: 'Body text.' }]), 'docx')
    expect(out).toEqual({ format: 'docx', sections: [{ text: 'Body text.', heading: 'H' }] })
    const error = await extractor.extract(new Uint8Array([1, 2, 3]), 'docx').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ExtractError)
    expect((error as ExtractError).kind).toBe('corrupt')
  })

  test('an abort terminates the worker', async () => {
    const { extractor, terminated } = pair()
    const controller = new AbortController()
    const p = extractor.extract(makeDocx([{ p: 'x' }]), 'docx', controller.signal)
    controller.abort()
    await expect(p).rejects.toThrow()
    expect(terminated()).toBe(1)
  })
})
