/*
 * The provider adapters (AdaptersModule in web/src/core/contracts/ai.ts): one streaming contract over the AI SDK's
 * `streamText` full stream, for Anthropic (native Messages API), OpenAI (Responses API, `store: false`), Gemini
 * (native), Mistral, OpenRouter and every OpenAI-compatible server.
 *
 * Invariants:
 * - A request the model's capabilities forbid is refused with InvalidInputError before any network call; a parameter
 *   is never dropped or rewritten to make it fit.
 * - Every call goes through `guardedFetch` over `providerFetch` (or a test's fake): only the provider's own headers
 *   leave, and Anthropic's direct-browser header only towards Anthropic's own host.
 * - Reasoning is replayed only from its own provider's `providerMeta` entry, byte for byte; every other entry is
 *   ignored. The adapter does not retry: the controller decides.
 * - A stream ends with exactly one `finish` or one `error`, or with neither after an abort.
 */
import { type JSONValue, jsonSchema, type ModelMessage, streamText, type ToolSet, tool } from 'ai'
import { type LlmSettings, testConnection as llmTestConnection } from 'llm-connect'
import type {
  AdapterDeps,
  ChatAdapter,
  ChatEvent,
  ChatRequest,
  ConnectionCheck,
  EffortWire,
  FetchLike,
  PromptMessage,
  PromptPart,
  ProviderConfig,
  ProviderKind,
  SamplingParam,
  StopReason,
  Usage,
} from '../contracts/ai.ts'
import { InvalidInputError } from '../contracts/crypto.ts'
import type { ProviderMeta } from '../contracts/workspace.ts'
import { effortLevels, effortWire } from './effort.ts'
import { baseUrlProblem } from './endpoints.ts'
import { describeError, truncatedError } from './errors.ts'
import { providerFetch } from './fetch.ts'
import {
  type BodyTransform,
  baseUrlOf,
  createModel,
  DEFAULT_BASE_URLS,
  guardedFetch,
  isAnthropicHost,
  type ModelSettings,
  SDK_KEY,
} from './providers.ts'

/** The kinds this build can call; `webllm` and `chrome-ai` arrive with milestone M4. */
const CALLABLE: ReadonlySet<ProviderKind> = new Set([
  'anthropic',
  'openai',
  'google',
  'mistral',
  'openrouter',
  'openai-compatible',
])

const SAMPLING: readonly SamplingParam[] = [
  'temperature',
  'topP',
  'topK',
  'presencePenalty',
  'frequencyPenalty',
  'seed',
]

type JsonRecord = Record<string, unknown>
const isRecord = (v: unknown): v is JsonRecord => typeof v === 'object' && v !== null && !Array.isArray(v)

// Validation

function refuse(message: string): never {
  throw new InvalidInputError(message)
}

function hasSampling(req: ChatRequest): boolean {
  return SAMPLING.some((key) => req.sampling?.[key] !== undefined)
}

/** Refuses, before any network call, every request the contract and the model's capabilities forbid. */
function validate(kind: ProviderKind, req: ChatRequest): void {
  const caps = req.model.capabilities
  if (req.provider.kind !== kind) refuse(`A ${req.provider.kind} provider was given to the ${kind} adapter`)
  if (req.apiKey === null && kind !== 'openai-compatible') refuse(`The ${kind} provider needs an API key`)
  if (kind === 'openai-compatible' && !req.provider.baseUrl) refuse('An OpenAI-compatible provider needs a base URL')
  const base = req.provider.baseUrl ?? DEFAULT_BASE_URLS[kind]
  if (base !== undefined && baseUrlProblem(base) !== null) refuse('The base URL must be https, or http on this machine')
  if (req.messages.length === 0) refuse('A request needs at least one message')
  const last = req.messages[req.messages.length - 1] as PromptMessage
  if (last.role === 'assistant' && !caps.prefill) refuse('The model does not continue an assistant message (prefill)')
  for (const key of SAMPLING) {
    const value = req.sampling?.[key]
    if (value === undefined) continue
    if (!caps.sampling.includes(key)) refuse(`The model does not take ${key}`)
    if (!Number.isFinite(value)) refuse(`${key} must be a finite number`)
  }
  if (req.effort !== null) {
    const wire = effortWire(kind, req.model.ref.id, req.effort)
    if (!caps.effort.levels.includes(req.effort) || wire === null) {
      refuse(`The model does not take the effort ${req.effort}`)
    }
    // A thinking budget is the only way such a model takes effort, and thinking refuses non-default sampling.
    if (wire.param === 'thinking.budget_tokens' && hasSampling(req)) {
      refuse('A thinking budget cannot be combined with sampling parameters')
    }
  }
  if (req.tools.length > 0 && !caps.tools) refuse('The model does not take tools')
  if (req.webSearch) {
    const variant = caps.webSearch
    if (variant === null) refuse('The model has no web search')
    if (!variant.startsWith(`${kind}:`)) refuse(`The ${variant} search is not one of the ${kind} provider`)
    // Gemini before 3 drops function tools declared next to Google Search; neither may be dropped silently.
    if (kind === 'google' && req.tools.length > 0 && /^gemini-[12]([.-]|$)/.test(req.model.ref.id)) {
      refuse('This Gemini model cannot combine web search with function tools')
    }
  }
  const names = new Set<string>()
  for (const t of req.tools) {
    if (names.has(t.name) || (req.webSearch && t.name === WEB_SEARCH_NAME))
      refuse(`The tool ${t.name} is declared twice`)
    names.add(t.name)
  }
  const choice = req.toolChoice
  if (choice === 'required' || typeof choice === 'object') {
    if (!caps.forcedToolChoice) refuse('The model does not accept a forced tool choice')
    if (typeof choice === 'object' && !req.tools.some((t) => t.name === choice.tool)) {
      refuse(`The forced tool ${choice.tool} is not declared`)
    }
  }
  if (req.maxOutputTokens !== undefined) {
    const n = req.maxOutputTokens
    if (!Number.isSafeInteger(n) || n < 1 || n > caps.maxOutput) refuse('maxOutputTokens is out of range')
  }
  req.messages.forEach((m, i) => {
    if (m.role === 'system') {
      if (i === 0) refuse('A system message cannot open the conversation; it is the frozen system prompt')
      if (!caps.midConversationSystem) refuse('The model does not take mid-conversation system messages')
    }
    for (const part of m.parts) {
      if (part.type === 'image' && !caps.vision) refuse('The model does not take images')
      if (part.type === 'file' && part.mediaType === 'application/pdf' && !caps.pdf)
        refuse('The model does not take PDFs')
      if (part.type === 'provider' && part.provider === kind && replayBlock(kind, part.block) === null) {
        // A block of this provider that cannot be sent back verbatim would silently change the prefix.
        refuse('This provider block cannot be replayed by this build')
      }
    }
  })
}

// Prompt conversion

/** The AI SDK options of a replayed reasoning or tool-call part, from its own provider's `providerMeta` entry only. */
function replayOptions(kind: ProviderKind, meta: ProviderMeta | undefined): Record<string, JsonRecord> | null {
  const entry = meta?.[kind]
  const key = SDK_KEY[kind]
  if (!isRecord(entry) || key === undefined) return null
  if (kind === 'anthropic') {
    if (entry.type === 'thinking' && typeof entry.signature === 'string') {
      return { anthropic: { signature: entry.signature } }
    }
    if (entry.type === 'redacted_thinking' && typeof entry.data === 'string') {
      return { anthropic: { redactedData: entry.data } }
    }
    return null
  }
  return { [key]: entry }
}

/** The name the provider's own web search is declared under (contracts/tools.ts `WEB_SEARCH`). */
const WEB_SEARCH_NAME = 'web_search'

/** One result of an Anthropic `web_search_tool_result` block, in Anthropic's wire shape. */
function searchResult(r: unknown): JsonRecord | null {
  if (!isRecord(r) || typeof r.url !== 'string' || typeof r.encrypted_content !== 'string') return null
  return {
    type: typeof r.type === 'string' ? r.type : 'web_search_result',
    url: r.url,
    title: typeof r.title === 'string' ? r.title : null,
    pageAge: typeof r.page_age === 'string' ? r.page_age : null,
    encryptedContent: r.encrypted_content,
  }
}

/** The AI SDK content of a `provider` part, or null when the AI SDK has no way to send that block back verbatim. */
function replayBlock(kind: ProviderKind, block: unknown): AssistantContent[number] | null {
  if (kind !== 'anthropic' || !isRecord(block)) return null
  // Anthropic's `fallback` switch point, which stays where it appeared; the SDK sends it from a custom part.
  if (block.type === 'fallback') {
    return { type: 'custom', kind: 'anthropic.fallback', providerOptions: { anthropic: block as never } }
  }
  // Server-side web search: the call and its (encrypted) results go back where they were, as the SDK's
  // provider-executed parts, which it writes as `server_tool_use` and `web_search_tool_result` again.
  if (block.type === 'server_tool_use' && block.name === WEB_SEARCH_NAME && typeof block.id === 'string') {
    return {
      type: 'tool-call',
      toolCallId: block.id,
      toolName: WEB_SEARCH_NAME,
      input: block.input,
      providerExecuted: true,
    }
  }
  if (block.type === 'web_search_tool_result' && typeof block.tool_use_id === 'string') {
    const content = block.content
    if (Array.isArray(content)) {
      const results = content.map(searchResult)
      if (results.some((r) => r === null)) return null
      return {
        type: 'tool-result',
        toolCallId: block.tool_use_id,
        toolName: WEB_SEARCH_NAME,
        output: { type: 'json', value: results as JSONValue },
      }
    }
    if (isRecord(content) && typeof content.error_code === 'string') {
      return {
        type: 'tool-result',
        toolCallId: block.tool_use_id,
        toolName: WEB_SEARCH_NAME,
        output: {
          type: 'error-json',
          value: { type: 'web_search_tool_result_error', errorCode: content.error_code },
        },
      }
    }
  }
  return null
}

/** Anthropic's wire block for a provider-executed web search call the SDK reported. */
function serverToolUse(part: { toolCallId: string; toolName: string; input: unknown }): JsonRecord {
  return { type: 'server_tool_use', id: part.toolCallId, name: part.toolName, input: part.input }
}

/** Anthropic's wire block for the results (or the error) of a provider-executed web search. */
function webSearchResult(toolCallId: string, output: unknown, isError: boolean): JsonRecord | null {
  if (!isError && Array.isArray(output)) {
    const content: JsonRecord[] = []
    for (const r of output) {
      if (!isRecord(r) || typeof r.url !== 'string' || typeof r.encryptedContent !== 'string') return null
      content.push({
        type: typeof r.type === 'string' ? r.type : 'web_search_result',
        url: r.url,
        title: typeof r.title === 'string' ? r.title : null,
        page_age: typeof r.pageAge === 'string' ? r.pageAge : null,
        encrypted_content: r.encryptedContent,
      })
    }
    return { type: 'web_search_tool_result', tool_use_id: toolCallId, content }
  }
  const code = isRecord(output) && typeof output.errorCode === 'string' ? output.errorCode : 'unavailable'
  return {
    type: 'web_search_tool_result',
    tool_use_id: toolCallId,
    content: { type: 'web_search_tool_result_error', error_code: code },
  }
}

function textOf(parts: readonly PromptPart[]): string {
  return parts
    .filter((p): p is Extract<PromptPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
}

type UserContent = Exclude<Extract<ModelMessage, { role: 'user' }>['content'], string>
type AssistantContent = Exclude<Extract<ModelMessage, { role: 'assistant' }>['content'], string>
type ToolContent = Extract<ModelMessage, { role: 'tool' }>['content']

function toolOutput(part: Extract<PromptPart, { type: 'tool-result' }>) {
  const value = part.output as JSONValue
  if (part.isError)
    return typeof value === 'string' ? { type: 'error-text' as const, value } : { type: 'error-json' as const, value }
  return typeof value === 'string' ? { type: 'text' as const, value } : { type: 'json' as const, value }
}

function userContent(parts: readonly PromptPart[]): UserContent {
  const out: UserContent = []
  for (const p of parts) {
    if (p.type === 'text') out.push({ type: 'text', text: p.text })
    else if (p.type === 'image') out.push({ type: 'image', image: p.data, mediaType: p.mediaType })
    else if (p.type === 'file') out.push({ type: 'file', data: p.data, mediaType: p.mediaType, filename: p.name })
  }
  return out
}

function assistantContent(kind: ProviderKind, parts: readonly PromptPart[]): AssistantContent {
  const out: AssistantContent = []
  for (const p of parts) {
    if (p.type === 'text') out.push({ type: 'text', text: p.text })
    else if (p.type === 'reasoning') {
      // Reasoning without an entry of this provider is display-only (or another provider's): never sent.
      const providerOptions = replayOptions(kind, p.providerMeta)
      if (providerOptions) out.push({ type: 'reasoning', text: p.text, providerOptions: providerOptions as never })
    } else if (p.type === 'tool-call') {
      const providerOptions = replayOptions(kind, p.providerMeta)
      out.push({
        type: 'tool-call',
        toolCallId: p.callId,
        toolName: p.name,
        input: p.input,
        ...(providerOptions ? { providerOptions: providerOptions as never } : {}),
      })
    } else if (p.type === 'provider' && p.provider === kind) {
      const content = replayBlock(kind, p.block)
      if (content) out.push(content)
    }
  }
  return out
}

/** A system prompt that marks "none": it opens the prompt so later system messages stay in place (see below). */
const NO_SYSTEM = '\u0000aparte:no-system\u0000'

/**
 * The AI SDK messages of a request. The frozen system prompt opens them; a later `system` message stays where it is
 * (validate() checked the model takes it). Anthropic's converter promotes the first system message to the top-level
 * `system` when nothing precedes it, which would move a mid-conversation message into the prefix; so when the frozen
 * prompt is empty, a marker takes its place and `anthropicBody` removes it from the body before it is sent.
 */
function toMessages(kind: ProviderKind, req: ChatRequest): ModelMessage[] {
  const messages: ModelMessage[] = []
  const hasMidSystem = req.messages.some((m) => m.role === 'system')
  const marker = kind === 'anthropic' && req.system === '' && hasMidSystem
  if (req.system !== '') messages.push({ role: 'system', content: req.system })
  else if (marker) messages.push({ role: 'system', content: NO_SYSTEM })
  for (const m of req.messages) {
    if (m.role === 'system') messages.push({ role: 'system', content: textOf(m.parts) })
    else if (m.role === 'user') {
      const content = userContent(m.parts)
      if (content.length > 0) messages.push({ role: 'user', content })
    } else if (m.role === 'assistant') {
      const content = assistantContent(kind, m.parts)
      if (content.length > 0) messages.push({ role: 'assistant', content })
    } else {
      const content: ToolContent = []
      for (const p of m.parts) {
        if (p.type === 'tool-result') {
          content.push({ type: 'tool-result', toolCallId: p.callId, toolName: p.name, output: toolOutput(p) })
        }
      }
      if (content.length > 0) messages.push({ role: 'tool', content })
    }
  }
  return messages
}

const FALLBACK_LIST_BETA = 'server-side-fallback-2026-06-01'

/**
 * Fixes an Anthropic request body before it is sent: removes the "no system prompt" marker, and keeps a single
 * fallback beta. The SDK adds the list form's beta whenever it replays a `fallback` block, but Anthropic refuses that
 * beta next to `fallbacks: 'default'`, whose own beta the SDK also adds.
 */
const anthropicBody: BodyTransform = (body, headers) => {
  let out = body
  const system = body.system
  if (Array.isArray(system) && system.length === 1 && isRecord(system[0]) && system[0].text === NO_SYSTEM) {
    const { system: _dropped, ...rest } = body
    out = rest
  }
  const beta = headers['anthropic-beta']
  if (out.fallbacks === 'default' && beta !== undefined) {
    const kept = beta.split(',').filter((b) => b.trim() !== FALLBACK_LIST_BETA)
    if (kept.length > 0) headers['anthropic-beta'] = kept.join(',')
    else delete headers['anthropic-beta']
  }
  return out
}

// Per-provider options

interface CallOptions {
  readonly providerOptions: Record<string, JsonRecord>
  readonly settings: ModelSettings
  /** The output cap sent, which leaves room for an Anthropic thinking budget inside the model's limit. */
  readonly maxOutputTokens: number
}

function callOptions(kind: ProviderKind, req: ChatRequest): CallOptions {
  const caps = req.model.capabilities
  const modelId = req.model.ref.id
  const wire: EffortWire | null = req.effort === null ? null : effortWire(kind, modelId, req.effort)
  let maxOutputTokens = req.maxOutputTokens ?? caps.maxOutput
  switch (kind) {
    case 'anthropic': {
      const options: JsonRecord = {}
      const levels = effortLevels(kind, modelId)
      const first = levels[0]
      const mode = first === undefined ? null : effortWire(kind, modelId, first)?.param
      if (wire?.param === 'thinking.budget_tokens') {
        options.thinking = { type: 'enabled', budgetTokens: wire.value }
        // The SDK adds the budget to max_tokens; the sum must stay within the model's limit.
        maxOutputTokens = Math.max(1, Math.min(maxOutputTokens, caps.maxOutput - wire.value))
      } else if (mode === 'output_config.effort') {
        // Reasoning is requested in its readable form, summarized adaptive thinking, unless the request sets a
        // sampling parameter (only Claude 4.6 takes one): thinking refuses non-default sampling, so the turn then
        // runs without it, with the effort still sent.
        if (!hasSampling(req)) options.thinking = { type: 'adaptive', display: 'summarized' }
        if (wire?.param === 'output_config.effort') options.effort = wire.value
      }
      if (caps.refusalFallback === 'default' && !req.noFallback && isAnthropicHost(baseUrlOf(req.provider))) {
        options.fallbacks = 'default'
      }
      return { providerOptions: { anthropic: options }, settings: {}, maxOutputTokens }
    }
    case 'openai': {
      const options: JsonRecord = { store: false }
      if (caps.reasoning) {
        options.include = ['reasoning.encrypted_content']
        options.reasoningSummary = 'auto'
      }
      if (wire?.param === 'reasoning.effort') options.reasoningEffort = wire.value
      return { providerOptions: { openai: options }, settings: {}, maxOutputTokens }
    }
    case 'google': {
      const thinkingConfig: JsonRecord = {}
      if (caps.reasoning) thinkingConfig.includeThoughts = true
      if (wire?.param === 'thinkingConfig.thinkingLevel') thinkingConfig.thinkingLevel = wire.value
      if (wire?.param === 'thinkingConfig.thinkingBudget') thinkingConfig.thinkingBudget = wire.value
      const google: JsonRecord = Object.keys(thinkingConfig).length > 0 ? { thinkingConfig } : {}
      return { providerOptions: { google }, settings: {}, maxOutputTokens }
    }
    case 'openrouter':
      return {
        providerOptions: {},
        settings: {
          ...(wire?.param === 'reasoning.effort' ? { openrouterEffort: wire.value } : {}),
          ...(req.webSearch ? { openrouterWeb: true } : {}),
        },
        maxOutputTokens,
      }
    default:
      return { providerOptions: {}, settings: {}, maxOutputTokens }
  }
}

/** At most this many searches per answer, so one turn cannot run up the provider's search bill unseen. */
const WEB_SEARCH_MAX_USES = 5

/** The provider's own web search tool for the model's variant; OpenRouter's is a plugin (see callOptions). */
async function webSearchTool(req: ChatRequest): Promise<ToolSet[string] | null> {
  switch (req.model.capabilities.webSearch) {
    case 'anthropic:web_search_20260209': {
      const { anthropic } = await import('@ai-sdk/anthropic')
      return anthropic.tools.webSearch_20260209({ maxUses: WEB_SEARCH_MAX_USES })
    }
    case 'anthropic:web_search_20250305': {
      const { anthropic } = await import('@ai-sdk/anthropic')
      return anthropic.tools.webSearch_20250305({ maxUses: WEB_SEARCH_MAX_USES })
    }
    case 'openai:web_search': {
      const { openai } = await import('@ai-sdk/openai')
      return openai.tools.webSearch({})
    }
    case 'google:google_search': {
      const { google } = await import('@ai-sdk/google')
      return google.tools.googleSearch({})
    }
    default:
      return null
  }
}

async function toolSet(req: ChatRequest): Promise<ToolSet | undefined> {
  const search = req.webSearch ? await webSearchTool(req) : null
  if (req.tools.length === 0 && search === null) return undefined
  const tools: ToolSet = {}
  // Object keys keep insertion order, so the snapshot's order is the order sent; the provider's search comes last.
  for (const t of req.tools) {
    tools[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema as never),
      ...(t.strict === undefined ? {} : { strict: t.strict }),
    })
  }
  if (search !== null) tools[WEB_SEARCH_NAME] = search
  return tools
}

function toolChoiceOf(req: ChatRequest) {
  const choice = req.toolChoice
  if (choice === undefined) return undefined
  if (typeof choice === 'object') return { type: 'tool' as const, toolName: choice.tool }
  return choice
}

// Stream mapping

function usageOf(u: {
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  inputTokenDetails?: { cacheReadTokens?: number | undefined; cacheWriteTokens?: number | undefined }
  outputTokenDetails?: { reasoningTokens?: number | undefined }
}): Usage {
  const out: { -readonly [K in keyof Usage]: number } = {}
  if (u.inputTokens !== undefined) out.input = u.inputTokens
  if (u.outputTokens !== undefined) out.output = u.outputTokens
  if (u.inputTokenDetails?.cacheReadTokens !== undefined) out.cacheRead = u.inputTokenDetails.cacheReadTokens
  if (u.inputTokenDetails?.cacheWriteTokens !== undefined) out.cacheWrite = u.inputTokenDetails.cacheWriteTokens
  if (u.outputTokenDetails?.reasoningTokens !== undefined) out.reasoning = u.outputTokenDetails.reasoningTokens
  return out
}

function stopOf(kind: ProviderKind, unified: string, raw: string | undefined): StopReason {
  if (kind === 'anthropic' && raw === 'refusal') return 'refusal'
  if (raw === 'pause_turn') return 'pause'
  switch (unified) {
    case 'stop':
      return raw === 'stop_sequence' ? 'stop-sequence' : 'end'
    case 'length':
      return 'length'
    case 'tool-calls':
      return 'tool-calls'
    case 'content-filter':
      return 'content-filter'
    default:
      return 'other'
  }
}

/** Merges the provider metadata a reasoning block carried on its start, deltas and end. */
function mergeMeta(into: JsonRecord, meta: unknown): void {
  if (!isRecord(meta)) return
  for (const [k, v] of Object.entries(meta)) {
    if (isRecord(v)) into[k] = { ...(isRecord(into[k]) ? into[k] : {}), ...v }
  }
}

/** The `providerMeta` of a finished reasoning block, in the contract's shape, or undefined when nothing replays it. */
function reasoningMeta(kind: ProviderKind, merged: JsonRecord): ProviderMeta | undefined {
  const key = SDK_KEY[kind]
  const own = key === undefined ? undefined : merged[key]
  if (!isRecord(own)) return undefined
  if (kind === 'anthropic') {
    if (typeof own.signature === 'string') return { anthropic: { type: 'thinking', signature: own.signature } }
    if (typeof own.redactedData === 'string')
      return { anthropic: { type: 'redacted_thinking', data: own.redactedData } }
    return undefined
  }
  return Object.keys(own).length > 0 ? { [kind]: own } : undefined
}

function partMeta(kind: ProviderKind, meta: unknown): ProviderMeta | undefined {
  const key = SDK_KEY[kind]
  if (!isRecord(meta) || key === undefined) return undefined
  const own = meta[key]
  return isRecord(own) && Object.keys(own).length > 0 ? { [kind]: own } : undefined
}

function refusalOf(meta: unknown): { category: string | null; explanation?: string } {
  const details = isRecord(meta) && isRecord(meta.anthropic) ? meta.anthropic.stopDetails : undefined
  if (!isRecord(details)) return { category: null }
  const category = typeof details.category === 'string' ? details.category : null
  return typeof details.explanation === 'string' ? { category, explanation: details.explanation } : { category }
}

async function* streamChat(kind: ProviderKind, base: FetchLike, req: ChatRequest): AsyncGenerator<ChatEvent> {
  validate(kind, req)
  const messages = toMessages(kind, req)
  const call = callOptions(kind, req)
  const fetch = guardedFetch(kind, base, kind === 'anthropic' ? anthropicBody : undefined)
  const model = await createModel(req.provider, req.model.ref.id, req.apiKey, fetch, call.settings)
  if (req.signal.aborted) return
  const sampling = req.sampling ?? {}
  const result = streamText({
    model,
    messages,
    allowSystemInMessages: true,
    tools: await toolSet(req),
    toolChoice: toolChoiceOf(req),
    maxOutputTokens: call.maxOutputTokens,
    temperature: sampling.temperature,
    topP: sampling.topP,
    topK: sampling.topK,
    presencePenalty: sampling.presencePenalty,
    frequencyPenalty: sampling.frequencyPenalty,
    seed: sampling.seed,
    providerOptions: call.providerOptions as never,
    abortSignal: req.signal,
    maxRetries: 0,
    // Errors are mapped from the stream below, not logged.
    onError: () => {},
  })
  const reasoning = new Map<string, JsonRecord>()
  let step: { unified: string; raw: string | undefined; meta: unknown; modelId: string | undefined } | null = null
  try {
    for await (const part of result.fullStream) {
      if (req.signal.aborted) return
      switch (part.type) {
        case 'text-delta':
          if (part.text !== '') yield { type: 'text-delta', id: part.id, text: part.text }
          break
        case 'reasoning-start':
          reasoning.set(part.id, {})
          mergeMeta(reasoning.get(part.id) as JsonRecord, part.providerMetadata)
          break
        case 'reasoning-delta': {
          const merged = reasoning.get(part.id) ?? {}
          reasoning.set(part.id, merged)
          mergeMeta(merged, part.providerMetadata)
          if (part.text !== '') yield { type: 'reasoning-delta', id: part.id, text: part.text }
          break
        }
        case 'reasoning-end': {
          const merged = reasoning.get(part.id) ?? {}
          mergeMeta(merged, part.providerMetadata)
          reasoning.delete(part.id)
          const providerMeta = reasoningMeta(kind, merged)
          yield providerMeta
            ? { type: 'reasoning-end', id: part.id, providerMeta }
            : { type: 'reasoning-end', id: part.id }
          break
        }
        case 'tool-call': {
          if (part.providerExecuted) {
            // The provider ran it (web search). Only Anthropic's needs replaying, as its own wire block; OpenAI's runs
            // with `store: false` and Gemini's grounding come back as sources only.
            if (kind === 'anthropic' && part.toolName === WEB_SEARCH_NAME) {
              yield { type: 'provider-block', provider: 'anthropic', block: serverToolUse(part) }
            }
            break
          }
          const providerMeta = partMeta(kind, part.providerMetadata)
          yield {
            type: 'tool-call',
            callId: part.toolCallId,
            name: part.toolName,
            input: part.input,
            ...(providerMeta ? { providerMeta } : {}),
          }
          break
        }
        case 'tool-result':
        case 'tool-error': {
          if (!part.providerExecuted || kind !== 'anthropic' || part.toolName !== WEB_SEARCH_NAME) break
          const output = part.type === 'tool-result' ? part.output : part.error
          const block = webSearchResult(part.toolCallId, output, part.type === 'tool-error')
          if (block !== null) yield { type: 'provider-block', provider: 'anthropic', block }
          break
        }
        case 'source':
          if (part.sourceType === 'url') {
            yield {
              type: 'source',
              part: { type: 'source', sourceType: 'url', url: part.url, ...(part.title ? { title: part.title } : {}) },
            }
          } else {
            yield { type: 'source', part: { type: 'source', sourceType: 'document', title: part.title } }
          }
          break
        case 'custom': {
          // Anthropic's `fallback` switch point: kept verbatim as a `provider` part and replayed where it appeared.
          const block = isRecord(part.providerMetadata) ? part.providerMetadata.anthropic : undefined
          if (kind === 'anthropic' && part.kind === 'anthropic.fallback' && isRecord(block)) {
            yield { type: 'provider-block', provider: 'anthropic', block }
          }
          break
        }
        case 'finish-step':
          step = {
            unified: part.finishReason,
            raw: part.rawFinishReason,
            meta: part.providerMetadata,
            modelId: part.response.modelId,
          }
          break
        case 'finish': {
          yield { type: 'usage', usage: usageOf(part.totalUsage) }
          const raw = step?.raw ?? part.rawFinishReason
          const unified = step?.unified ?? part.finishReason
          // Every package starts from `other` with no raw reason and replaces it on the provider's own finish event,
          // so a stream that closed before that event still holds it. (OpenAI's Responses API has no raw reason for
          // a completed response, but reports `stop`.)
          if (unified === 'other' && raw === undefined) {
            yield { type: 'error', error: truncatedError() }
            return
          }
          const stop = stopOf(kind, unified, raw)
          const servedBy = step?.modelId
          yield {
            type: 'finish',
            stop,
            ...(raw === undefined ? {} : { raw }),
            ...(stop === 'refusal' ? { refusal: refusalOf(step?.meta) } : {}),
            ...(servedBy ? { servedBy } : {}),
          }
          return
        }
        case 'error':
          if (req.signal.aborted) return
          yield { type: 'error', error: describeError(part.error, req.apiKey) }
          return
        case 'abort':
          return
        default:
          break
      }
    }
  } catch (error) {
    if (req.signal.aborted) return
    yield { type: 'error', error: describeError(error, req.apiKey) }
    return
  }
  if (req.signal.aborted) return
  yield { type: 'error', error: truncatedError() }
}

export function createAdapter(kind: ProviderKind, deps: AdapterDeps = {}): ChatAdapter {
  if (!CALLABLE.has(kind)) throw new InvalidInputError(`The ${kind} provider cannot be called from this build`)
  const base = deps.fetch ?? providerFetch
  return { kind, stream: (request) => streamChat(kind, base, request) }
}

// Connection test

/** The AI SDK package llm-connect names a kind by, which picks the auth headers of its model listing. */
const NPM: Readonly<Partial<Record<ProviderKind, string>>> = {
  anthropic: '@ai-sdk/anthropic',
  openai: '@ai-sdk/openai',
  google: '@ai-sdk/google',
  mistral: '@ai-sdk/mistral',
  openrouter: '@openrouter/ai-sdk-provider',
}

/** Gemini lists `{models: [{name: 'models/<id>'}]}`; llm-connect reads OpenAI's `{data: [{id}]}`. */
function geminiListing(base: FetchLike): FetchLike {
  return async (input, init) => {
    const res = await base(input, init)
    if (!res.ok) return res
    const body = (await res.json().catch(() => null)) as { models?: { name?: unknown }[] } | null
    const data = (body?.models ?? [])
      .map((m) => (typeof m?.name === 'string' ? { id: m.name.replace(/^models\//, '') } : null))
      .filter((m) => m !== null)
    return new Response(JSON.stringify({ data }), {
      status: res.status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

export async function testConnection(
  provider: ProviderConfig,
  apiKey: string | null,
  options: { readonly fetch?: FetchLike; readonly signal?: AbortSignal } = {},
): Promise<ConnectionCheck> {
  if (!CALLABLE.has(provider.kind)) return { ok: false, reason: 'config' }
  const guarded = guardedFetch(provider.kind, options.fetch ?? providerFetch)
  const fetch = provider.kind === 'google' ? geminiListing(guarded) : guarded
  const base = provider.baseUrl ?? DEFAULT_BASE_URLS[provider.kind]
  if (base === undefined) return { ok: false, reason: 'config' }
  const problem = baseUrlProblem(base)
  if (problem !== null) return { ok: false, reason: problem === 'insecure-endpoint' ? 'insecure' : 'config' }
  let settings: LlmSettings
  if (provider.kind === 'openai-compatible') {
    settings = { apiKey: apiKey ?? '', model: '', customEndpoint: base, customModel: '' }
  } else {
    if (!apiKey) return { ok: false, reason: 'config' }
    settings = { apiKey, model: '', providerNpm: NPM[provider.kind], providerApi: base.replace(/\/+$/, '') }
  }
  const result = await llmTestConnection(settings, {
    mode: 'models',
    fetch: fetch as typeof globalThis.fetch,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (result.ok) return result.models && result.models.length > 0 ? { ok: true, models: result.models } : { ok: true }
  const reason = result.reason === 'cors' ? 'auth-or-network' : result.reason
  return result.status === undefined ? { ok: false, reason } : { ok: false, reason, status: result.status }
}
