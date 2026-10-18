/*
 * The AI SDK language model for one provider (the `createModel` of cursus, extended). Each provider package is its own
 * lazily loaded chunk. Every model is created with a `fetch` that goes through `guardedFetch`, which keeps only the
 * headers the provider's own API defines (so the CORS preflight passes and nothing identifying leaks) and applies the
 * adapter's body fixes; the underlying fetch is `providerFetch` (web/src/security/net.ts) or a test's fake.
 */
import type { LanguageModel } from 'ai'
import type { FetchLike, ProviderConfig, ProviderKind } from '../contracts/ai.ts'
import { InvalidInputError } from '../contracts/crypto.ts'

/** Base URLs of the providers that have a default; `openai-compatible` always names its own. */
export const DEFAULT_BASE_URLS: Readonly<Partial<Record<ProviderKind, string>>> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  mistral: 'https://api.mistral.ai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
}

const ANTHROPIC_HOST = 'api.anthropic.com'
export const ANTHROPIC_BROWSER_HEADER = 'anthropic-dangerous-direct-browser-access'

/** The key under which the AI SDK reports and reads each kind's provider metadata and options. */
export const SDK_KEY: Readonly<Partial<Record<ProviderKind, string>>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  mistral: 'mistral',
  openrouter: 'openrouter',
  'openai-compatible': 'openaiCompatible',
}

/**
 * Request headers each kind may send, besides `content-type` and `accept`: the ones its API defines. Anything else
 * (the AI SDK's `user-agent`, OpenRouter's app attribution headers) would fail the preflight or identify the app.
 */
const ALLOWED_HEADERS: Readonly<Partial<Record<ProviderKind, readonly string[]>>> = {
  anthropic: ['x-api-key', 'anthropic-version', 'anthropic-beta', ANTHROPIC_BROWSER_HEADER],
  openai: ['authorization'],
  google: ['x-goog-api-key'],
  mistral: ['authorization'],
  openrouter: ['authorization'],
  'openai-compatible': ['authorization'],
}

/** The base URL a provider is called at, without a trailing slash. */
export function baseUrlOf(provider: ProviderConfig): string {
  const url = provider.baseUrl ?? DEFAULT_BASE_URLS[provider.kind]
  if (url === undefined) throw new InvalidInputError(`No base URL for the ${provider.kind} provider`)
  return url.replace(/\/+$/, '')
}

/** Whether a URL is Anthropic's own API host, the only one that receives Anthropic's direct-browser opt-in. */
export function isAnthropicHost(url: string): boolean {
  try {
    return new URL(url).hostname === ANTHROPIC_HOST
  } catch {
    return false
  }
}

function urlOf(input: string | URL | Request): string {
  return input instanceof Request ? input.url : String(input)
}

/**
 * Rewrites a parsed JSON request body before it is sent; `headers` (lower-case names, already filtered) may be edited
 * in place.
 */
export type BodyTransform = (body: Record<string, unknown>, headers: Record<string, string>) => Record<string, unknown>

/**
 * A fetch for one provider kind: drops every header the kind's API does not define, sends Anthropic's direct-browser
 * header to Anthropic's own host only, and applies `transform` to a JSON body.
 */
export function guardedFetch(kind: ProviderKind, base: FetchLike, transform?: BodyTransform): FetchLike {
  const allowed = new Set(['content-type', 'accept', ...(ALLOWED_HEADERS[kind] ?? [])])
  return (input, init) => {
    const url = urlOf(input)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const kept: Record<string, string> = {}
    headers.forEach((value, name) => {
      if (!allowed.has(name)) return
      if (name === ANTHROPIC_BROWSER_HEADER && !isAnthropicHost(url)) return
      kept[name] = value
    })
    let body = init?.body
    if (transform && typeof body === 'string') {
      body = JSON.stringify(transform(JSON.parse(body) as Record<string, unknown>, kept))
    }
    return base(url, { ...init, headers: kept, ...(body === undefined ? {} : { body }) })
  }
}

/** Per-model settings some packages take at creation rather than per call. */
export interface ModelSettings {
  /** OpenRouter's `reasoning.effort`, which its package reads from the model settings. */
  readonly openrouterEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  /** OpenRouter's `web` plugin, its native web search. */
  readonly openrouterWeb?: boolean
}

/**
 * Builds the language model. `fetch` is already guarded; `apiKey` is null only for a keyless OpenAI-compatible
 * server. Provider packages are loaded on first use.
 */
export async function createModel(
  provider: ProviderConfig,
  modelId: string,
  apiKey: string | null,
  guarded: FetchLike,
  settings: ModelSettings = {},
): Promise<Exclude<LanguageModel, string>> {
  const baseURL = baseUrlOf(provider)
  const key = apiKey ?? undefined
  // The packages type `fetch` as the global one, static members included; they only ever call it.
  const fetch = guarded as typeof globalThis.fetch
  switch (provider.kind) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic')
      // The header is Anthropic's own opt-in to calls from a web page; guardedFetch keeps it off other hosts.
      const headers = isAnthropicHost(baseURL) ? { [ANTHROPIC_BROWSER_HEADER]: 'true' } : undefined
      return createAnthropic({ apiKey: key, baseURL, headers, fetch })(modelId)
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai')
      return createOpenAI({ apiKey: key, baseURL, fetch }).responses(modelId)
    }
    case 'google': {
      const { createGoogle } = await import('@ai-sdk/google')
      return createGoogle({ apiKey: key, baseURL, fetch })(modelId)
    }
    case 'mistral': {
      const { createMistral } = await import('@ai-sdk/mistral')
      return createMistral({ apiKey: key, baseURL, fetch })(modelId)
    }
    case 'openrouter': {
      const { createOpenRouter } = await import('@openrouter/ai-sdk-provider')
      const effort = settings.openrouterEffort
      const options = {
        ...(effort === undefined ? {} : { reasoning: { effort } }),
        ...(settings.openrouterWeb ? { plugins: [{ id: 'web' as const, max_results: 5 }] } : {}),
      }
      return createOpenRouter({ apiKey: key, baseURL, fetch }).chat(
        modelId,
        Object.keys(options).length === 0 ? undefined : options,
      )
    }
    case 'openai-compatible': {
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible')
      return createOpenAICompatible({
        name: SDK_KEY['openai-compatible'] as string,
        apiKey: key,
        baseURL,
        fetch,
        includeUsage: true,
      }).chatModel(modelId)
    }
    default:
      throw new InvalidInputError(`The ${provider.kind} provider cannot be called from this build`)
  }
}
