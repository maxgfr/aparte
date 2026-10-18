import { describe, expect, test } from 'bun:test'
import type { ChatEvent, ChatRequest, PromptMessage, ProviderConfig, ProviderKind } from '../../contracts/ai.ts'
import { InvalidInputError } from '../../contracts/crypto.ts'
import {
  type LanguageModelLike,
  LocalModelError,
  type PromptAvailability,
  type PromptOptions,
} from '../../contracts/local.ts'
import { resolveCapabilities } from '../capabilities.ts'
import { createChromeAiAdapter, createWebllmAdapter, engineMessages, localError, promptLanguages } from './adapters.ts'
import { CHROME_AI_MODEL } from './catalog.ts'
import { scriptedEngine } from './fakes.ts'

const QWEN = 'Qwen3.5-0.8B-q4f16_1-MLC'
const HERMES = 'Hermes-3-Llama-3.1-8B-q4f16_1-MLC'

const provider = (kind: ProviderKind): ProviderConfig => ({
  id: `p-${kind}`,
  kind,
  label: kind,
  syncKey: false,
  createdAt: 0,
  updatedAt: 0,
})

const user = (text: string): PromptMessage => ({ role: 'user', parts: [{ type: 'text', text }] })
const assistant = (text: string): PromptMessage => ({ role: 'assistant', parts: [{ type: 'text', text }] })

function request(kind: ProviderKind, modelId: string, over: Partial<ChatRequest> = {}): ChatRequest {
  const p = provider(kind)
  return {
    provider: p,
    model: {
      ref: { provider: p.id, id: modelId },
      kind,
      name: modelId,
      capabilities: resolveCapabilities({ kind, modelId }),
    },
    apiKey: null,
    system: '',
    messages: [user('Hello')],
    tools: [],
    effort: null,
    signal: new AbortController().signal,
    ...over,
  }
}

async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = []
  for await (const e of stream) out.push(e)
  return out
}

describe('webllm adapter', () => {
  test('loads the model from the cache only, then streams text, usage and finish', async () => {
    const engine = scriptedEngine(() => [
      { type: 'delta', text: 'Bonjour' },
      { type: 'delta', text: ' !' },
      { type: 'done', finish: 'stop', usage: { input: 5, output: 2 } },
    ])
    const events = await collect(
      createWebllmAdapter({ engine: () => engine }).stream(request('webllm', QWEN, { system: 'Be brief.' })),
    )
    expect(engine.loads.map((l) => [l.modelId, l.options.download])).toEqual([[QWEN, false]])
    expect(engine.chats[0]?.messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'Hello' },
    ])
    expect(events).toEqual([
      { type: 'text-delta', id: 't0', text: 'Bonjour' },
      { type: 'text-delta', id: 't0', text: ' !' },
      { type: 'usage', usage: { input: 5, output: 2 } },
      { type: 'finish', stop: 'end', raw: 'stop', servedBy: QWEN },
    ])
  })

  test('a think block becomes a reasoning block, never sent back', async () => {
    const engine = scriptedEngine(() => [
      { type: 'delta', text: '<think>Capital' },
      { type: 'delta', text: ' of France.</think>\n\nParis.' },
      { type: 'done', finish: 'stop' },
    ])
    const prior: PromptMessage = {
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'secret thoughts' },
        { type: 'text', text: 'Earlier.' },
      ],
    }
    const events = await collect(
      createWebllmAdapter({ engine: () => engine }).stream(
        request('webllm', QWEN, { messages: [user('a'), prior, user('b')] }),
      ),
    )
    expect(
      events
        .filter((e) => e.type === 'reasoning-delta')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('Capital of France.')
    expect(events.some((e) => e.type === 'reasoning-end')).toBe(true)
    expect(
      events
        .filter((e) => e.type === 'text-delta')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('Paris.')
    expect(JSON.stringify(engine.chats[0]?.messages)).not.toContain('secret thoughts')
  })

  test('refuses what the model cannot take, before the engine runs', async () => {
    const engine = scriptedEngine(() => [])
    const adapter = createWebllmAdapter({ engine: () => engine })
    const tool = { name: 'search', description: 'd', inputSchema: { type: 'object' } }
    const image: PromptMessage = {
      role: 'user',
      parts: [{ type: 'image', blob: 'b', mediaType: 'image/png', width: 1, height: 1, data: new Uint8Array(1) }],
    }
    for (const over of [
      { tools: [tool] },
      { effort: 'high' as const },
      { messages: [user('a'), assistant('b')] },
      { messages: [image] },
      { sampling: { topK: 3 } },
      { maxOutputTokens: 1_000_000 },
    ]) {
      await expect(collect(adapter.stream(request('webllm', QWEN, over)))).rejects.toBeInstanceOf(InvalidInputError)
    }
    expect(engine.loads).toEqual([])
  })

  test('tools go to a model with function calling, and its calls come back', async () => {
    const engine = scriptedEngine(() => [
      { type: 'done', finish: 'tool_calls', toolCalls: [{ id: 'c1', name: 'search', arguments: '{"q":"x"}' }] },
    ])
    const tool = { name: 'search', description: 'Search', inputSchema: { type: 'object' } }
    const events = await collect(
      createWebllmAdapter({ engine: () => engine }).stream(request('webllm', HERMES, { tools: [tool] })),
    )
    expect(engine.chats[0]?.tools?.[0]?.function.name).toBe('search')
    expect(events).toContainEqual({ type: 'tool-call', callId: 'c1', name: 'search', input: { q: 'x' } })
    expect(events.at(-1)).toMatchObject({ type: 'finish', stop: 'tool-calls' })
  })

  test('a model that is not downloaded is an error event, not a download', async () => {
    const engine = scriptedEngine(() => [])
    engine.failLoadWith(new LocalModelError('not-downloaded', 'download it first'))
    const events = await collect(createWebllmAdapter({ engine: () => engine }).stream(request('webllm', QWEN)))
    expect(events).toEqual([
      { type: 'error', error: { code: 'not-found', message: 'download it first', retryable: false } },
    ])
  })

  test('an aborted stream ends without finish or error', async () => {
    const controller = new AbortController()
    const engine = scriptedEngine(() => [
      { type: 'delta', text: 'a' },
      { type: 'delta', text: 'b' },
      { type: 'done', finish: 'stop' },
    ])
    const out: ChatEvent[] = []
    for await (const e of createWebllmAdapter({ engine: () => engine }).stream(
      request('webllm', QWEN, { signal: controller.signal }),
    )) {
      out.push(e)
      controller.abort()
    }
    expect(out).toEqual([{ type: 'text-delta', id: 't0', text: 'a' }])
  })

  test('a stream that stops without done is truncated', async () => {
    const engine = scriptedEngine(() => [{ type: 'delta', text: 'a' }])
    const events = await collect(createWebllmAdapter({ engine: () => engine }).stream(request('webllm', QWEN)))
    expect(events.at(-1)).toEqual({ type: 'error', error: { code: 'truncated', message: '', retryable: true } })
  })

  test('engine messages carry tool calls and results', () => {
    const messages = engineMessages(
      request('webllm', HERMES, {
        messages: [
          user('q'),
          { role: 'assistant', parts: [{ type: 'tool-call', callId: 'c1', name: 'f', input: { a: 1 } }] },
          { role: 'tool', parts: [{ type: 'tool-result', callId: 'c1', name: 'f', output: { ok: true } }] },
          user('next'),
        ],
      }),
    )
    expect(messages[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }],
    })
    expect(messages[2]).toEqual({ role: 'tool', content: '{"ok":true}', tool_call_id: 'c1' })
  })

  test('local errors map to chat errors', () => {
    expect(localError(new LocalModelError('integrity', 'x')).code).toBe('server')
    expect(localError(new LocalModelError('unavailable', 'x')).code).toBe('invalid-request')
    expect(localError(new Error('Prompt exceeds the context window size')).code).toBe('context-length')
    expect(localError('weird').code).toBe('unknown')
  })
})

function fakePrompt(availability: PromptAvailability, chunks: readonly string[]) {
  const created: PromptOptions[] = []
  const prompts: string[] = []
  let destroyed = 0
  const api: LanguageModelLike = {
    availability: async () => availability,
    create: async (options = {}) => {
      created.push(options)
      return {
        async *promptStreaming(input: string) {
          prompts.push(input)
          for (const c of chunks) yield c
        },
        destroy: () => {
          destroyed++
        },
      }
    },
  }
  return { api, created, prompts, destroyed: () => destroyed }
}

describe('chrome-ai adapter', () => {
  test('history goes in the initial prompts, the last turn is prompted, the session is destroyed', async () => {
    const fake = fakePrompt('available', ['Hel', 'lo'])
    const events = await collect(
      createChromeAiAdapter({ api: () => fake.api }).stream(
        request('chrome-ai', CHROME_AI_MODEL, {
          system: 'Sys',
          messages: [user('one'), assistant('two'), user('three')],
        }),
      ),
    )
    expect(fake.created[0]?.initialPrompts).toEqual([
      { role: 'system', content: 'Sys' },
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ])
    expect(fake.created[0]?.expectedOutputs).toEqual([{ type: 'text', languages: ['en'] }])
    expect(fake.prompts).toEqual(['three'])
    expect(fake.destroyed()).toBe(1)
    expect(events).toEqual([
      { type: 'text-delta', id: 't0', text: 'Hel' },
      { type: 'text-delta', id: 't0', text: 'lo' },
      { type: 'finish', stop: 'end', servedBy: CHROME_AI_MODEL },
    ])
  })

  test('no Prompt API, or a model not downloaded, is an error event', async () => {
    const none = await collect(
      createChromeAiAdapter({ api: () => undefined }).stream(request('chrome-ai', CHROME_AI_MODEL)),
    )
    expect(none[0]).toMatchObject({ type: 'error', error: { code: 'invalid-request' } })
    const fake = fakePrompt('downloadable', [])
    const later = await collect(
      createChromeAiAdapter({ api: () => fake.api }).stream(request('chrome-ai', CHROME_AI_MODEL)),
    )
    expect(later[0]).toMatchObject({ type: 'error', error: { code: 'not-found' } })
    expect(fake.created).toEqual([])
  })

  test('prompt languages fall back to English', () => {
    expect(promptLanguages('ja-JP').expectedInputs).toEqual([{ type: 'text', languages: ['ja'] }])
    expect(promptLanguages('fr').expectedInputs).toEqual([{ type: 'text', languages: ['en'] }])
  })
})
