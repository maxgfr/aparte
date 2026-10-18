/*
 * The chat adapters of the on-device kinds (LocalAdaptersModule in web/src/core/contracts/local.ts): `webllm` over the
 * app's WebLLM engine (a worker), `chrome-ai` over Chrome's Prompt API. Both implement the same streaming contract as
 * the network adapters (web/src/core/ai/adapters.ts): a request the model's capabilities forbid is refused with
 * InvalidInputError before anything runs, a stream ends with exactly one `finish` or one `error` (neither after an
 * abort), and nothing leaves the device.
 */
import type {
  ChatAdapter,
  ChatError,
  ChatErrorCode,
  ChatEvent,
  ChatRequest,
  PromptMessage,
  PromptPart,
  ProviderKind,
  StopReason,
} from '../../contracts/ai.ts'
import { InvalidInputError } from '../../contracts/crypto.ts'
import {
  type EngineMessage,
  type LanguageModelLike,
  type LocalEngine,
  LocalModelError,
  type PromptOptions,
} from '../../contracts/local.ts'
import { thinkSplitter } from './think.ts'

function refuse(message: string): never {
  throw new InvalidInputError(message)
}

const textOf = (parts: readonly PromptPart[]) =>
  parts
    .filter((p): p is Extract<PromptPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')

/** What every on-device request must satisfy, whatever the engine. */
function validate(kind: ProviderKind, req: ChatRequest): void {
  const caps = req.model.capabilities
  if (req.provider.kind !== kind) refuse(`A ${req.provider.kind} provider was given to the ${kind} adapter`)
  if (req.messages.length === 0) refuse('A request needs at least one message')
  const last = req.messages[req.messages.length - 1] as PromptMessage
  if (last.role === 'assistant') refuse('The model does not continue an assistant message (prefill)')
  if (req.effort !== null) refuse(`The model does not take the effort ${req.effort}`)
  if (req.tools.length > 0 && !caps.tools) refuse('The model does not take tools')
  if (req.toolChoice === 'required' || typeof req.toolChoice === 'object') {
    refuse('The model does not accept a forced tool choice')
  }
  for (const [key, value] of Object.entries(req.sampling ?? {})) {
    if (value === undefined) continue
    if (!caps.sampling.includes(key as never)) refuse(`The model does not take ${key}`)
    if (!Number.isFinite(value)) refuse(`${key} must be a finite number`)
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
      if (part.type === 'image') refuse('The model does not take images')
      if (part.type === 'file' && !part.mediaType.startsWith('text/')) refuse('The model does not take files')
    }
  })
}

/** A user turn as text: its text parts, then any text file it carries, delimited. */
function userText(parts: readonly PromptPart[]): string {
  const out: string[] = []
  for (const p of parts) {
    if (p.type === 'text') out.push(p.text)
    else if (p.type === 'file') {
      out.push(`<file name="${p.name}">\n${new TextDecoder().decode(p.data)}\n</file>`)
    }
  }
  return out.join('\n\n')
}

/** The engine's messages: the frozen system prompt, then the turns; reasoning is never sent back. */
export function engineMessages(req: ChatRequest): EngineMessage[] {
  const out: EngineMessage[] = []
  if (req.system !== '') out.push({ role: 'system', content: req.system })
  for (const m of req.messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: userText(m.parts) })
    } else if (m.role === 'assistant') {
      const calls = m.parts.filter((p): p is Extract<PromptPart, { type: 'tool-call' }> => p.type === 'tool-call')
      out.push({
        role: 'assistant',
        content: textOf(m.parts),
        ...(calls.length === 0
          ? {}
          : {
              tool_calls: calls.map((c) => ({
                id: c.callId,
                type: 'function' as const,
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }),
      })
    } else if (m.role === 'tool') {
      for (const p of m.parts) {
        if (p.type !== 'tool-result') continue
        const content = typeof p.output === 'string' ? p.output : JSON.stringify(p.output)
        out.push({ role: 'tool', content, tool_call_id: p.callId })
      }
    }
  }
  return out
}

/** A local engine's failure, as the chat shows it; the message stays English (shown as the provider's detail). */
export function localError(error: unknown): ChatError {
  const message = error instanceof Error ? error.message : String(error)
  let code: ChatErrorCode = 'unknown'
  if (error instanceof LocalModelError) {
    if (error.code === 'not-downloaded' || error.code === 'unsupported-model') code = 'not-found'
    else if (error.code === 'unavailable') code = 'invalid-request'
    else code = 'server'
  } else if (/context.?window|exceed/i.test(message)) code = 'context-length'
  return { code, message, retryable: code === 'server' || code === 'unknown' }
}

function stopOf(finish: string): StopReason {
  switch (finish) {
    case 'stop':
      return 'end'
    case 'length':
      return 'length'
    case 'tool_calls':
      return 'tool-calls'
    default:
      return 'other'
  }
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

async function* streamWebllm(engine: () => LocalEngine, req: ChatRequest): AsyncGenerator<ChatEvent> {
  validate('webllm', req)
  const messages = engineMessages(req)
  const modelId = req.model.ref.id
  if (req.signal.aborted) return
  const split = thinkSplitter()
  let reasoningId = 0
  let inReasoning = false
  const events = (pieces: ReturnType<typeof split.push>): ChatEvent[] =>
    pieces.map((p): ChatEvent => {
      if (p.kind === 'end') {
        inReasoning = false
        return { type: 'reasoning-end', id: `r${reasoningId++}` }
      }
      if (p.kind === 'reasoning') {
        inReasoning = true
        return { type: 'reasoning-delta', id: `r${reasoningId}`, text: p.text }
      }
      return { type: 'text-delta', id: 't0', text: p.text }
    })
  try {
    const e = engine()
    await e.load(modelId, { download: false, signal: req.signal })
    if (req.signal.aborted) return
    const s = req.sampling ?? {}
    const stream = e.chat(
      {
        modelId,
        messages,
        ...(req.tools.length === 0
          ? {}
          : {
              tools: req.tools.map((t) => ({
                type: 'function' as const,
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
              })),
            }),
        ...(req.maxOutputTokens === undefined ? {} : { maxTokens: req.maxOutputTokens }),
        ...(s.temperature === undefined ? {} : { temperature: s.temperature }),
        ...(s.topP === undefined ? {} : { topP: s.topP }),
        ...(s.presencePenalty === undefined ? {} : { presencePenalty: s.presencePenalty }),
        ...(s.frequencyPenalty === undefined ? {} : { frequencyPenalty: s.frequencyPenalty }),
        ...(s.seed === undefined ? {} : { seed: s.seed }),
      },
      req.signal,
    )
    for await (const chunk of stream) {
      if (req.signal.aborted) return
      if (chunk.type === 'delta') {
        yield* events(split.push(chunk.text))
        continue
      }
      yield* events(split.flush())
      if (inReasoning) yield { type: 'reasoning-end', id: `r${reasoningId++}` }
      if (chunk.finish === 'abort') return
      for (const call of chunk.toolCalls ?? []) {
        yield { type: 'tool-call', callId: call.id, name: call.name, input: parseArguments(call.arguments) }
      }
      if (chunk.usage) yield { type: 'usage', usage: { input: chunk.usage.input, output: chunk.usage.output } }
      yield { type: 'finish', stop: stopOf(chunk.finish), raw: chunk.finish, servedBy: modelId }
      return
    }
  } catch (error) {
    if (req.signal.aborted) return
    yield { type: 'error', error: localError(error) }
    return
  }
  if (req.signal.aborted) return
  yield { type: 'error', error: { code: 'truncated', message: '', retryable: true } }
}

/** Languages Gemini Nano is documented to answer in; the session asks for English unless the page says otherwise. */
const PROMPT_LANGUAGES = ['en', 'es', 'ja']

/** The Prompt API options the app always passes, so Chrome knows the input and output languages. */
export function promptLanguages(locale?: string): Pick<PromptOptions, 'expectedInputs' | 'expectedOutputs'> {
  const base = (locale ?? 'en').slice(0, 2).toLowerCase()
  const lang = PROMPT_LANGUAGES.includes(base) ? base : 'en'
  return {
    expectedInputs: [{ type: 'text', languages: [lang] }],
    expectedOutputs: [{ type: 'text', languages: [lang] }],
  }
}

/** The pieces of a stream, whether the engine iterates `ReadableStream` itself or not. */
async function* chunksOf(stream: AsyncIterable<string> | ReadableStream<string>): AsyncGenerator<string> {
  if (!('getReader' in stream)) {
    yield* stream
    return
  }
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    reader.releaseLock()
  }
}

async function* streamChromeAi(api: () => LanguageModelLike | undefined, req: ChatRequest): AsyncGenerator<ChatEvent> {
  validate('chrome-ai', req)
  if (req.tools.length > 0) refuse('The model does not take tools')
  const messages = engineMessages(req)
  const last = messages.pop()
  if (last?.role !== 'user') refuse('The last message must be a user message')
  const initialPrompts: { role: 'system' | 'user' | 'assistant'; content: string }[] = []
  for (const m of messages) {
    if (m.role === 'tool') refuse('The model does not take tools')
    initialPrompts.push({ role: m.role, content: m.content })
  }
  if (req.signal.aborted) return
  let session: Awaited<ReturnType<LanguageModelLike['create']>> | null = null
  try {
    const model = api()
    if (model === undefined) throw new LocalModelError('unavailable', 'This browser has no built-in Prompt API')
    const languages = promptLanguages()
    const availability = await model.availability(languages)
    if (availability !== 'available') {
      throw new LocalModelError(
        availability === 'unavailable' ? 'unavailable' : 'not-downloaded',
        `Chrome's built-in model is ${availability}`,
      )
    }
    session = await model.create({ ...languages, initialPrompts, signal: req.signal })
    if (req.signal.aborted) return
    for await (const text of chunksOf(session.promptStreaming(last.content, { signal: req.signal }))) {
      if (req.signal.aborted) return
      if (text !== '') yield { type: 'text-delta', id: 't0', text }
    }
    if (req.signal.aborted) return
    yield { type: 'finish', stop: 'end', servedBy: req.model.ref.id }
  } catch (error) {
    if (req.signal.aborted) return
    yield { type: 'error', error: localError(error) }
  } finally {
    session?.destroy()
  }
}

export function createWebllmAdapter(deps: { readonly engine: () => LocalEngine }): ChatAdapter {
  return { kind: 'webllm', stream: (request) => streamWebllm(deps.engine, request) }
}

export function createChromeAiAdapter(deps: { readonly api: () => LanguageModelLike | undefined }): ChatAdapter {
  return { kind: 'chrome-ai', stream: (request) => streamChromeAi(deps.api, request) }
}
