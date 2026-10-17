/*
 * The model catalog: the cloud providers a web page can call directly, each with its models and what they accept.
 * Built at deploy time by web/scripts/build-catalog.ts from llm-models (models.dev and OpenRouter), keeping only the
 * providers that answered a real CORS preflight from the app's origin, and shipped as `catalog.json` in its own lazily
 * loaded chunk. The catalog never decides what a request may contain on its own: `resolveCapabilities` combines it
 * with the pinned tables and the user's overrides.
 */
import type { CatalogModelInfo, ModelCost, ProviderConfig, ProviderKind } from '../contracts/ai.ts'

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
  readonly models: readonly CatalogModel[]
}

export interface Catalog {
  readonly version: typeof CATALOG_VERSION
  /** ISO 8601. */
  readonly builtAt: string
  readonly providers: readonly CatalogProvider[]
}

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

/** Providers in the order the picker shows them: recommended first, then by name. */
export function sortedProviders(catalog: Catalog): CatalogProvider[] {
  const rank = (id: string) => {
    const i = RECOMMENDED_PROVIDERS.indexOf(id)
    return i < 0 ? RECOMMENDED_PROVIDERS.length : i
  }
  return [...catalog.providers].sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
}

/** Models in the order the picker shows them: newest first, then by name. */
export function sortedModels(provider: CatalogProvider): CatalogModel[] {
  return [...provider.models].sort(
    (a, b) => (b.released ?? '').localeCompare(a.released ?? '') || a.name.localeCompare(b.name),
  )
}

export function findProvider(catalog: Catalog, id: string): CatalogProvider | undefined {
  return catalog.providers.find((p) => p.id === id)
}

/**
 * The catalog entry of a configured provider's model: through the catalog provider it was created from (its preset,
 * or its kind for a maker's own API).
 */
export function findModel(
  catalog: Catalog,
  provider: Pick<ProviderConfig, 'kind' | 'preset'>,
  modelId: string,
): CatalogModel | undefined {
  const entry = findProvider(catalog, provider.kind === 'openai-compatible' ? (provider.preset ?? '') : provider.kind)
  return entry?.models.find((m) => m.id === modelId)
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
    ...(p.kind === 'openai-compatible' ? { preset: p.id } : {}),
  }
}
