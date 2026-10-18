/*
 * The model catalog: the cloud providers a web page can call directly, each with its models and what they accept.
 * Built at deploy time by web/scripts/build-catalog.ts from llm-models (models.dev and OpenRouter), keeping only the
 * providers that answered a real CORS preflight from the app's origin, and shipped as `catalog.json` in its own lazily
 * loaded chunk. The catalog never decides what a request may contain on its own: `resolveCapabilities` combines it
 * with the pinned tables and the user's overrides.
 *
 * The providers the probe refused, and the ones no adapter of ours speaks to, are written to `catalog-all.json`, a
 * second lazy chunk loaded only when the user asks to see every provider of llm-models (`allProviders`).
 */
import type { CatalogModelInfo, ModelCost, ProviderConfig, ProviderKind } from '../contracts/ai.ts'
import { LOCAL_PRESETS } from './endpoints.ts'

export const CATALOG_VERSION = 1

/** One model, with short keys: the catalog lists thousands of them. */
export interface CatalogModel {
  /** The id the provider's own API takes. */
  readonly id: string
  readonly name: string
  /** Context window in tokens. */
  readonly ctx?: number
  /** Output cap in tokens. */
  readonly out?: number
  /** Input modalities besides text (`image`, `pdf`, `audio`, `video`). */
  readonly in?: readonly string[]
  /** It reasons before answering. */
  readonly r?: true
  /** It takes function tools. */
  readonly t?: true
  /** US dollars per million tokens: input, output, then cache read and cache write when listed (0 when unknown). */
  readonly cost?: readonly number[]
  /** Request parameters OpenRouter lists for it (`temperature`, `top_p`, `tools`, `reasoning`...). */
  readonly params?: readonly string[]
  /** Release date, `YYYY-MM-DD`. */
  readonly released?: string
}

export interface CatalogProvider {
  /** models.dev id, also the `preset` of an OpenAI-compatible provider created from it. */
  readonly id: string
  readonly name: string
  readonly kind: ProviderKind
  /** Base URL, kept only when the kind has no default or the provider's differs from it. */
  readonly api?: string
  readonly doc?: string
  /**
   * `proxy` (in `catalog-all.json` only): an adapter of ours speaks its protocol, but a web page cannot call its API
   * directly. It refused the CORS preflight from the app's origin, asks for a header the adapters never send, or
   * documents no https address. It is reached through a proxy the user runs, at a base URL they give, or from the CLI.
   */
  readonly reach?: 'proxy'
  readonly models: readonly CatalogModel[]
}

/** A provider llm-models lists whose protocol no adapter of ours speaks (Azure, Bedrock, Vertex...): never callable. */
export interface ForeignProvider {
  readonly id: string
  readonly name: string
  /** The AI SDK package models.dev maps it to, which names its protocol. */
  readonly npm?: string
  readonly doc?: string
  readonly models: readonly CatalogModel[]
}

export interface Catalog {
  readonly version: typeof CATALOG_VERSION
  /** ISO 8601. */
  readonly builtAt: string
  readonly providers: readonly CatalogProvider[]
  /** Only in `catalog-all.json`, and in a catalog merged with it. */
  readonly foreign?: readonly ForeignProvider[]
}

/** How a browser reaches a provider of the list: directly, through a proxy the user runs, or not at all. */
export type Reach = 'direct' | 'proxy' | 'none'

/** Offered first: the makers' own APIs and the main aggregator. */
export const RECOMMENDED_PROVIDERS: readonly string[] = ['anthropic', 'openai', 'google', 'openrouter', 'mistral']

/**
 * Providers models.dev maps to a dedicated AI SDK package although their API also takes OpenAI chat completions at
 * this base URL (the table of llm-models' `OPENAI_COMPATIBLE_SDKS`, which it does not export). They are called through
 * the OpenAI-compatible adapter.
 */
export const OPENAI_COMPATIBLE_APIS: Readonly<Record<string, string>> = {
  cerebras: 'https://api.cerebras.ai/v1',
  cohere: 'https://api.cohere.ai/compatibility/v1',
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  groq: 'https://api.groq.com/openai/v1',
  perplexity: 'https://api.perplexity.ai',
  togetherai: 'https://api.together.xyz/v1',
  xai: 'https://api.x.ai/v1',
}

/** Packages whose providers speak a protocol none of our adapters does. */
const OTHER_PROTOCOLS: ReadonlySet<string> = new Set([
  '@ai-sdk/amazon-bedrock',
  '@ai-sdk/azure',
  '@ai-sdk/google-vertex',
  '@ai-sdk/google-vertex/anthropic',
  '@ai-sdk/gateway',
])

/**
 * Which adapter calls a provider, from its id, its AI SDK package and its base URL; undefined when none does. Only the
 * makers' own ids get their native adapter for OpenAI; any other server is called as OpenAI-compatible, the protocol
 * they all accept.
 */
export function kindFor(p: {
  readonly id: string
  readonly npm?: string
  readonly api?: string
}): ProviderKind | undefined {
  if (p.id === 'anthropic' || p.npm === '@ai-sdk/anthropic') return 'anthropic'
  if (p.id === 'openai') return 'openai'
  if (p.id === 'google' || p.npm === '@ai-sdk/google') return 'google'
  if (p.id === 'mistral' || p.npm === '@ai-sdk/mistral') return 'mistral'
  if (p.id === 'openrouter' || p.npm === '@openrouter/ai-sdk-provider') return 'openrouter'
  if (p.id in OPENAI_COMPATIBLE_APIS) return 'openai-compatible'
  if (p.npm !== undefined && OTHER_PROTOCOLS.has(p.npm)) return undefined
  if (p.npm === '@ai-sdk/openai-compatible' || p.npm === '@ai-sdk/openai' || p.api) return 'openai-compatible'
  return undefined
}

/** A model as llm-models lists it (`UnifiedModel`), reduced to what the catalog reads. */
export interface ModelInfoLike {
  readonly id: string
  readonly name: string
  readonly api_id?: string
  readonly sources?: { readonly openrouter?: boolean; readonly models_dev?: boolean }
  readonly context_length?: number
  readonly output_limit?: number
  readonly cost?: {
    readonly input: number
    readonly output: number
    readonly cache_read?: number
    readonly cache_write?: number
  }
  readonly modalities?: { readonly input?: readonly string[]; readonly output?: readonly string[] }
  readonly capabilities?: { readonly reasoning?: boolean; readonly tool_call?: boolean }
  readonly supported_parameters?: readonly string[]
  readonly release_date?: string
  readonly status?: string
}

/**
 * The id the provider's own API expects. llm-models lists models as `<provider>/<model>` and folds OpenRouter's
 * variants into the makers' lists; only models.dev entries are the provider's own, and their native id is the part
 * after the prefix. OpenRouter's list is its own API's ids either way.
 */
export function nativeModelId(providerId: string, m: ModelInfoLike): string | undefined {
  if (m.api_id !== undefined) return m.api_id
  const prefix = `${providerId}/`
  if (providerId === 'openrouter') {
    return m.sources?.models_dev && m.id.startsWith(prefix) ? m.id.slice(prefix.length) : m.id
  }
  if (m.sources && !m.sources.models_dev) return undefined
  return m.id.startsWith(prefix) ? m.id.slice(prefix.length) : m.id
}

/** Parameters worth keeping from OpenRouter's lists: the ones a request of ours may carry. */
const KEPT_PARAMS: ReadonlySet<string> = new Set([
  'temperature',
  'top_p',
  'top_k',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'tools',
  'tool_choice',
  'reasoning',
  'include_reasoning',
])

/** Whether a model is a chat model: text in and text out when its modalities are known, and not an embedder. */
function isChatModel(m: ModelInfoLike): boolean {
  if (m.status === 'deprecated') return false
  if (/embed/i.test(m.id)) return false
  const input = m.modalities?.input
  const output = m.modalities?.output
  if (input && input.length > 0 && !input.includes('text')) return false
  if (output && output.length > 0 && !output.includes('text')) return false
  return true
}

export function toCatalogModel(m: ModelInfoLike & { readonly id: string }): CatalogModel {
  // OpenRouter names document input `file`, models.dev `pdf`: both mean native PDF input.
  const extra = [...new Set((m.modalities?.input ?? []).map((x) => (x === 'file' ? 'pdf' : x)))].filter(
    (x) => x !== 'text',
  )
  const params = (m.supported_parameters ?? []).filter((x) => KEPT_PARAMS.has(x))
  const cost = m.cost
    ? m.cost.cache_read !== undefined || m.cost.cache_write !== undefined
      ? [m.cost.input, m.cost.output, m.cost.cache_read ?? 0, m.cost.cache_write ?? 0]
      : [m.cost.input, m.cost.output]
    : undefined
  return {
    id: m.id,
    name: m.name,
    ...(m.context_length ? { ctx: m.context_length } : {}),
    ...(m.output_limit ? { out: m.output_limit } : {}),
    ...(extra.length > 0 ? { in: extra } : {}),
    ...(m.capabilities?.reasoning ? { r: true as const } : {}),
    ...(m.capabilities?.tool_call ? { t: true as const } : {}),
    ...(cost ? { cost } : {}),
    ...(params.length > 0 ? { params } : {}),
    ...(m.release_date ? { released: m.release_date } : {}),
  }
}

/** The provider's chat models as the catalog keeps them: native ids only, each once. */
export function toCatalogModels(providerId: string, models: readonly ModelInfoLike[]): CatalogModel[] {
  const out: CatalogModel[] = []
  const seen = new Set<string>()
  for (const m of models) {
    const id = nativeModelId(providerId, m)
    if (id === undefined || seen.has(id) || !isChatModel(m)) continue
    seen.add(id)
    out.push(toCatalogModel({ ...m, id }))
  }
  return out
}

/** A catalog model in the terms `resolveCapabilities` reads. */
export function catalogModelInfo(m: CatalogModel): CatalogModelInfo {
  const [input, output, cacheRead, cacheWrite] = m.cost ?? []
  const cost: ModelCost | undefined =
    input === undefined || output === undefined
      ? undefined
      : {
          input,
          output,
          ...(cacheRead ? { cacheRead } : {}),
          ...(cacheWrite ? { cacheWrite } : {}),
        }
  return {
    id: m.id,
    name: m.name,
    ...(m.ctx === undefined ? {} : { contextWindow: m.ctx }),
    ...(m.out === undefined ? {} : { maxOutput: m.out }),
    input: ['text', ...(m.in ?? [])],
    ...(m.r ? { reasoning: true } : {}),
    ...(m.t ? { toolCall: true } : {}),
    ...(cost ? { cost } : {}),
  }
}

/** The catalog shipped with the app, in its own chunk, loaded the first time a screen needs it. */
export async function loadBundledCatalog(): Promise<Catalog> {
  const mod = (await import('./catalog.json')) as { default: unknown }
  return mod.default as Catalog
}

/**
 * Every provider llm-models lists, the ones a browser cannot call directly included, in their own chunk. Loaded only
 * when the user turns on `allProviders` (or a provider of the vault was made from one of them).
 */
export async function loadAllCatalog(): Promise<Catalog> {
  const mod = (await import('./catalog-all.json')) as { default: unknown }
  return mod.default as Catalog
}

/**
 * The bundled catalog with the providers of `catalog-all.json` added: an id the bundled catalog lists keeps its
 * bundled entry (the one a browser calls directly), and an entry `all` lists twice is kept once.
 */
export function mergeCatalogs(bundled: Catalog, all: Catalog): Catalog {
  const seen = new Set(bundled.providers.map((p) => p.id))
  const providers = [...bundled.providers]
  for (const p of all.providers) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    providers.push(p.reach === 'proxy' ? p : { ...p, reach: 'proxy' })
  }
  const foreign: ForeignProvider[] = []
  for (const p of [...(bundled.foreign ?? []), ...(all.foreign ?? [])]) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    foreign.push(p)
  }
  return { version: bundled.version, builtAt: bundled.builtAt, providers, foreign }
}

/** Whether a browser calls the provider directly, only through a proxy, or not at all. */
export function reachOf(p: CatalogProvider | ForeignProvider): Reach {
  if (!('kind' in p)) return 'none'
  return p.reach ?? 'direct'
}

const rank = (id: string) => {
  const i = RECOMMENDED_PROVIDERS.indexOf(id)
  return i < 0 ? RECOMMENDED_PROVIDERS.length : i
}

/** Providers in the order the picker shows them: recommended first, then by name. */
export function sortedProviders(catalog: Catalog): CatalogProvider[] {
  return [...catalog.providers].sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
}

/** One row of the provider list: a catalog provider or a foreign one, with how a browser reaches it. */
export interface ListedProvider {
  readonly id: string
  readonly name: string
  readonly reach: Reach
}

/**
 * Every provider of the catalog, the foreign ones included, as the list shows them: recommended first, then the
 * ones a browser calls directly, then the ones behind a proxy, then the ones no adapter speaks to, each by name.
 */
export function listedProviders(catalog: Catalog): ListedProvider[] {
  const order: Record<Reach, number> = { direct: 0, proxy: 1, none: 2 }
  const rows = [...catalog.providers, ...(catalog.foreign ?? [])].map((p) => ({
    id: p.id,
    name: p.name,
    reach: reachOf(p),
  }))
  return rows.sort((a, b) => rank(a.id) - rank(b.id) || order[a.reach] - order[b.reach] || a.name.localeCompare(b.name))
}

export function findForeign(catalog: Catalog, id: string): ForeignProvider | undefined {
  return catalog.foreign?.find((p) => p.id === id)
}

/** Models in the order the picker shows them: newest first, then by name. */
export function sortedModels(provider: { readonly models: readonly CatalogModel[] }): CatalogModel[] {
  return [...provider.models].sort(
    (a, b) => (b.released ?? '').localeCompare(a.released ?? '') || a.name.localeCompare(b.name),
  )
}

export function findProvider(catalog: Catalog, id: string): CatalogProvider | undefined {
  return catalog.providers.find((p) => p.id === id)
}

/**
 * The catalog provider a configured provider was created from: its preset (an OpenAI-compatible service, or any
 * provider reached through a proxy), else its kind for a maker's own API.
 */
export function catalogEntryOf(
  catalog: Catalog,
  provider: Pick<ProviderConfig, 'kind' | 'preset'>,
): CatalogProvider | undefined {
  // A local server's preset (`ollama`, `lmstudio`) names the app's own preset, never a catalog entry.
  const local = LOCAL_PRESETS.some((p) => p.id === provider.preset)
  const preset = provider.preset === undefined || local ? undefined : findProvider(catalog, provider.preset)
  if (preset !== undefined && preset.kind === provider.kind) return preset
  return provider.kind === 'openai-compatible' ? undefined : findProvider(catalog, provider.kind)
}

/** The catalog entry of a configured provider's model, through the catalog provider it was created from. */
export function findModel(
  catalog: Catalog,
  provider: Pick<ProviderConfig, 'kind' | 'preset'>,
  modelId: string,
): CatalogModel | undefined {
  return catalogEntryOf(catalog, provider)?.models.find((m) => m.id === modelId)
}

/** The configuration fields of a provider created from a catalog entry (no secret: the key is stored apart). */
export function providerFields(p: CatalogProvider): Pick<ProviderConfig, 'kind' | 'label'> & {
  readonly baseUrl?: string
  readonly preset?: string
} {
  return {
    kind: p.kind,
    label: p.name,
    ...(p.api === undefined ? {} : { baseUrl: p.api }),
    // A provider behind a proxy keeps its catalog id whatever its kind: its address is the user's, not the catalog's.
    ...(p.kind === 'openai-compatible' || p.reach === 'proxy' ? { preset: p.id } : {}),
  }
}

/**
 * Whether a configured provider made from a catalog entry still calls an address a browser cannot reach: the entry
 * is behind a proxy and the base URL is still the provider's own (or none), not one the user gave.
 */
export function needsProxy(entry: CatalogProvider | undefined, provider: Pick<ProviderConfig, 'baseUrl'>): boolean {
  if (entry === undefined || entry.reach !== 'proxy') return false
  return provider.baseUrl === undefined || provider.baseUrl === entry.api
}
