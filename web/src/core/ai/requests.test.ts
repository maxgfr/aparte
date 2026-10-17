/*
 * What each adapter puts on the wire beyond the contract tests of adapters.test.ts: the per-provider effort parameter,
 * OpenAI's stateless Responses call, Gemini's thinking configuration, OpenRouter's reasoning, the thinking budget of
 * older Claude models, verbatim replay of other providers' metadata, and the header allowlist.
 */
import { describe, expect, test } from 'bun:test'
import type { ChatEvent, ChatRequest, FetchLike, PromptMessage, ProviderConfig, ProviderKind } from '../contracts/ai.ts'
import { InvalidInputError } from '../contracts/crypto.ts'
import { createAdapter } from './adapters.ts'
import { resolveCapabilities } from './capabilities.ts'
import { guardedFetch } from './providers.ts'

const SSE = new URL('../../../../spec/sse/', import.meta.url)
const now = 1_760_000_000_000
const KEY = 'sk-test-key-0123456789'

interface Call {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function serve(body: string) {
  const calls: Call[] = []
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    calls.push({ url: String(input), headers, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  return { fetch, calls }
}

const provider = (kind: ProviderKind, over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: `p-${kind}`,
  kind,
  label: kind,
  syncKey: false,
  createdAt: now,
  updatedAt: now,
  ...over,
})

const user = (text: string): PromptMessage => ({ role: 'user', parts: [{ type: 'text', text }] })

function request(kind: ProviderKind, modelId: string, over: Partial<ChatRequest> = {}): ChatRequest {
  const p = over.provider ?? provider(kind)
  return {
    provider: p,
    model: {
      ref: { provider: p.id, id: modelId },
      kind,
      name: modelId,
      capabilities: resolveCapabilities({ kind, modelId }),
    },
    apiKey: KEY,
    system: '',
    messages: [user('Hello')],
    tools: [],
    effort: null,
    signal: new AbortController().signal,
    ...over,
  }
}

async function drain(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = []
  for await (const e of stream) out.push(e)
  return out
}

const fixture = (name: string) => Bun.file(new URL(name, SSE)).text()

describe('OpenAI', () => {
  test('Responses API, stateless, encrypted reasoning and a summary requested, effort as reasoning.effort', async () => {
    const served = serve('')
    await drain(
      createAdapter('openai', { fetch: served.fetch }).stream(request('openai', 'gpt-5', { effort: 'minimal' })),
    )
    const call = served.calls[0] as Call
    expect(call.url).toBe('https://api.openai.com/v1/responses')
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`)
    expect(call.body.store).toBe(false)
    expect(call.body.include).toEqual(['reasoning.encrypted_content'])
    expect(call.body.reasoning).toEqual({ effort: 'minimal', summary: 'auto' })
  })

  test('a completed Responses stream finishes (it has no raw reason), with usage and reasoning metadata kept', async () => {
    const response = { id: 'resp_1', object: 'response', created_at: 1, model: 'gpt-5', status: 'in_progress' }
    const events = [
      { type: 'response.created', sequence_number: 0, response },
      {
        type: 'response.output_item.added',
        output_index: 0,
        sequence_number: 1,
        item: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENC123' },
      },
      {
        type: 'response.reasoning_summary_part.added',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        sequence_number: 2,
        part: { type: 'summary_text', text: '' },
      },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        sequence_number: 3,
        delta: 'Thinking.',
      },
      {
        type: 'response.reasoning_summary_part.done',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        sequence_number: 4,
        part: { type: 'summary_text', text: 'Thinking.' },
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        sequence_number: 5,
        item: {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'Thinking.' }],
          encrypted_content: 'ENC123',
        },
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        sequence_number: 6,
        item: { type: 'message', id: 'msg_1', role: 'assistant', status: 'in_progress', content: [] },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 1,
        content_index: 0,
        sequence_number: 7,
        delta: 'Hi.',
        logprobs: [],
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        sequence_number: 8,
        item: {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Hi.', annotations: [] }],
        },
      },
      {
        type: 'response.completed',
        sequence_number: 9,
        response: {
          ...response,
          status: 'completed',
          incomplete_details: null,
          usage: {
            input_tokens: 7,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 20,
            output_tokens_details: { reasoning_tokens: 16 },
          },
        },
      },
    ]
    const served = serve(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
    const out = await drain(
      createAdapter('openai', { fetch: served.fetch }).stream(request('openai', 'gpt-5', { effort: 'low' })),
    )
    expect(out.filter((e) => e.type === 'text-delta').map((e) => (e as { text: string }).text)).toEqual(['Hi.'])
    const end = out.find((e) => e.type === 'reasoning-end') as { providerMeta?: { openai?: Record<string, unknown> } }
    expect(end?.providerMeta?.openai?.itemId).toBe('rs_1')
    expect(out.find((e) => e.type === 'usage')).toMatchObject({ usage: { input: 7, output: 20, reasoning: 16 } })
    expect(out.at(-1)).toMatchObject({ type: 'finish', stop: 'end' })
  })

  test('a non-reasoning model gets neither reasoning nor include', async () => {
    const served = serve('')
    await drain(createAdapter('openai', { fetch: served.fetch }).stream(request('openai', 'gpt-4o')))
    const body = (served.calls[0] as Call).body
    expect(body.store).toBe(false)
    expect('include' in body).toBe(false)
    expect('reasoning' in body).toBe(false)
  })
})

describe('Gemini', () => {
  test('Gemini 3 takes a thinking level and returns thought summaries', async () => {
    const served = serve(await fixture('gemini-text.sse'))
    await drain(
      createAdapter('google', { fetch: served.fetch }).stream(request('google', 'gemini-3-pro', { effort: 'high' })),
    )
    const config = (served.calls[0] as Call).body.generationConfig as Record<string, unknown>
    expect(config.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'high' })
  })

  test('Gemini 2.5 takes a thinking budget', async () => {
    const served = serve(await fixture('gemini-text.sse'))
    await drain(
      createAdapter('google', { fetch: served.fetch }).stream(request('google', 'gemini-2.5-flash', { effort: 'low' })),
    )
    const config = (served.calls[0] as Call).body.generationConfig as Record<string, unknown>
    expect(config.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 1024 })
  })
})

describe('OpenRouter', () => {
  test('reasoning.effort on a maker model, and no attribution header', async () => {
    const served = serve(await fixture('openai-compatible-text.sse'))
    const events = await drain(
      createAdapter('openrouter', { fetch: served.fetch }).stream(
        request('openrouter', 'anthropic/claude-opus-5-5', { effort: 'xhigh' }),
      ),
    )
    const call = served.calls[0] as Call
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(call.body.reasoning).toEqual({ effort: 'xhigh' })
    expect(Object.keys(call.headers).sort()).toEqual(['authorization', 'content-type'])
    expect(events.at(-1)).toMatchObject({ type: 'finish', stop: 'end', raw: 'stop' })
  })
})

describe('Mistral', () => {
  test('chat completions at its default host, ending with a finish', async () => {
    // Mistral puts the usage on the chunk that finishes, with no empty-choices chunk.
    const chunk = (delta: object, finish: string | null, usage?: object) =>
      `data: ${JSON.stringify({
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mistral-large-latest',
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      })}\n\n`
    const body =
      chunk({ role: 'assistant', content: 'Bon' }, null) +
      chunk({ content: 'jour.' }, 'stop', { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }) +
      'data: [DONE]\n\n'
    const served = serve(body)
    const events = await drain(
      createAdapter('mistral', { fetch: served.fetch }).stream(request('mistral', 'mistral-large-latest')),
    )
    expect((served.calls[0] as Call).url).toBe('https://api.mistral.ai/v1/chat/completions')
    expect(events.at(-1)).toMatchObject({ type: 'finish', stop: 'end', raw: 'stop' })
  })
})

describe('Anthropic', () => {
  test('Haiku 4.5 takes effort as a thinking budget inside its output limit', async () => {
    const served = serve(await fixture('anthropic-text.sse'))
    await drain(
      createAdapter('anthropic', { fetch: served.fetch }).stream(
        request('anthropic', 'claude-haiku-4-5', { effort: 'medium' }),
      ),
    )
    const body = (served.calls[0] as Call).body
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect(body.max_tokens).toBe(64_000)
    expect('output_config' in body).toBe(false)
  })

  test('a thinking budget and a sampling parameter together are refused before any call', async () => {
    const served = serve('')
    const req = request('anthropic', 'claude-haiku-4-5', { effort: 'low', sampling: { temperature: 0.2 } })
    await expect(drain(createAdapter('anthropic', { fetch: served.fetch }).stream(req))).rejects.toBeInstanceOf(
      InvalidInputError,
    )
    expect(served.calls).toHaveLength(0)
  })

  test('a mid-conversation system message is refused for a model that does not take one', async () => {
    const served = serve('')
    const messages: PromptMessage[] = [
      user('Hi'),
      { role: 'assistant', parts: [{ type: 'text', text: 'Hello.' }] },
      { role: 'system', parts: [{ type: 'text', text: 'Be terse.' }] },
      user('Go on'),
    ]
    const req = request('anthropic', 'claude-opus-4-7', { effort: 'high', messages })
    await expect(drain(createAdapter('anthropic', { fetch: served.fetch }).stream(req))).rejects.toBeInstanceOf(
      InvalidInputError,
    )
    expect(served.calls).toHaveLength(0)
  })

  test('a refusal is reported with its category and the fixture partial text still streams', async () => {
    const served = serve(await fixture('anthropic-refusal.sse'))
    const events = await drain(
      createAdapter('anthropic', { fetch: served.fetch }).stream(
        request('anthropic', 'claude-opus-5-5', { effort: 'low' }),
      ),
    )
    const finish = events.at(-1)
    expect(finish).toMatchObject({ type: 'finish', stop: 'refusal', raw: 'refusal', refusal: { category: 'cyber' } })
  })
})

describe('Anthropic refusal fallback', () => {
  const fallback = { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } }
  const sse = [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-4-8","content":[],"stop_reason":null,"usage":{"input_tokens":5,"output_tokens":1}}}`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":${JSON.stringify(fallback)}}`,
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Served."}}',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ].join('\n\n')

  test('a fallback switch point arrives as a provider block and the serving model is named', async () => {
    const served = serve(`${sse}\n\n`)
    const events = await drain(
      createAdapter('anthropic', { fetch: served.fetch }).stream(
        request('anthropic', 'claude-opus-5-5', { effort: 'low' }),
      ),
    )
    expect(events).toContainEqual({ type: 'provider-block', provider: 'anthropic', block: fallback })
    expect(events.at(-1)).toMatchObject({ type: 'finish', stop: 'end', servedBy: 'claude-opus-4-8' })
  })

  test('it is replayed where it appeared, with a single fallback beta next to fallbacks: default', async () => {
    const served = serve(await fixture('anthropic-text.sse'))
    const messages: PromptMessage[] = [
      user('One'),
      {
        role: 'assistant',
        parts: [
          { type: 'provider', provider: 'anthropic', block: fallback },
          { type: 'text', text: 'Served.' },
        ],
      },
      user('Two'),
    ]
    await drain(
      createAdapter('anthropic', { fetch: served.fetch }).stream(
        request('anthropic', 'claude-opus-5-5', { effort: 'low', messages }),
      ),
    )
    const call = served.calls[0] as Call
    const sent = call.body.messages as { content: unknown[] }[]
    expect(sent[1]?.content[0]).toEqual(fallback)
    expect(call.body.fallbacks).toBe('default')
    const betas = call.headers['anthropic-beta']?.split(',') ?? []
    expect(betas).toContain('server-side-fallback-2026-07-01')
    expect(betas).not.toContain('server-side-fallback-2026-06-01')
  })

  test('a provider block this build cannot replay is refused, not dropped', async () => {
    const served = serve('')
    const messages: PromptMessage[] = [
      user('One'),
      { role: 'assistant', parts: [{ type: 'provider', provider: 'anthropic', block: { type: 'compaction' } }] },
      user('Two'),
    ]
    const req = request('anthropic', 'claude-opus-5-5', { effort: 'low', messages })
    await expect(drain(createAdapter('anthropic', { fetch: served.fetch }).stream(req))).rejects.toBeInstanceOf(
      InvalidInputError,
    )
  })
})

describe('replay of other providers', () => {
  test('a Gemini thought signature is sent back to Gemini only, unchanged', async () => {
    const signature = 'CiQB0e2Kb7sig/+=='
    const messages: PromptMessage[] = [
      user('One'),
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'thinking', providerMeta: { google: { thoughtSignature: signature } } },
          { type: 'text', text: 'Two' },
        ],
      },
      user('Three'),
    ]
    const served = serve(await fixture('gemini-text.sse'))
    await drain(
      createAdapter('google', { fetch: served.fetch }).stream(request('google', 'gemini-3-flash', { messages })),
    )
    expect(JSON.stringify((served.calls[0] as Call).body)).toContain(signature)
    const other = serve(await fixture('anthropic-text.sse'))
    await drain(
      createAdapter('anthropic', { fetch: other.fetch }).stream(request('anthropic', 'claude-opus-5-5', { messages })),
    )
    expect(JSON.stringify((other.calls[0] as Call).body)).not.toContain(signature)
  })
})

describe('guardedFetch', () => {
  test('keeps only the kind’s own headers, and the direct-browser header for Anthropic’s host only', async () => {
    const seen: Record<string, string>[] = []
    const base: FetchLike = async (_input, init) => {
      const h: Record<string, string> = {}
      new Headers(init?.headers).forEach((v, k) => {
        h[k] = v
      })
      seen.push(h)
      return new Response('')
    }
    const headers = {
      'user-agent': 'ai-sdk/7',
      'x-api-key': 'k',
      'anthropic-dangerous-direct-browser-access': 'true',
      'x-title': 'app',
      'content-type': 'application/json',
    }
    await guardedFetch('anthropic', base)('https://api.anthropic.com/v1/messages', { headers })
    await guardedFetch('anthropic', base)('https://proxy.example.org/v1/messages', { headers })
    await guardedFetch('openai-compatible', base)('https://api.groq.com/openai/v1/models', {
      headers: { ...headers, authorization: 'Bearer k' },
    })
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual([
      'anthropic-dangerous-direct-browser-access',
      'content-type',
      'x-api-key',
    ])
    expect(Object.keys(seen[1] ?? {}).sort()).toEqual(['content-type', 'x-api-key'])
    expect(Object.keys(seen[2] ?? {}).sort()).toEqual(['authorization', 'content-type'])
  })
})

describe('keys and endpoints', () => {
  test('a keyed provider without a key, and plain HTTP off the loopback, are refused before any call', async () => {
    const served = serve('')
    const cases: ChatRequest[] = [
      request('anthropic', 'claude-opus-5-5', { apiKey: null }),
      request('openai-compatible', 'llama', {
        provider: provider('openai-compatible', { baseUrl: 'http://192.168.1.4:11434/v1', preset: 'ollama' }),
      }),
      request('openai-compatible', 'llama', {
        provider: provider('openai-compatible', { baseUrl: 'http://[::1]:11434/v1', preset: 'ollama' }),
      }),
    ]
    for (const req of cases) {
      const adapter = createAdapter(req.provider.kind, { fetch: served.fetch })
      await expect(drain(adapter.stream(req))).rejects.toBeInstanceOf(InvalidInputError)
    }
    expect(served.calls).toHaveLength(0)
  })

  test('a keyless local server is called without an Authorization header', async () => {
    const served = serve(await fixture('openai-compatible-text.sse'))
    const local = provider('openai-compatible', { baseUrl: 'http://localhost:11434/v1', preset: 'ollama' })
    const events = await drain(
      createAdapter('openai-compatible', { fetch: served.fetch }).stream(
        request('openai-compatible', 'llama3.2', { provider: local, apiKey: null }),
      ),
    )
    expect(events.at(-1)?.type).toBe('finish')
    expect((served.calls[0] as Call).url).toBe('http://localhost:11434/v1/chat/completions')
    expect('authorization' in (served.calls[0] as Call).headers).toBe(false)
  })
})
