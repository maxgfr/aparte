/*
 * Capability resolution (CapabilitiesModule in web/src/core/contracts/ai.ts). Current Claude models are pinned from
 * Anthropic's documentation, because what a request may contain (sampling, prefill, forced tool choice, effort,
 * mid-conversation system messages) is not something a catalog can say. Every other model follows its catalog entry,
 * with conservative defaults for what the entry leaves out: nothing optional is assumed.
 */
import type {
  Capabilities,
  CapabilityOverride,
  CatalogModelInfo,
  Effort,
  ModelCost,
  ProviderKind,
  SamplingParam,
  WebSearchVariant,
} from '../contracts/ai.ts'
import { effortLevels, modelKey } from './effort.ts'
import { isOnDevice, localCapabilities } from './local/catalog.ts'

const CLAUDE_SAMPLING: readonly SamplingParam[] = ['temperature', 'topP', 'topK']
const DYNAMIC_SEARCH: WebSearchVariant = 'anthropic:web_search_20260209'
const BASIC_SEARCH: WebSearchVariant = 'anthropic:web_search_20250305'

/** Prices per million tokens; a 5-minute cache write costs 1.25 times the input price. */
const cost = (input: number, output: number, cacheRead: number): ModelCost => ({
  input,
  output,
  cacheRead,
  cacheWrite: input * 1.25,
})

interface ClaudeRow {
  readonly effortDefault: Effort | null
  readonly sampling: readonly SamplingParam[]
  readonly prefill: boolean
  readonly forcedToolChoice: boolean
  readonly webSearch: WebSearchVariant
  readonly midConversationSystem: boolean
  readonly toolChanges: boolean
  readonly refusalFallback: 'default' | null
  readonly contextWindow: number
  readonly maxOutput: number
  readonly cost: ModelCost
}

/** The 2026 generation: no sampling, no prefill, 1M context, 128K output, mid-conversation system messages. */
const GEN5 = {
  sampling: [],
  prefill: false,
  midConversationSystem: true,
  contextWindow: 1_000_000,
  maxOutput: 128_000,
} as const

/**
 * Pinned Claude models by exact id (no date suffix). Sources: Anthropic's model overview, the thinking and effort
 * table, the refusal-fallback guide and the per-model migration notes.
 */
const CLAUDE: Readonly<Record<string, ClaudeRow>> = {
  'claude-fable-5-1': {
    ...GEN5,
    effortDefault: 'high',
    forcedToolChoice: false,
    webSearch: BASIC_SEARCH,
    toolChanges: true,
    refusalFallback: 'default',
    cost: cost(10, 50, 0.25),
  },
  'claude-mythos-5-1': {
    ...GEN5,
    effortDefault: 'high',
    forcedToolChoice: false,
    webSearch: BASIC_SEARCH,
    toolChanges: true,
    refusalFallback: null,
    cost: cost(10, 50, 0.25),
  },
  'claude-fable-5': {
    ...GEN5,
    effortDefault: 'high',
    forcedToolChoice: true,
    webSearch: BASIC_SEARCH,
    toolChanges: false,
    refusalFallback: null,
    cost: cost(10, 50, 1),
  },
  'claude-opus-5-5': {
    ...GEN5,
    effortDefault: 'medium',
    forcedToolChoice: false,
    webSearch: DYNAMIC_SEARCH,
    toolChanges: true,
    refusalFallback: 'default',
    cost: cost(4, 20, 0.2),
  },
  'claude-opus-5': {
    ...GEN5,
    effortDefault: 'high',
    forcedToolChoice: true,
    webSearch: DYNAMIC_SEARCH,
    toolChanges: true,
    refusalFallback: 'default',
    cost: cost(5, 25, 0.5),
  },
  'claude-sonnet-5-5': {
    ...GEN5,
    effortDefault: 'high',
    forcedToolChoice: false,
    webSearch: DYNAMIC_SEARCH,
    toolChanges: true,
    refusalFallback: 'default',
    cost: cost(2, 10, 0.2),
  },
  'claude-sonnet-5': {
    ...GEN5,
    effortDefault: 'high',
    forcedToolChoice: true,
    webSearch: DYNAMIC_SEARCH,
    midConversationSystem: false,
    toolChanges: false,
    refusalFallback: null,
    cost: cost(2, 10, 0.2),
  },
  'claude-haiku-5-5': {
    ...GEN5,
    effortDefault: 'medium',
    forcedToolChoice: true,
    webSearch: BASIC_SEARCH,
    toolChanges: true,
    refusalFallback: null,
    cost: cost(0.1, 0.5, 0.01),
  },
  'claude-opus-4-8': {
    ...GEN5,
    effortDefault: 'high',
    forcedToolChoice: true,
    webSearch: DYNAMIC_SEARCH,
    toolChanges: false,
    refusalFallback: null,
    cost: cost(5, 25, 0.5),
  },
  'claude-opus-4-7': {
    ...GEN5,
    effortDefault: 'high',
    forcedToolChoice: true,
    webSearch: DYNAMIC_SEARCH,
    midConversationSystem: false,
    toolChanges: false,
    refusalFallback: null,
    cost: cost(5, 25, 0.5),
  },
  'claude-opus-4-6': {
    ...GEN5,
    effortDefault: 'high',
    sampling: CLAUDE_SAMPLING,
    forcedToolChoice: true,
    webSearch: DYNAMIC_SEARCH,
    midConversationSystem: false,
    toolChanges: false,
    refusalFallback: null,
    cost: cost(5, 25, 0.5),
  },
  'claude-sonnet-4-6': {
    ...GEN5,
    effortDefault: 'high',
    sampling: CLAUDE_SAMPLING,
    forcedToolChoice: true,
    webSearch: DYNAMIC_SEARCH,
    midConversationSystem: false,
    toolChanges: false,
    refusalFallback: null,
    cost: cost(3, 15, 0.3),
  },
  'claude-haiku-4-5': {
    effortDefault: null,
    sampling: CLAUDE_SAMPLING,
    prefill: true,
    forcedToolChoice: true,
    webSearch: BASIC_SEARCH,
    midConversationSystem: false,
    toolChanges: false,
    refusalFallback: null,
    contextWindow: 200_000,
    maxOutput: 64_000,
    cost: cost(1, 5, 0.1),
  },
}

export const KNOWN_ANTHROPIC_MODELS: ReadonlySet<string> = new Set(Object.keys(CLAUDE))

/** A model with no catalog entry and no pinned row: a small local model, as far as anyone knows. */
const UNKNOWN_CONTEXT = 32_768
const UNKNOWN_OUTPUT = 8_192

function pinnedClaude(modelId: string): Capabilities | null {
  const row = CLAUDE[modelId]
  if (!row) return null
  const levels = effortLevels('anthropic', modelId)
  return {
    vision: true,
    pdf: true,
    tools: true,
    reasoning: true,
    effort: { levels, default: row.effortDefault },
    thinkingDisplay: 'summarized',
    sampling: row.sampling,
    prefill: row.prefill,
    forcedToolChoice: row.forcedToolChoice,
    webSearch: row.webSearch,
    midConversationSystem: row.midConversationSystem,
    toolChanges: row.toolChanges,
    refusalFallback: row.refusalFallback,
    contextWindow: row.contextWindow,
    maxOutput: row.maxOutput,
    cost: row.cost,
  }
}

/** Sampling parameters each API documents for a model that is not a reasoning model. */
function catalogSampling(kind: ProviderKind, reasoning: boolean): readonly SamplingParam[] {
  switch (kind) {
    case 'anthropic':
      // An undocumented Claude model may be one that refuses every non-default value.
      return []
    case 'openai':
      // OpenAI's reasoning models refuse sampling parameters.
      return reasoning ? [] : ['temperature', 'topP', 'presencePenalty', 'frequencyPenalty']
    case 'google':
      return ['temperature', 'topP', 'topK', 'seed']
    case 'mistral':
      return ['temperature', 'topP', 'seed']
    case 'openrouter':
      return ['temperature', 'topP', 'topK', 'presencePenalty', 'frequencyPenalty', 'seed']
    case 'openai-compatible':
      return ['temperature', 'topP']
    default:
      return []
  }
}

/** The provider's native web search where it is documented for the model family; null otherwise. */
function catalogWebSearch(kind: ProviderKind, modelId: string, tools: boolean): WebSearchVariant | null {
  if (!tools) return null
  const key = modelKey(modelId)
  if (kind === 'openai' && /^(gpt-4-1|gpt-4o|gpt-5|gpt-6|o3|o4)/.test(key)) return 'openai:web_search'
  if (kind === 'google' && /^gemini-([2-9]|\d{2})/.test(key)) return 'google:google_search'
  if (kind === 'openrouter') return 'openrouter:web'
  return null
}

/** How reasoning comes back from a provider that reasons: a requested summary, or the raw text it streams. */
function catalogThinkingDisplay(kind: ProviderKind): Capabilities['thinkingDisplay'] {
  return kind === 'anthropic' || kind === 'openai' || kind === 'google' ? 'summarized' : 'raw'
}

function fromCatalog(kind: ProviderKind, modelId: string, catalog: CatalogModelInfo | undefined): Capabilities {
  const input = catalog?.input ?? []
  const documented = effortLevels(kind, modelId)
  // A catalog that says the model does not reason wins over a table match; otherwise the makers' table is evidence.
  const levels = catalog?.reasoning === false ? [] : documented
  const reasoning = catalog?.reasoning ?? levels.length > 0
  const tools = catalog?.toolCall ?? false
  const contextWindow = catalog?.contextWindow ?? UNKNOWN_CONTEXT
  const maxOutput = Math.min(catalog?.maxOutput ?? UNKNOWN_OUTPUT, contextWindow)
  const effortDefault: Effort | null = kind === 'openai' && levels.includes('medium') ? 'medium' : null
  return {
    vision: input.includes('image'),
    pdf: input.includes('pdf'),
    tools,
    reasoning,
    effort: { levels, default: effortDefault },
    thinkingDisplay: reasoning ? catalogThinkingDisplay(kind) : null,
    sampling: catalogSampling(kind, reasoning),
    prefill: false,
    forcedToolChoice: kind === 'openai' || kind === 'google' || kind === 'mistral' ? tools : false,
    webSearch: catalogWebSearch(kind, modelId, tools),
    midConversationSystem: false,
    toolChanges: false,
    refusalFallback: null,
    contextWindow,
    maxOutput,
    cost: catalog?.cost ?? null,
  }
}

export function resolveCapabilities(input: {
  readonly kind: ProviderKind
  readonly modelId: string
  readonly catalog?: CatalogModelInfo
  readonly override?: CapabilityOverride
}): Capabilities {
  const base = isOnDevice(input.kind)
    ? localCapabilities(input.kind, input.modelId)
    : ((input.kind === 'anthropic' ? pinnedClaude(input.modelId) : null) ??
      fromCatalog(input.kind, input.modelId, input.catalog))
  return input.override ? { ...base, ...input.override } : base
}
