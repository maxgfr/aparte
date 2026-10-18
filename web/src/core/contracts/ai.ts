/*
 * Contracts of the model layer (F5): providers, models and their capabilities, provider keys, the effort scale and
 * its per-provider mapping, and the streaming chat contract every adapter implements. Implemented by
 * web/src/core/ai/*.ts:
 *
 *   capabilities.ts  resolveCapabilities, KNOWN_ANTHROPIC_MODELS     (CapabilitiesModule)
 *   effort.ts        EFFORTS, effortLevels, effortWire, usableEffort  (EffortModule)
 *   keys.ts          createProviderKeys                               (ProviderKeysModule)
 *   fetch.ts         providerFetch                                    (ProviderFetchModule)
 *   adapters.ts      createAdapter, testConnection                    (AdaptersModule)
 *
 * Invariants:
 * - Every request a provider adapter makes goes through `providerFetch`, which is web/src/security/net.ts `request()`
 *   with purpose `provider`. An AI SDK provider is always created with that `fetch`: none may fall back to the global
 *   one. No custom header is sent except the ones the provider's own API defines (`x-api-key`, `anthropic-version`,
 *   `anthropic-beta` and `anthropic-dangerous-direct-browser-access` on Anthropic's own host; `Authorization` with the
 *   key elsewhere), `content-type` and `accept`, because an unlisted header fails the CORS preflight. The AI SDK's
 *   own `user-agent` header is removed.
 * - A request never carries a parameter the model's capabilities do not allow: no sampling parameter outside
 *   `capabilities.sampling`, no effort outside `capabilities.effort.levels`, no forced tool choice unless
 *   `capabilities.forcedToolChoice`, and never an assistant message last (prefill) unless `capabilities.prefill`.
 *   The adapter refuses such a request with InvalidInputError before any network call; it never silently drops or
 *   rewrites a parameter.
 * - Reasoning is requested in the readable form the provider offers: Anthropic adaptive thinking with
 *   `display: 'summarized'`, OpenAI reasoning summaries, Gemini thought summaries.
 * - Provider metadata needed for replay (an Anthropic thinking signature or redacted data, an OpenAI encrypted
 *   reasoning item, a Gemini thought signature) is surfaced as an opaque `ProviderMeta` and replayed byte for byte;
 *   an adapter sends only the `ProviderMeta` entry of its own kind and ignores the others.
 * - OpenAI is called through the Responses API with `store: false`, so the provider keeps no conversation state; its
 *   reasoning items come back with `include: ['reasoning.encrypted_content']` and are replayed from
 *   `providerMeta.openai`.
 * - API keys never enter a Yjs document: a `ProviderConfig` holds no secret; the key is a `provider-key` local record
 *   (spec/DATA-MODEL.md section 6).
 * - Text from a provider (deltas, error messages, refusal explanations) is untrusted: it is rendered as text or
 *   through the sanitised renderer, never as markup.
 */

import type { Bytes } from './crypto.ts'
import type { LocalStore } from './store.ts'
import type { ModelRef, Part, ProviderMeta, Role } from './workspace.ts'

// Providers

/**
 * The adapter a provider uses. `openai-compatible` covers every server that speaks OpenAI's chat completions:
 * Groq, xAI, DeepSeek, Together, Fireworks, Cerebras, Perplexity, Ollama, LM Studio, Jan, vLLM and custom endpoints
 * (told apart by `ProviderConfig.preset`). `webllm` and `chrome-ai` are on-device (milestone M4).
 */
export type ProviderKind =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'mistral'
  | 'openrouter'
  | 'openai-compatible'
  | 'webllm'
  | 'chrome-ai'

/**
 * A provider as the index document stores it (spec/DATA-MODEL.md section 3.3): synced, and free of any secret.
 * Fields are Yjs `Any` values: an absent field is not set, never `undefined`.
 */
export interface ProviderConfig {
  /** 26-character base32 id. */
  readonly id: string
  readonly kind: ProviderKind
  /** What the user calls it. */
  readonly label: string
  /**
   * Base URL of the API, without a trailing slash. Absent means the provider's default (Anthropic, OpenAI, Gemini,
   * Mistral, OpenRouter); required for `openai-compatible`. Must pass `endpointProblem` (https, or http on the
   * loopback only).
   */
  readonly baseUrl?: string
  /** For `openai-compatible`: the preset it was created from (`groq`, `ollama`, `lmstudio`...), or `custom`. */
  readonly preset?: string
  /** Model ids the user picked or the server listed, in the order shown. */
  readonly models?: readonly string[]
  readonly defaultModel?: string
  /** Whether the user opted in to syncing the key (then it is a secret version, otherwise a device-only record). */
  readonly syncKey: boolean
  /** Secret id of the synced key, when `syncKey`. */
  readonly secret?: string
  /** Per-model corrections the user made to the resolved capabilities, by model id. */
  readonly overrides?: Readonly<Record<string, CapabilityOverride>>
  readonly createdAt: number
  readonly updatedAt: number
  readonly deletedAt?: number
}

/**
 * The key of one provider. Stored as a `provider-key` local record whose id is the provider id and whose value is
 * the UTF-8 of this object as JSON, sealed by the M1 LocalStore; never logged, never in a Yjs document.
 */
export interface ProviderSecret {
  readonly kind: 'api-key'
  readonly provider: string
  readonly key: string
}

/** Device-only provider keys over the vault's LocalStore. */
export interface ProviderKeys {
  /** The key, or null when none is stored; TamperedError when the record does not authenticate. */
  get(providerId: string): Promise<string | null>
  /** InvalidInputError for an empty key or one with surrounding whitespace or control characters. */
  set(providerId: string, key: string): Promise<void>
  delete(providerId: string): Promise<void>
  /** Provider ids that have a key on this device, sorted. */
  list(): Promise<string[]>
}

export interface ProviderKeysModule {
  createProviderKeys(store: LocalStore): ProviderKeys
}

// Effort

/**
 * How much a reasoning model thinks before it answers, on the AI SDK's scale (its `reasoning` call option), weakest
 * first. Each provider accepts a subset per model; `effortWire` says how a level is sent.
 */
export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** Where a level goes in the provider's request, and as what. */
export type EffortWire =
  /** Anthropic Messages: `output_config.effort`, with `thinking: {type: 'adaptive', display: 'summarized'}`. */
  | { readonly param: 'output_config.effort'; readonly value: 'low' | 'medium' | 'high' | 'xhigh' | 'max' }
  /** Anthropic models before Claude 4.6 that take effort as a thinking budget (`thinking.budget_tokens`). */
  | { readonly param: 'thinking.budget_tokens'; readonly value: number }
  /** OpenAI Responses and OpenRouter: `reasoning.effort`. */
  | { readonly param: 'reasoning.effort'; readonly value: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }
  /** OpenAI-compatible chat completions that document it: `reasoning_effort`. */
  | { readonly param: 'reasoning_effort'; readonly value: 'low' | 'medium' | 'high' }
  /** Gemini 3: `generationConfig.thinkingConfig.thinkingLevel`. */
  | { readonly param: 'thinkingConfig.thinkingLevel'; readonly value: 'minimal' | 'low' | 'medium' | 'high' }
  /** Gemini 2.5: `generationConfig.thinkingConfig.thinkingBudget`. */
  | { readonly param: 'thinkingConfig.thinkingBudget'; readonly value: number }

export interface EffortSpec {
  /** Levels the model accepts through this provider, weakest first; empty when it takes none (control hidden). */
  readonly levels: readonly Effort[]
  /**
   * The level the provider applies when none is sent, or null when unknown. The chat sends a level explicitly on
   * every turn whenever `levels` is non-empty (the conversation's, else the synced default, else this one), so a
   * provider changing its default never changes a conversation.
   */
  readonly default: Effort | null
}

export interface EffortModule {
  /** Every level, weakest first. */
  readonly EFFORTS: readonly Effort[]
  /**
   * The levels a model takes through a provider kind, from the makers' documentation; empty for a model not known to
   * take any (guessing risks a request the API refuses), and empty for `openai-compatible` unless the preset
   * documents `reasoning_effort` for that model.
   */
  effortLevels(kind: ProviderKind, modelId: string): readonly Effort[]
  /** How `effort` is sent to that model, or null when it takes none or not that level. */
  effortWire(kind: ProviderKind, modelId: string, effort: Effort): EffortWire | null
  /** `effort` when the levels include it, else null (nothing is sent and the model's default applies). */
  usableEffort(effort: Effort | null | undefined, levels: readonly Effort[]): Effort | null
}

// Models and capabilities

/** Sampling parameters a request may set. */
export type SamplingParam = 'temperature' | 'topP' | 'topK' | 'presencePenalty' | 'frequencyPenalty' | 'seed'

/**
 * The provider's native web search, when the model has one: Anthropic's dynamic-filtering tool (Opus 4.6 and later,
 * Sonnet 4.6 and later), Anthropic's basic tool (older models), OpenAI's `web_search` tool, Gemini's Google Search
 * grounding, OpenRouter's `web` plugin.
 */
export type WebSearchVariant =
  | 'anthropic:web_search_20260209'
  | 'anthropic:web_search_20250305'
  | 'openai:web_search'
  | 'google:google_search'
  | 'openrouter:web'

/** Prices in US dollars per million tokens. */
export interface ModelCost {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  /** 5-minute cache writes. */
  readonly cacheWrite?: number
}

/** What a model accepts, which decides what the UI offers and what a request may contain. */
export interface Capabilities {
  /** Image input. */
  readonly vision: boolean
  /** Native PDF input (otherwise documents are sent as extracted text). */
  readonly pdf: boolean
  /** Function tools. */
  readonly tools: boolean
  /** It reasons before answering (reasoning parts may arrive). */
  readonly reasoning: boolean
  readonly effort: EffortSpec
  /**
   * How its reasoning is shown: `summarized` (a readable summary is requested, as Anthropic `display: 'summarized'`
   * and OpenAI reasoning summaries), `raw` (the provider streams its reasoning text, as `reasoning_content`), `hidden`
   * (reasoning happens but no text comes back), or null without reasoning.
   */
  readonly thinkingDisplay: 'summarized' | 'raw' | 'hidden' | null
  /** Sampling parameters it accepts with a non-default value; empty on Claude Opus 4.7 and later. */
  readonly sampling: readonly SamplingParam[]
  /** A request may end with an assistant message that the model continues. False on every Claude 4.6+ model. */
  readonly prefill: boolean
  /** `tool_choice` may force a tool (`any` or a named tool). False on Claude Fable 5.1, Opus 5.5 and Sonnet 5.5. */
  readonly forcedToolChoice: boolean
  readonly webSearch: WebSearchVariant | null
  /**
   * A `role: 'system'` message may appear after the first message, with system authority (Anthropic: Claude Opus 4.8,
   * Opus 5, Opus 5.5, Fable 5, Fable 5.1, Sonnet 5.5, Haiku 5.5). Otherwise such a message is sent as a delimited
   * text block of the user turn that follows it (spec/DATA-MODEL.md section 5).
   */
  readonly midConversationSystem: boolean
  /** Mid-conversation tool additions and removals (Anthropic `tool_addition` / `tool_removal`). */
  readonly toolChanges: boolean
  /**
   * Server-side refusal fallback the adapter opts into by default (`fallbacks: 'default'` with the
   * `server-side-fallback-2026-07-01` beta on Anthropic's own API for Fable 5.1, Opus 5, Opus 5.5 and Sonnet 5.5), or
   * null. A fallback that served the turn arrives as a `provider-block` event.
   */
  readonly refusalFallback: 'default' | null
  /** Input window in tokens. */
  readonly contextWindow: number
  /** Output cap in tokens. */
  readonly maxOutput: number
  readonly cost: ModelCost | null
}

/** A user correction of resolved capabilities; applied last. */
export type CapabilityOverride = Partial<Capabilities>

/** What the bundled or refreshed catalog says about a model (from llm-models), before resolution. */
export interface CatalogModelInfo {
  readonly id: string
  readonly name: string
  readonly contextWindow?: number
  readonly maxOutput?: number
  /** Input modalities: `text`, `image`, `pdf`, `audio`... */
  readonly input?: readonly string[]
  readonly reasoning?: boolean
  readonly toolCall?: boolean
  readonly cost?: ModelCost
}

/** A model as the chat uses it: one provider, one id, resolved capabilities. */
export interface ModelDescriptor {
  readonly ref: ModelRef
  readonly kind: ProviderKind
  /** Display name. */
  readonly name: string
  readonly capabilities: Capabilities
}

export interface CapabilitiesModule {
  /**
   * The Anthropic models whose capabilities are pinned from Anthropic's documentation, by exact model id (no date
   * suffix): their table wins over the catalog, since the catalog cannot say what a request may contain.
   */
  readonly KNOWN_ANTHROPIC_MODELS: ReadonlySet<string>
  /**
   * Resolves a model's capabilities: the pinned table for a known Anthropic model, else the catalog entry with
   * conservative defaults for what it does not say (no sampling restriction is assumed lifted, no prefill on
   * Anthropic, no forced tool choice unless documented, no mid-conversation system), then `override`.
   */
  resolveCapabilities(input: {
    readonly kind: ProviderKind
    readonly modelId: string
    readonly catalog?: CatalogModelInfo
    readonly override?: CapabilityOverride
  }): Capabilities
}

// Streaming chat

/**
 * A part as it is sent: a stored part whose blob references are resolved to bytes (spec/DATA-MODEL.md section 4.3:
 * `ref` parts are substituted before this point, images and files carry the stored bytes).
 */
export type PromptPart =
  | Exclude<Part, { readonly type: 'image' } | { readonly type: 'file' } | { readonly type: 'ref' }>
  | (Extract<Part, { readonly type: 'image' }> & { readonly data: Bytes })
  | (Extract<Part, { readonly type: 'file' }> & { readonly data: Bytes })

export interface PromptMessage {
  readonly role: Role
  readonly parts: readonly PromptPart[]
}

/**
 * A function tool as declared to the provider: a registered tool of the conversation's snapshot (contracts/tools.ts).
 * `strict` asks the provider to keep the arguments valid against the schema (Anthropic and OpenAI).
 */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  /** JSON Schema of the input. */
  readonly inputSchema: unknown
  readonly strict?: boolean
}

export type ToolChoice = 'auto' | 'none' | { readonly tool: string } | 'required'

/** One provider call. Built by the chat controller from a conversation path (web/src/core/chat/request.ts). */
export interface ChatRequest {
  readonly provider: ProviderConfig
  readonly model: ModelDescriptor
  /** Null for keyless providers (local servers). */
  readonly apiKey: string | null
  /** The conversation's frozen top-level system prompt; empty means none is sent. */
  readonly system: string
  /** Oldest first; never ends with an assistant message unless `model.capabilities.prefill`. */
  readonly messages: readonly PromptMessage[]
  /** The conversation's tool snapshot, in its order, with the same definitions every turn. */
  readonly tools: readonly ToolDefinition[]
  /**
   * Declares the provider's own web search (`model.capabilities.webSearch` picks the variant: Anthropic's dynamic or
   * basic `web_search` tool, OpenAI's `web_search`, Gemini's Google Search grounding, OpenRouter's `web` plugin). It is
   * declared after the function tools, under the name `web_search`. InvalidInputError when the model has none.
   */
  readonly webSearch?: boolean
  readonly toolChoice?: ToolChoice
  /** Sent explicitly whenever the model takes effort; null otherwise. */
  readonly effort: Effort | null
  /** Defaults to `model.capabilities.maxOutput` (streaming makes large values safe). */
  readonly maxOutputTokens?: number
  /** Only keys in `model.capabilities.sampling`. */
  readonly sampling?: { readonly [K in SamplingParam]?: number }
  /** Opt out of `capabilities.refusalFallback` for this call. */
  readonly noFallback?: boolean
  readonly signal: AbortSignal
}

/**
 * Why a response ended. `refusal` is Anthropic's `stop_reason: 'refusal'` (a safety classifier or the model
 * declined; the partial output is discarded, spec/DATA-MODEL.md section 4); `content-filter` is another provider's
 * filter (OpenAI `content_filter`, Gemini `SAFETY` and similar); `pause` is Anthropic's `pause_turn`.
 */
export type StopReason =
  | 'end'
  | 'length'
  | 'tool-calls'
  | 'stop-sequence'
  | 'refusal'
  | 'content-filter'
  | 'pause'
  | 'other'

/**
 * Token counts as the provider reported them, on the AI SDK's totals; absent means not reported. `input` counts every
 * input token, cached or not, and `output` every output token, reasoning included; `cacheRead`, `cacheWrite` and
 * `reasoning` are parts of those totals.
 */
export interface Usage {
  readonly input?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
  readonly reasoning?: number
}

export type ChatErrorCode =
  /** The key was refused (401, 403). */
  | 'auth'
  /**
   * The request failed without a readable answer: offline, DNS, a CORS refusal, or an error the provider sent without
   * CORS headers (OpenAI and Cerebras answer a bad key this way). Shown as "key refused or network".
   */
  | 'auth-or-network'
  | 'rate-limit'
  /** Anthropic `overloaded_error`, HTTP 529 or 503. */
  | 'overloaded'
  | 'context-length'
  | 'invalid-request'
  | 'not-found'
  | 'server'
  /** The stream ended without a finish event. */
  | 'truncated'
  | 'unknown'

export interface ChatError {
  readonly code: ChatErrorCode
  /** The provider's message, untrusted and possibly empty; shown as text. Never contains the API key. */
  readonly message: string
  readonly status?: number
  /** Whether retrying the same request may succeed (rate limit, overload, server, network). */
  readonly retryable: boolean
}

/**
 * The stream an adapter yields, in arrival order. Ids tie the deltas of one block together; blocks of different ids
 * may interleave. Exactly one `finish` or one `error` ends a stream that was not aborted; after an abort the stream
 * ends with neither.
 */
export type ChatEvent =
  | { readonly type: 'text-delta'; readonly id: string; readonly text: string }
  /** Reasoning text (a summary, raw reasoning, or nothing when hidden). */
  | { readonly type: 'reasoning-delta'; readonly id: string; readonly text: string }
  /**
   * A reasoning block is complete. `providerMeta` holds what replay needs, keyed by provider kind: for Anthropic
   * `{type: 'thinking', signature}` or, for a block with no text, `{type: 'redacted_thinking', data}`. A block without
   * `providerMeta` is display-only and never replayed.
   */
  | { readonly type: 'reasoning-end'; readonly id: string; readonly providerMeta?: ProviderMeta }
  /** A call of a declared function tool, for the client to run. A provider-executed call (web search) is not one. */
  | {
      readonly type: 'tool-call'
      readonly callId: string
      readonly name: string
      readonly input: unknown
      readonly providerMeta?: ProviderMeta
    }
  /** A source the answer cites (provider web search, citations). */
  | { readonly type: 'source'; readonly part: Extract<Part, { readonly type: 'source' }> }
  /**
   * A provider block with no portable meaning (an Anthropic `fallback` switch point, its `server_tool_use` and
   * `web_search_tool_result` blocks in Anthropic's own wire shape, compaction), kept as a `provider` part and replayed
   * verbatim to that provider only.
   */
  | { readonly type: 'provider-block'; readonly provider: ProviderKind; readonly block: unknown }
  /** Latest totals; may arrive several times, the last one wins. */
  | { readonly type: 'usage'; readonly usage: Usage }
  | {
      readonly type: 'finish'
      readonly stop: StopReason
      /** The provider's own value (`end_turn`, `stop`, `STOP`, `refusal`...). */
      readonly raw?: string
      /** With `stop: 'refusal'`: Anthropic's `stop_details`; category null is a valid value. */
      readonly refusal?: { readonly category: string | null; readonly explanation?: string }
      /** The model that produced the answer, when the provider names it (a fallback model may have served it). */
      readonly servedBy?: string
    }
  | { readonly type: 'error'; readonly error: ChatError }

/** One provider kind's implementation of the streaming contract. */
export interface ChatAdapter {
  readonly kind: ProviderKind
  /**
   * Streams one response. InvalidInputError (thrown before any network call) for a request the capabilities forbid.
   * Provider and network failures are not thrown: they arrive as an `error` event. Aborting `signal` ends the
   * iteration without an error event.
   */
  stream(request: ChatRequest): AsyncIterable<ChatEvent>
}

/** The `fetch` adapters call. Production passes `providerFetch`; tests pass a fake that serves spec/sse fixtures. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface AdapterDeps {
  /** Defaults to `providerFetch`. */
  readonly fetch?: FetchLike
}

export interface ProviderFetchModule {
  /** `fetch` built on web/src/security/net.ts `request()` with purpose `provider`. */
  readonly providerFetch: FetchLike
}

/** Result of a connection test (llm-connect `testConnection` in `models` mode: free, no generation). */
export type ConnectionCheck =
  | { readonly ok: true; readonly models?: readonly string[] }
  | {
      readonly ok: false
      readonly reason: 'auth' | 'auth-or-network' | 'http' | 'timeout' | 'config' | 'insecure'
      readonly status?: number
    }

export interface AdaptersModule {
  /** InvalidInputError for a kind this build cannot call (`webllm` and `chrome-ai` until M4). */
  createAdapter(kind: ProviderKind, deps?: AdapterDeps): ChatAdapter
  /** Lists the provider's models; never generates. */
  testConnection(
    provider: ProviderConfig,
    apiKey: string | null,
    options?: { readonly fetch?: FetchLike; readonly signal?: AbortSignal },
  ): Promise<ConnectionCheck>
}
