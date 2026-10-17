/*
 * The provider adapters (web/src/core/contracts/ai.ts, AdaptersModule) against the recorded streams of spec/sse, served
 * by a fake fetch that also captures every request. Pinned here: what each stream yields, what each request contains
 * (Anthropic effort, summarized thinking, verbatim thinking replay, mid-conversation system messages, the refusal
 * fallback opt-in, OpenAI-compatible usage), the headers that may cross a CORS preflight, the refusals made before any
 * network call, and that the default fetch is web/src/security/net.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { networkLog, resetNetworkLog } from '../../security/net.ts'
import type {
  AdaptersModule,
  CapabilitiesModule,
  ChatAdapter,
  ChatEvent,
  ChatRequest,
  FetchLike,
  PromptMessage,
  ProviderConfig,
  ProviderFetchModule,
  ProviderKind,
  ToolDefinition,
} from '../contracts/ai.ts'
import { InvalidInputError } from '../contracts/crypto.ts'
import * as adaptersImpl from './adapters.ts'
import * as capabilitiesImpl from './capabilities.ts'
import * as fetchImpl from './fetch.ts'

const A: AdaptersModule = adaptersImpl
const C: CapabilitiesModule = capabilitiesImpl
const F: ProviderFetchModule = fetchImpl

const SSE = new URL('../../../../spec/sse/', import.meta.url)

interface Expected {
  text: string
  reasoning: { text: string; providerMeta?: unknown }[]
  stop?: string
  raw?: string
  usage?: Record<string, number>
  refusal?: { category: string | null; explanation?: string }
  error?: { code: string; retryable: boolean; status?: number; message?: string }
}
interface Fixture {
  provider: ProviderKind
  status: number
  contentType: string
  model: string
  expect: Expected
}
const index = (await Bun.file(new URL('index.json', SSE)).json()) as Record<string, Fixture | string>
const fixtures = Object.entries(index).filter((e): e is [string, Fixture] => typeof e[1] === 'object')

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown> | null
}

/** A fetch that answers every call with `body` and records the requests. */
function serve(body: string | (() => ReadableStream<Uint8Array>), status = 200, contentType = 'text/event-stream') {
  const calls: Call[] = []
  const fetch: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value
    })
    const raw = init?.body
    calls.push({
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? 'GET',
      headers,
      body: typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : null,
    })
    const payload = typeof body === 'string' ? body : body()
    return new Response(payload, { status, headers: { 'content-type': contentType } })
  }
  return { fetch, calls }
}

async function fixture(file: string) {
  const meta = index[file] as Fixture
  return serve(await Bun.file(new URL(file, SSE)).text(), meta.status, meta.contentType)
}

const now = 1_760_000_000_000
const PROVIDERS: Record<string, ProviderConfig> = {
  anthropic: { id: 'pa', kind: 'anthropic', label: 'Anthropic', syncKey: false, createdAt: now, updatedAt: now },
  'openai-compatible': {
    id: 'pc',
    kind: 'openai-compatible',
    label: 'Groq',
    preset: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    syncKey: false,
    createdAt: now,
    updatedAt: now,
  },
  google: { id: 'pg', kind: 'google', label: 'Gemini', syncKey: false, createdAt: now, updatedAt: now },
}

const KEY = 'sk-test-key-0123456789'
const SEARCH: ToolDefinition = {
  name: 'search',
  description: 'Searches the notes.',
  inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false },
}
const user = (text: string): PromptMessage => ({ role: 'user', parts: [{ type: 'text', text }] })

function chatRequest(kind: ProviderKind, modelId: string, over: Partial<ChatRequest> = {}): ChatRequest {
  const provider = over.provider ?? (PROVIDERS[kind] as ProviderConfig)
  return {
    provider,
    model: {
      ref: { provider: provider.id, id: modelId },
      kind,
      name: modelId,
      capabilities: C.resolveCapabilities({ kind, modelId }),
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

async function collect(stream: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = []
  for await (const e of stream) out.push(e)
  return out
}

/** The concatenated text, the reasoning blocks, and the terminal event of a stream. */
function fold(events: readonly ChatEvent[]) {
  let text = ''
  const reasoning = new Map<string, { text: string; providerMeta?: unknown }>()
  let usage: Record<string, number | undefined> | undefined
  for (const e of events) {
    if (e.type === 'text-delta') text += e.text
    else if (e.type === 'reasoning-delta') {
      const block = reasoning.get(e.id) ?? { text: '' }
      block.text += e.text
      reasoning.set(e.id, block)
    } else if (e.type === 'reasoning-end') {
      const block = reasoning.get(e.id) ?? { text: '' }
      if (e.providerMeta !== undefined) block.providerMeta = e.providerMeta
      reasoning.set(e.id, block)
    } else if (e.type === 'usage') usage = { ...e.usage }
  }
  const terminal = events.filter((e) => e.type === 'finish' || e.type === 'error')
  return { text, reasoning: [...reasoning.values()], usage, terminal }
}

describe('recorded streams', () => {
  test.each(fixtures)('%s', async (file, meta) => {
    const served = await fixture(file)
    const adapter = A.createAdapter(meta.provider, { fetch: served.fetch })
    const events = await collect(adapter.stream(chatRequest(meta.provider, meta.model)))
    const got = fold(events)
    expect(got.text).toBe(meta.expect.text)
    expect(got.reasoning).toEqual(meta.expect.reasoning)
    expect(got.terminal).toHaveLength(1)
    const last = got.terminal[0] as ChatEvent
    expect(events.at(-1)).toBe(last)
    if (meta.expect.error) {
      if (last.type !== 'error') throw new Error(`expected an error, got ${last.type}`)
      expect(last.error.code).toBe(meta.expect.error.code as never)
      expect(last.error.retryable).toBe(meta.expect.error.retryable)
      if (meta.expect.error.status !== undefined) expect(last.error.status).toBe(meta.expect.error.status)
      if (meta.expect.error.message !== undefined) expect(last.error.message).toBe(meta.expect.error.message)
      expect(last.error.message).not.toContain(KEY)
    } else {
      if (last.type !== 'finish') throw new Error(`expected a finish, got ${last.type}`)
      expect(last.stop).toBe(meta.expect.stop as never)
      expect(last.raw).toBe(meta.expect.raw as string)
      if (meta.expect.refusal) expect(last.refusal).toEqual(meta.expect.refusal)
      else expect(last.refusal).toBeUndefined()
      expect(got.usage).toMatchObject(meta.expect.usage ?? {})
    }
  })
})

describe('Anthropic requests', () => {
  test('Opus 5.5: explicit effort, summarized adaptive thinking, no sampling, default fallback, streaming', async () => {
    const served = await fixture('anthropic-text.sse')
    const adapter = A.createAdapter('anthropic', { fetch: served.fetch })
    await collect(adapter.stream(chatRequest('anthropic', 'claude-opus-5-5', { system: 'Be brief.', effort: 'xhigh' })))
    expect(served.calls).toHaveLength(1)
    const call = served.calls[0] as Call
    expect(call.url).toBe('https://api.anthropic.com/v1/messages')
    expect(call.method).toBe('POST')
    const body = call.body as Record<string, unknown>
    expect(body.model).toBe('claude-opus-5-5')
    expect(body.stream).toBe(true)
    expect(body.max_tokens).toBe(128_000)
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body.output_config).toEqual({ effort: 'xhigh' })
    expect(JSON.stringify(body.system)).toContain('Be brief.')
    for (const key of ['temperature', 'top_p', 'top_k', 'tool_choice']) expect(key in body).toBe(false)
    expect(body.fallbacks).toBe('default')
    expect(call.headers['anthropic-beta']?.split(',')).toContain('server-side-fallback-2026-07-01')
  })

  test('noFallback leaves the fallback out', async () => {
    const served = await fixture('anthropic-text.sse')
    const adapter = A.createAdapter('anthropic', { fetch: served.fetch })
    await collect(adapter.stream(chatRequest('anthropic', 'claude-opus-5-5', { effort: 'low', noFallback: true })))
    const body = served.calls[0]?.body as Record<string, unknown>
    expect('fallbacks' in body).toBe(false)
  })

  test('a thinking block is replayed byte for byte, with its signature, before the text of its turn', async () => {
    const first = await fixture('anthropic-thinking.sse')
    const events = await collect(
      A.createAdapter('anthropic', { fetch: first.fetch }).stream(
        chatRequest('anthropic', 'claude-opus-5-5', { effort: 'high', messages: [user('Is 1009 prime?')] }),
      ),
    )
    const { text, reasoning } = fold(events)
    const block = reasoning[0] as { text: string; providerMeta: Record<string, unknown> }
    const second = await fixture('anthropic-text.sse')
    await collect(
      A.createAdapter('anthropic', { fetch: second.fetch }).stream(
        chatRequest('anthropic', 'claude-opus-5-5', {
          effort: 'high',
          messages: [
            user('Is 1009 prime?'),
            {
              role: 'assistant',
              parts: [
                { type: 'reasoning', text: block.text, providerMeta: block.providerMeta },
                { type: 'text', text },
              ],
            },
            user('And 1013?'),
          ],
        }),
      ),
    )
    const messages = ((second.calls[0] as Call).body as { messages: { role: string; content: unknown[] }[] }).messages
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    const expectedSignature = (block.providerMeta.anthropic as { signature: string }).signature
    expect(messages[1]?.content[0]).toEqual({ type: 'thinking', thinking: block.text, signature: expectedSignature })
    expect(messages[1]?.content[1]).toMatchObject({ type: 'text', text })
  })

  test('a redacted thinking block is replayed as redacted_thinking with its data', async () => {
    const served = await fixture('anthropic-text.sse')
    const data = 'HYdtzxCxjCauU1Wp4Qh6/UdapOApeVg8XLvmB0WA6+kGbL5DMbmNVq4hfnwy0cpEtUc9'
    await collect(
      A.createAdapter('anthropic', { fetch: served.fetch }).stream(
        chatRequest('anthropic', 'claude-opus-5-5', {
          effort: 'high',
          messages: [
            user('One'),
            {
              role: 'assistant',
              parts: [
                { type: 'reasoning', text: '', providerMeta: { anthropic: { type: 'redacted_thinking', data } } },
                { type: 'text', text: 'Two' },
              ],
            },
            user('Three'),
          ],
        }),
      ),
    )
    const messages = ((served.calls[0] as Call).body as { messages: { content: unknown[] }[] }).messages
    expect(messages[1]?.content[0]).toEqual({ type: 'redacted_thinking', data })
  })

  test('reasoning without an anthropic entry is not sent', async () => {
    const served = await fixture('anthropic-text.sse')
    await collect(
      A.createAdapter('anthropic', { fetch: served.fetch }).stream(
        chatRequest('anthropic', 'claude-opus-5-5', {
          effort: 'high',
          messages: [
            user('One'),
            {
              role: 'assistant',
              parts: [
                { type: 'reasoning', text: 'from another provider', providerMeta: { openai: { id: 'rs_1' } } },
                { type: 'reasoning', text: 'display only' },
                { type: 'text', text: 'Two' },
              ],
            },
            user('Three'),
          ],
        }),
      ),
    )
    const body = JSON.stringify(served.calls[0]?.body)
    expect(body).not.toContain('from another provider')
    expect(body).not.toContain('display only')
    expect(body).not.toContain('rs_1')
  })

  test('a system message after the first turn is a mid-conversation system message; the top-level system stays', async () => {
    const midConversation: PromptMessage[] = [
      user('Hi'),
      { role: 'assistant', parts: [{ type: 'text', text: 'Hello.' }] },
      { role: 'system', parts: [{ type: 'text', text: 'Answer in French from now on.' }] },
      user('How are you?'),
    ]
    for (const system of ['Be brief.', '']) {
      const served = await fixture('anthropic-text.sse')
      await collect(
        A.createAdapter('anthropic', { fetch: served.fetch }).stream(
          chatRequest('anthropic', 'claude-opus-5-5', { effort: 'high', system, messages: midConversation }),
        ),
      )
      const body = served.calls[0]?.body as { system?: unknown; messages: { role: string; content: unknown }[] }
      expect(body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'system', 'user'])
      expect(JSON.stringify(body.messages[2]?.content)).toContain('Answer in French from now on.')
      if (system === '') expect('system' in body).toBe(false)
      else expect(JSON.stringify(body.system)).not.toContain('French')
    }
  })

  test('sampling is sent where the model allows it', async () => {
    const served = await fixture('anthropic-text.sse')
    await collect(
      A.createAdapter('anthropic', { fetch: served.fetch }).stream(
        chatRequest('anthropic', 'claude-sonnet-4-6', { effort: 'high', sampling: { temperature: 0.3 } }),
      ),
    )
    expect(((served.calls[0] as Call).body as Record<string, unknown>).temperature).toBe(0.3)
  })

  test('the direct-browser header goes to Anthropic only, never to another host speaking its protocol', async () => {
    const own = await fixture('anthropic-text.sse')
    await collect(
      A.createAdapter('anthropic', { fetch: own.fetch }).stream(chatRequest('anthropic', 'claude-opus-5-5')),
    )
    expect(own.calls[0]?.headers['anthropic-dangerous-direct-browser-access']).toBe('true')
    const other = await fixture('anthropic-text.sse')
    const proxy: ProviderConfig = { ...(PROVIDERS.anthropic as ProviderConfig), baseUrl: 'https://llm.example.org/v1' }
    await collect(
      A.createAdapter('anthropic', { fetch: other.fetch }).stream(
        chatRequest('anthropic', 'claude-opus-5-5', { provider: proxy }),
      ),
    )
    expect(other.calls[0]?.url).toBe('https://llm.example.org/v1/messages')
    expect('anthropic-dangerous-direct-browser-access' in (other.calls[0]?.headers ?? {})).toBe(false)
  })
})

describe('refused before any network call', () => {
  const cases: [string, Partial<ChatRequest>][] = [
    ['a sampling parameter the model refuses', { effort: 'high', sampling: { temperature: 0.5 } }],
    ['an effort the model does not take', { effort: 'none' }],
    ['a forced tool choice', { effort: 'high', tools: [SEARCH], toolChoice: { tool: 'search' } }],
    ['a required tool choice', { effort: 'high', tools: [SEARCH], toolChoice: 'required' }],
    [
      'an assistant message last (prefill)',
      { effort: 'high', messages: [user('Hi'), { role: 'assistant', parts: [{ type: 'text', text: 'Sure' }] }] },
    ],
    ['no message', { effort: 'high', messages: [] }],
  ]
  test.each(cases)('%s', async (_, over) => {
    const served = await fixture('anthropic-text.sse')
    const adapter = A.createAdapter('anthropic', { fetch: served.fetch })
    await expect(collect(adapter.stream(chatRequest('anthropic', 'claude-opus-5-5', over)))).rejects.toBeInstanceOf(
      InvalidInputError,
    )
    expect(served.calls).toHaveLength(0)
  })

  test('a kind this build cannot call', () => {
    expect(() => A.createAdapter('webllm')).toThrow(InvalidInputError)
  })
})

describe('OpenAI-compatible and Gemini requests', () => {
  test('chat completions at the base URL, with the usage chunk requested and no effort for an undocumented model', async () => {
    const served = await fixture('openai-compatible-reasoning.sse')
    await collect(
      A.createAdapter('openai-compatible', { fetch: served.fetch }).stream(
        chatRequest('openai-compatible', 'deepseek-reasoner'),
      ),
    )
    const call = served.calls[0] as Call
    expect(call.url).toBe('https://api.groq.com/openai/v1/chat/completions')
    expect(call.headers.authorization).toBe(`Bearer ${KEY}`)
    const body = call.body as Record<string, unknown>
    expect(body.model).toBe('deepseek-reasoner')
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    expect('reasoning_effort' in body).toBe(false)
  })

  test('Gemini streams over SSE with the key in a header', async () => {
    const served = await fixture('gemini-text.sse')
    await collect(A.createAdapter('google', { fetch: served.fetch }).stream(chatRequest('google', 'gemini-3-flash')))
    const call = served.calls[0] as Call
    expect(call.url).toContain('https://generativelanguage.googleapis.com/')
    expect(call.url).toContain('gemini-3-flash:streamGenerateContent')
    expect(call.url).toContain('alt=sse')
    expect(call.headers['x-goog-api-key']).toBe(KEY)
  })
})

describe('headers and keys', () => {
  const allowed: Record<string, readonly string[]> = {
    anthropic: [
      'x-api-key',
      'anthropic-version',
      'anthropic-beta',
      'anthropic-dangerous-direct-browser-access',
      'content-type',
      'accept',
    ],
    'openai-compatible': ['authorization', 'content-type', 'accept'],
    google: ['x-goog-api-key', 'content-type', 'accept'],
  }
  test.each(fixtures)(
    '%s sends only headers a preflight can allow, and never the key in the URL',
    async (file, meta) => {
      const served = await fixture(file)
      await collect(
        A.createAdapter(meta.provider, { fetch: served.fetch }).stream(chatRequest(meta.provider, meta.model)),
      )
      for (const call of served.calls) {
        for (const name of Object.keys(call.headers)) expect(allowed[meta.provider]).toContain(name)
        expect(call.url).not.toContain(KEY)
      }
    },
  )
})

describe('failures and stops', () => {
  test('HTTP statuses map to error codes', async () => {
    const cases: [number, string, string, boolean][] = [
      [429, '{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}', 'rate-limit', true],
      [529, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'overloaded', true],
      [500, '{"type":"error","error":{"type":"api_error","message":"Internal"}}', 'server', true],
      [
        400,
        '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1200000 tokens > 1000000 maximum"}}',
        'context-length',
        false,
      ],
      [400, '{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}', 'invalid-request', false],
      [404, '{"type":"error","error":{"type":"not_found_error","message":"model: nope"}}', 'not-found', false],
    ]
    for (const [status, body, code, retryable] of cases) {
      const served = serve(body, status, 'application/json')
      const events = await collect(
        A.createAdapter('anthropic', { fetch: served.fetch }).stream(chatRequest('anthropic', 'claude-opus-5-5')),
      )
      const last = events.at(-1)
      if (last?.type !== 'error') throw new Error(`status ${status}: expected an error event`)
      expect([status, last.error.code, last.error.retryable]).toEqual([status, code as never, retryable])
    }
  })

  test('a fetch that fails without an answer is "key refused or network"', async () => {
    const failing: FetchLike = async () => {
      throw new TypeError('Failed to fetch')
    }
    const events = await collect(
      A.createAdapter('openai-compatible', { fetch: failing }).stream(chatRequest('openai-compatible', 'any')),
    )
    const last = events.at(-1)
    if (last?.type !== 'error') throw new Error('expected an error event')
    expect(last.error.code).toBe('auth-or-network')
  })

  test('a stream that ends without a finish is truncated', async () => {
    const whole = await Bun.file(new URL('anthropic-text.sse', SSE)).text()
    const cut = whole.slice(0, whole.indexOf('event: message_delta'))
    const served = serve(cut)
    const events = await collect(
      A.createAdapter('anthropic', { fetch: served.fetch }).stream(chatRequest('anthropic', 'claude-opus-5-5')),
    )
    const last = events.at(-1)
    if (last?.type !== 'error') throw new Error('expected an error event')
    expect(last.error.code).toBe('truncated')
  })

  test('aborting ends the iteration with neither finish nor error', async () => {
    const whole = await Bun.file(new URL('anthropic-text.sse', SSE)).text()
    const head = whole.slice(0, whole.indexOf('event: content_block_stop'))
    const served = serve(
      () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(head))
          },
        }),
    )
    const abort = new AbortController()
    const events: ChatEvent[] = []
    const adapter: ChatAdapter = A.createAdapter('anthropic', { fetch: served.fetch })
    for await (const e of adapter.stream(chatRequest('anthropic', 'claude-opus-5-5', { signal: abort.signal }))) {
      events.push(e)
      if (e.type === 'text-delta') abort.abort()
    }
    expect(events.some((e) => e.type === 'text-delta')).toBe(true)
    expect(events.some((e) => e.type === 'finish' || e.type === 'error')).toBe(false)
  })
})

describe('connection test', () => {
  test('lists the models with a GET and never generates', async () => {
    const served = serve(
      '{"object":"list","data":[{"id":"llama-3.3-70b-versatile"},{"id":"qwen-3"}]}',
      200,
      'application/json',
    )
    const result = await A.testConnection(PROVIDERS['openai-compatible'] as ProviderConfig, KEY, {
      fetch: served.fetch,
    })
    expect(result).toEqual({ ok: true, models: ['llama-3.3-70b-versatile', 'qwen-3'] })
    expect(served.calls.every((c) => c.method === 'GET')).toBe(true)
    expect(served.calls[0]?.url).toBe('https://api.groq.com/openai/v1/models')
  })

  test('a refused key and an unreadable failure are told apart', async () => {
    const refused = serve('{"error":{"message":"Invalid API Key"}}', 401, 'application/json')
    expect(
      await A.testConnection(PROVIDERS['openai-compatible'] as ProviderConfig, KEY, { fetch: refused.fetch }),
    ).toEqual({
      ok: false,
      reason: 'auth',
      status: 401,
    })
    const failing: FetchLike = async () => {
      throw new TypeError('Failed to fetch')
    }
    const result = await A.testConnection(PROVIDERS['openai-compatible'] as ProviderConfig, KEY, { fetch: failing })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('auth-or-network')
  })
})

describe('the default fetch is the network wrapper', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
    resetNetworkLog()
  })

  function stubGlobalFetch(body: string) {
    const seen: { url: string; init: RequestInit | undefined }[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init })
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    return seen
  }

  test('providerFetch is request() with purpose provider: logged, no credentials, no referrer', async () => {
    const seen = stubGlobalFetch('')
    await F.providerFetch('https://api.anthropic.com/v1/messages', { method: 'POST', body: '{}' })
    expect(seen[0]?.init?.credentials).toBe('omit')
    expect(seen[0]?.init?.referrerPolicy).toBe('no-referrer')
    expect(networkLog.snapshot().map((e) => [e.origin, e.purpose])).toEqual([['https://api.anthropic.com', 'provider']])
    await expect(F.providerFetch('http://api.example.org/v1/chat/completions', {})).rejects.toBeInstanceOf(TypeError)
  })

  test('an adapter created without a fetch goes through it', async () => {
    const seen = stubGlobalFetch(await Bun.file(new URL('anthropic-text.sse', SSE)).text())
    await collect(A.createAdapter('anthropic').stream(chatRequest('anthropic', 'claude-opus-5-5')))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.init?.credentials).toBe('omit')
    expect(networkLog.snapshot().map((e) => e.purpose)).toEqual(['provider'])
  })
})
