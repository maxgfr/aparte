/*
 * The bundled catalog (catalog.json, built by scripts/build-catalog.ts) and its helpers: the adapter each provider is
 * called through, native model ids, the capability fields kept, and the budget of the lazy chunk.
 */
import { describe, expect, test } from 'bun:test'
import { resolveCapabilities } from './capabilities.ts'
import {
  type Catalog,
  catalogModelInfo,
  findModel,
  kindFor,
  loadBundledCatalog,
  nativeModelId,
  providerFields,
  sortedProviders,
  toCatalogModels,
} from './catalog.ts'
import { baseUrlProblem, customProviderFields, LOCAL_PRESETS, normalizeBaseUrl } from './endpoints.ts'

const catalog: Catalog = await loadBundledCatalog()

describe('the bundled catalog', () => {
  test('is version 1, within its gzip budget, and lists the makers first', async () => {
    expect(catalog.version).toBe(1)
    const bytes = await Bun.file(new URL('catalog.json', import.meta.url)).bytes()
    expect(Bun.gzipSync(bytes).byteLength).toBeLessThanOrEqual(200 * 1024)
    expect(
      sortedProviders(catalog)
        .slice(0, 5)
        .map((p) => p.id),
    ).toEqual(['anthropic', 'openai', 'google', 'openrouter', 'mistral'])
  })

  test('every provider has a callable kind, an https base URL when it needs one, and models', () => {
    for (const p of catalog.providers) {
      expect(['anthropic', 'openai', 'google', 'mistral', 'openrouter', 'openai-compatible']).toContain(p.kind)
      if (p.kind === 'openai-compatible') expect(p.api?.startsWith('https://')).toBe(true)
      if (p.api !== undefined) {
        expect(baseUrlProblem(p.api)).toBeNull()
        expect(p.api.endsWith('/')).toBe(false)
      }
      expect(p.models.length).toBeGreaterThan(0)
    }
  })

  test('OpenAI-compatible makers are called at their compatible endpoint', () => {
    const groq = catalog.providers.find((p) => p.id === 'groq')
    if (groq) {
      expect(groq.kind).toBe('openai-compatible')
      expect(providerFields(groq)).toEqual({
        kind: 'openai-compatible',
        label: groq.name,
        baseUrl: 'https://api.groq.com/openai/v1',
        preset: 'groq',
      })
    }
  })

  test('catalog entries resolve to capabilities, the pinned Claude table winning', () => {
    const opus = findModel(catalog, { kind: 'anthropic' }, 'claude-opus-5-5')
    if (opus) {
      const caps = resolveCapabilities({ kind: 'anthropic', modelId: opus.id, catalog: catalogModelInfo(opus) })
      expect(caps.forcedToolChoice).toBe(false)
      expect(caps.contextWindow).toBe(1_000_000)
    }
  })
})

describe('helpers', () => {
  test('kindFor', () => {
    expect(kindFor({ id: 'anthropic' })).toBe('anthropic')
    expect(kindFor({ id: 'minimax', npm: '@ai-sdk/anthropic', api: 'https://api.minimax.io/anthropic/v1' })).toBe(
      'anthropic',
    )
    expect(kindFor({ id: 'openai', npm: '@ai-sdk/openai' })).toBe('openai')
    expect(kindFor({ id: 'some-proxy', npm: '@ai-sdk/openai', api: 'https://x.example/v1' })).toBe('openai-compatible')
    expect(kindFor({ id: 'groq', npm: '@ai-sdk/groq' })).toBe('openai-compatible')
    expect(kindFor({ id: 'azure', npm: '@ai-sdk/azure', api: 'https://x.openai.azure.com' })).toBeUndefined()
    expect(kindFor({ id: 'nothing' })).toBeUndefined()
  })

  test('native ids and the kept fields', () => {
    expect(nativeModelId('groq', { id: 'groq/llama-3.3', name: 'Llama' })).toBe('llama-3.3')
    expect(nativeModelId('groq', { id: 'x', name: 'x', api_id: 'native' })).toBe('native')
    expect(nativeModelId('groq', { id: 'groq/x', name: 'x', sources: { openrouter: true, models_dev: false } })).toBe(
      undefined,
    )
    const [m] = toCatalogModels('p', [
      {
        id: 'p/m',
        name: 'M',
        context_length: 1000,
        output_limit: 100,
        modalities: { input: ['text', 'image', 'file'], output: ['text'] },
        capabilities: { reasoning: true, tool_call: true },
        cost: { input: 1, output: 2, cache_read: 0.1 },
        supported_parameters: ['temperature', 'logit_bias', 'tools'],
        release_date: '2026-01-01',
      },
      { id: 'p/embed', name: 'E', modalities: { input: ['text'], output: ['embedding'] } },
      { id: 'p/old', name: 'O', status: 'deprecated' },
    ])
    expect(m).toEqual({
      id: 'm',
      name: 'M',
      ctx: 1000,
      out: 100,
      in: ['image', 'pdf'],
      r: true,
      t: true,
      cost: [1, 2, 0.1, 0],
      params: ['temperature', 'tools'],
      released: '2026-01-01',
    })
    expect(catalogModelInfo(m as never)).toEqual({
      id: 'm',
      name: 'M',
      contextWindow: 1000,
      maxOutput: 100,
      input: ['text', 'image', 'pdf'],
      reasoning: true,
      toolCall: true,
      cost: { input: 1, output: 2, cacheRead: 0.1 },
    })
  })
})

describe('endpoints', () => {
  test('https anywhere, plain http on localhost and 127.0.0.1 only, never credentials', () => {
    expect(baseUrlProblem('https://api.example.org/v1')).toBeNull()
    expect(baseUrlProblem('http://localhost:11434/v1')).toBeNull()
    expect(baseUrlProblem('http://127.0.0.1:1234/v1')).toBeNull()
    expect(baseUrlProblem('http://192.168.1.2:11434/v1')).toBe('insecure-endpoint')
    expect(baseUrlProblem('http://[::1]:11434/v1')).toBe('insecure-endpoint')
    expect(baseUrlProblem('https://user:pass@api.example.org/v1')).toBe('invalid-endpoint')
    expect(baseUrlProblem('ftp://example.org')).toBe('invalid-endpoint')
    expect(normalizeBaseUrl(' https://api.example.org/v1/ ')).toBe('https://api.example.org/v1')
  })

  test('local presets become OpenAI-compatible providers', () => {
    expect(LOCAL_PRESETS.map((p) => p.id)).toEqual(['ollama', 'lmstudio', 'jan'])
    expect(customProviderFields(LOCAL_PRESETS[0] as never)).toEqual({
      kind: 'openai-compatible',
      label: 'Ollama',
      baseUrl: 'http://localhost:11434/v1',
      preset: 'ollama',
    })
    expect(customProviderFields({ id: 'custom', name: 'Mine', endpoint: 'http://10.0.0.2/v1' })).toBeNull()
  })
})
