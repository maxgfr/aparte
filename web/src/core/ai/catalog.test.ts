/*
 * The bundled catalog (catalog.json, built by scripts/build-catalog.ts) and its helpers: the adapter each provider is
 * called through, native model ids, the capability fields kept, and the budget of the lazy chunk. Then the full list
 * (catalog-all.json): the providers a browser reaches only through a proxy, the ones no adapter speaks to, how they
 * merge into the bundled catalog and the badge each one gets.
 */
import { describe, expect, test } from 'bun:test'
import { resolveCapabilities } from './capabilities.ts'
import {
  type Catalog,
  type CatalogProvider,
  catalogEntryOf,
  catalogModelInfo,
  findForeign,
  findModel,
  findProvider,
  kindFor,
  listedProviders,
  loadAllCatalog,
  loadBundledCatalog,
  mergeCatalogs,
  nativeModelId,
  needsProxy,
  providerFields,
  reachOf,
  sortedProviders,
  toCatalogModels,
} from './catalog.ts'
import { baseUrlProblem, customProviderFields, LOCAL_PRESETS, normalizeBaseUrl } from './endpoints.ts'

const catalog: Catalog = await loadBundledCatalog()
const all: Catalog = await loadAllCatalog()

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

const CALLABLE_KINDS = ['anthropic', 'openai', 'google', 'mistral', 'openrouter', 'openai-compatible']

describe('the full list', () => {
  test('is version 1, within its gzip budget, and lists no provider of the bundled catalog', async () => {
    expect(all.version).toBe(1)
    const bytes = await Bun.file(new URL('catalog-all.json', import.meta.url)).bytes()
    expect(Bun.gzipSync(bytes).byteLength).toBeLessThanOrEqual(400 * 1024)
    const bundled = new Set(catalog.providers.map((p) => p.id))
    for (const p of [...all.providers, ...(all.foreign ?? [])]) expect(bundled.has(p.id)).toBe(false)
    expect(all.providers.length).toBeGreaterThan(0)
    expect(all.foreign?.length ?? 0).toBeGreaterThan(0)
  })

  test('every provider behind a proxy has a callable kind, models, and an https address when it has one', () => {
    const ids = new Set<string>()
    for (const p of all.providers) {
      expect(p.reach).toBe('proxy')
      expect(CALLABLE_KINDS).toContain(p.kind)
      expect(p.models.length).toBeGreaterThan(0)
      if (p.api !== undefined) expect(baseUrlProblem(p.api)).toBeNull()
      expect(ids.has(p.id)).toBe(false)
      ids.add(p.id)
    }
    // Local servers are the app's own presets, at the user's address.
    for (const preset of LOCAL_PRESETS) expect(ids.has(preset.id)).toBe(false)
  })

  test('the foreign providers are the ones no adapter speaks to, with their models', () => {
    for (const p of all.foreign ?? []) {
      expect('kind' in p).toBe(false)
      expect(kindFor({ id: p.id, ...(p.npm === undefined ? {} : { npm: p.npm }) })).toBeUndefined()
      expect(p.models.length).toBeGreaterThan(0)
    }
    expect(findForeign(all, 'azure')?.npm).toBe('@ai-sdk/azure')
  })

  test('models keep their context, input, reasoning and tools', () => {
    const models = all.providers.flatMap((p) => p.models)
    expect(models.some((m) => m.ctx !== undefined && m.ctx > 0)).toBe(true)
    expect(models.some((m) => m.in?.includes('image'))).toBe(true)
    expect(models.some((m) => m.r === true)).toBe(true)
    expect(models.some((m) => m.t === true)).toBe(true)
  })
})

describe('merging the full list', () => {
  const direct: CatalogProvider = {
    id: 'alpha',
    name: 'Alpha',
    kind: 'openai-compatible',
    api: 'https://a.example/v1',
    models: [{ id: 'a1', name: 'A1' }],
  }
  const behind: CatalogProvider = {
    id: 'beta',
    name: 'Beta',
    kind: 'openai-compatible',
    api: 'https://b.example/v1',
    reach: 'proxy',
    models: [{ id: 'b1', name: 'B1', ctx: 1000, r: true }],
  }
  const native: CatalogProvider = {
    id: 'gamma',
    name: 'Gamma',
    kind: 'anthropic',
    api: 'https://g.example/anthropic/v1',
    reach: 'proxy',
    models: [{ id: 'g1', name: 'G1' }],
  }
  const bundled: Catalog = { version: 1, builtAt: '2026-10-18T00:00:00.000Z', providers: [direct] }
  const extra: Catalog = {
    version: 1,
    builtAt: '2026-10-18T00:00:00.000Z',
    providers: [{ ...direct, reach: 'proxy', name: 'Alpha (stale)' }, behind, native, behind],
    foreign: [
      { id: 'delta', name: 'Delta', npm: '@ai-sdk/azure', models: [{ id: 'd1', name: 'D1' }] },
      { id: 'beta', name: 'Beta again', models: [] },
    ],
  }
  const merged = mergeCatalogs(bundled, extra)

  test('the bundled entry wins, each id is kept once, and the added ones are behind a proxy', () => {
    expect(merged.providers.map((p) => p.id)).toEqual(['alpha', 'beta', 'gamma'])
    expect(findProvider(merged, 'alpha')).toBe(direct)
    expect(findProvider(merged, 'beta')?.reach).toBe('proxy')
    expect(merged.foreign?.map((p) => p.id)).toEqual(['delta'])
    expect(mergeCatalogs(catalog, all).providers.length).toBe(catalog.providers.length + all.providers.length)
  })

  test('badges: direct, proxy or none, listed recommended first, then direct, proxy and none', () => {
    expect(reachOf(direct)).toBe('direct')
    expect(reachOf(behind)).toBe('proxy')
    expect(reachOf(findForeign(merged, 'delta') as never)).toBe('none')
    expect(listedProviders(merged)).toEqual([
      { id: 'alpha', name: 'Alpha', reach: 'direct' },
      { id: 'beta', name: 'Beta', reach: 'proxy' },
      { id: 'gamma', name: 'Gamma', reach: 'proxy' },
      { id: 'delta', name: 'Delta', reach: 'none' },
    ])
    const real = listedProviders(mergeCatalogs(catalog, all))
    expect(real.slice(0, 5).map((p) => p.id)).toEqual(['anthropic', 'openai', 'google', 'openrouter', 'mistral'])
    expect(real.find((p) => p.id === 'azure')?.reach).toBe('none')
  })

  test('a provider behind a proxy keeps its catalog id, and needs a proxy until its base URL names one', () => {
    expect(providerFields(behind)).toEqual({
      kind: 'openai-compatible',
      label: 'Beta',
      baseUrl: 'https://b.example/v1',
      preset: 'beta',
    })
    expect(providerFields(native)).toMatchObject({ kind: 'anthropic', preset: 'gamma' })
    expect(needsProxy(behind, { baseUrl: 'https://b.example/v1' })).toBe(true)
    expect(needsProxy(behind, {})).toBe(true)
    expect(needsProxy(behind, { baseUrl: 'http://localhost:4000/v1' })).toBe(false)
    expect(needsProxy(direct, { baseUrl: 'https://a.example/v1' })).toBe(false)
    expect(needsProxy(undefined, {})).toBe(false)
  })

  test('a configured provider finds its entry through its preset, whatever its kind', () => {
    expect(catalogEntryOf(merged, { kind: 'anthropic', preset: 'gamma' })).toBe(native)
    expect(findModel(merged, { kind: 'anthropic', preset: 'gamma' }, 'g1')?.name).toBe('G1')
    expect(findModel(merged, { kind: 'openai-compatible', preset: 'beta' }, 'b1')?.ctx).toBe(1000)
    // A preset of another kind, or a local server's, is not that entry.
    expect(catalogEntryOf(merged, { kind: 'openai-compatible', preset: 'gamma' })).toBeUndefined()
    expect(catalogEntryOf(merged, { kind: 'openai-compatible', preset: 'ollama' })).toBeUndefined()
    expect(catalogEntryOf(catalog, { kind: 'anthropic' })?.id).toBe('anthropic')
  })
})
