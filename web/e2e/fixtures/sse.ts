import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/*
 * Provider answers for the end-to-end specs: the recorded streams of spec/sse, read byte for byte, and builders for
 * answers a spec composes itself (an XSS payload, a long Markdown answer cut at random places). The builders follow
 * the framing of the recorded files exactly, so whatever parses the recordings parses them too.
 */

const SSE_DIR = new URL('../../../spec/sse/', import.meta.url)

/** One recorded answer and what spec/sse/index.json says the adapter must make of it. */
export interface Recorded {
  readonly file: string
  readonly provider: 'anthropic' | 'openai-compatible' | 'google'
  readonly status: number
  readonly contentType: string
  readonly model: string
  readonly body: string
  readonly expect: {
    readonly text: string
    readonly reasoning?: readonly { readonly text: string; readonly providerMeta?: unknown }[]
    readonly stop?: string
    readonly refusal?: { readonly category: string | null; readonly explanation?: string }
    readonly error?: { readonly code: string; readonly message?: string }
  }
}

const index = JSON.parse(readFileSync(fileURLToPath(new URL('index.json', SSE_DIR)), 'utf8')) as Record<
  string,
  Omit<Recorded, 'file' | 'body'>
>

/** A file of spec/sse with its index entry; an unknown name throws, so a typo cannot serve an empty answer. */
export function recorded(file: string): Recorded {
  const meta = index[file]
  if (!meta || file.startsWith('$')) throw new Error(`spec/sse has no fixture ${file}`)
  // Bytes as recorded: the Gemini file keeps its CRLF line endings.
  const body = readFileSync(fileURLToPath(new URL(file, SSE_DIR)), 'utf8')
  return { ...meta, file, body }
}

/** A provider answer to serve: an HTTP status, a content type and the body, sent whole. */
export interface Answer {
  readonly status: number
  readonly contentType: string
  readonly body: string
}

export function answerOf(r: Recorded): Answer {
  return { status: r.status, contentType: r.contentType, body: r.body }
}

const event = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`

let serial = 0
/** Ids in the providers' own shapes; synthetic, unique within a run. */
const nextId = (prefix: string) => `${prefix}${(++serial).toString(36).padStart(8, '0')}E2E`

/** An Anthropic Messages stream whose single text block arrives as `deltas`, in order. */
export function anthropicText(deltas: readonly string[], model = 'claude-opus-5-5'): Answer {
  const usage = { input_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  const body = [
    event('message_start', {
      type: 'message_start',
      message: {
        id: nextId('msg_'),
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: { ...usage, output_tokens: 1, service_tier: 'standard' },
      },
    }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...deltas.map((text) =>
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    ),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null },
      usage: { ...usage, output_tokens: Math.max(1, deltas.length) },
    }),
    event('message_stop', { type: 'message_stop' }),
  ].join('')
  return { status: 200, contentType: 'text/event-stream', body }
}

/** The `data:` lines of an OpenAI chat completions stream whose content arrives as `deltas`, `[DONE]` included. */
export function openAIChunks(deltas: readonly string[], model = 'llama-3.3-70b-versatile'): string[] {
  const id = nextId('chatcmpl-')
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: 1760700000,
      model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    })}\n\n`
  return [
    chunk({ role: 'assistant', content: '' }, null),
    ...deltas.map((content) => chunk({ content }, null)),
    chunk({}, 'stop'),
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: 1760700000,
      model,
      choices: [],
      usage: { prompt_tokens: 14, completion_tokens: deltas.length, total_tokens: 14 + deltas.length },
    })}\n\n`,
    'data: [DONE]\n\n',
  ]
}

/**
 * A small deterministic generator (mulberry32), so a failing random split can be replayed from the seed the spec
 * reports.
 */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * `text` cut into pieces of 1 to `max` UTF-16 units at random places, never inside a surrogate pair (a provider
 * splits text between characters). Joined, the pieces are `text` again.
 */
export function randomSplit(text: string, random: () => number, max = 12): string[] {
  const pieces: string[] = []
  let at = 0
  while (at < text.length) {
    let end = Math.min(text.length, at + 1 + Math.floor(random() * max))
    const code = text.charCodeAt(end - 1)
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end += 1
    pieces.push(text.slice(at, end))
    at = end
  }
  return pieces
}

/** `bytes` cut into 1 to `max` byte pieces at random places, through UTF-8 sequences and SSE lines alike. */
export function randomByteSplit(bytes: Uint8Array, random: () => number, max = 48): Uint8Array[] {
  const pieces: Uint8Array[] = []
  for (let at = 0; at < bytes.length; ) {
    const end = Math.min(bytes.length, at + 1 + Math.floor(random() * max))
    pieces.push(bytes.subarray(at, end))
    at = end
  }
  return pieces
}

/** A tool call an answer makes, as the builders below write it in each provider's own framing. */
export interface ToolCallSpec {
  readonly name: string
  readonly input: Readonly<Record<string, unknown>>
  /** The provider's call id; generated when absent (Gemini has none). */
  readonly id?: string
}

/**
 * An Anthropic Messages stream that writes `text` (when given), then calls the tools of `calls`, ending with
 * `stop_reason: "tool_use"`; the framing of spec/sse/anthropic-tool-call.sse.
 */
export function anthropicToolCalls(calls: readonly ToolCallSpec[], text = '', model = 'claude-opus-5-5'): Answer {
  const usage = { input_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
  const blocks: string[] = []
  let index = 0
  if (text !== '') {
    blocks.push(
      event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }),
      event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }),
      event('content_block_stop', { type: 'content_block_stop', index }),
    )
    index += 1
  }
  for (const call of calls) {
    blocks.push(
      event('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: call.id ?? nextId('toolu_'), name: call.name, input: {} },
      }),
      event('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) },
      }),
      event('content_block_stop', { type: 'content_block_stop', index }),
    )
    index += 1
  }
  const body = [
    event('message_start', {
      type: 'message_start',
      message: {
        id: nextId('msg_'),
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: { ...usage, output_tokens: 1, service_tier: 'standard' },
      },
    }),
    ...blocks,
    event('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null, stop_details: null },
      usage: { ...usage, output_tokens: 24 },
    }),
    event('message_stop', { type: 'message_stop' }),
  ].join('')
  return { status: 200, contentType: 'text/event-stream', body }
}

/** An OpenAI chat completions stream that calls `call`, ending with `finish_reason: "tool_calls"`. */
export function openAIToolCall(call: ToolCallSpec, model = 'llama-3.3-70b-versatile'): Answer {
  const id = nextId('chatcmpl-')
  const chunk = (delta: unknown, finish: string | null) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: 1760700000,
      model,
      choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }],
    })}\n\n`
  const body = [
    chunk({ role: 'assistant', content: null }, null),
    chunk(
      {
        tool_calls: [
          {
            index: 0,
            id: call.id ?? nextId('call_'),
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          },
        ],
      },
      null,
    ),
    chunk({}, 'tool_calls'),
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1760700000, model, choices: [], usage: { prompt_tokens: 90, completion_tokens: 12, total_tokens: 102 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('')
  return { status: 200, contentType: 'text/event-stream', body }
}

/** A Gemini `streamGenerateContent` stream (CRLF framing) whose one chunk calls `call`. */
export function geminiToolCall(call: ToolCallSpec, model = 'gemini-3-flash'): Answer {
  const chunk = {
    candidates: [
      {
        content: { parts: [{ functionCall: { name: call.name, args: call.input } }], role: 'model' },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 10, totalTokenCount: 90 },
    modelVersion: model,
    responseId: nextId('resp'),
  }
  return { status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify(chunk)}\r\n\r\n` }
}

/** A Gemini stream whose one chunk is the whole text answer. */
export function geminiText(text: string, model = 'gemini-3-flash'): Answer {
  const chunk = {
    candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 80, candidatesTokenCount: 10, totalTokenCount: 90 },
    modelVersion: model,
    responseId: nextId('resp'),
  }
  return { status: 200, contentType: 'text/event-stream', body: `data: ${JSON.stringify(chunk)}\r\n\r\n` }
}

/** A whole OpenAI chat completions text answer, sent at once. */
export function openAIText(text: string, model = 'llama-3.3-70b-versatile'): Answer {
  return { status: 200, contentType: 'text/event-stream', body: openAIChunks([text], model).join('') }
}
