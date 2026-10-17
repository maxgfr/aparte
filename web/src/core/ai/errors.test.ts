/*
 * describeError: HTTP answers by status and provider type, stream error events by type, an opaque failure (a CORS
 * refusal hides a 401) as "key refused or network", and the API key never echoed back.
 */
import { describe, expect, test } from 'bun:test'
import { APICallError } from 'ai'
import type { ProviderConfig } from '../contracts/ai.ts'
import { testConnection } from './adapters.ts'
import { describeError } from './errors.ts'

const KEY = 'sk-secret-0123456789abcdef'

function http(status: number, body: string) {
  return new APICallError({
    message: 'call failed',
    url: 'https://api.example.org/v1/chat/completions',
    requestBodyValues: {},
    statusCode: status,
    responseBody: body,
    isRetryable: status >= 500,
  })
}

describe('describeError', () => {
  test('OpenAI-style bodies', () => {
    expect(
      describeError(http(401, '{"error":{"message":"Incorrect API key","type":"invalid_request_error"}}'), KEY),
    ).toEqual({ code: 'auth', message: 'Incorrect API key', status: 401, retryable: false })
    expect(
      describeError(http(400, '{"error":{"message":"too long","code":"context_length_exceeded"}}'), KEY).code,
    ).toBe('context-length')
    expect(describeError(http(429, '{"error":{"message":"quota","type":"insufficient_quota"}}'), KEY)).toMatchObject({
      code: 'rate-limit',
      retryable: true,
    })
    expect(describeError(http(503, ''), KEY)).toMatchObject({ code: 'overloaded', retryable: true })
  })

  test('Gemini-style bodies', () => {
    const body = '[{"error":{"code":400,"message":"API key not valid.","status":"INVALID_ARGUMENT"}}]'
    expect(describeError(http(400, body), KEY)).toMatchObject({ code: 'auth', message: 'API key not valid.' })
  })

  test('a fetch that rejects without an answer, directly or as a cause', () => {
    expect(describeError(new TypeError('Failed to fetch'), KEY).code).toBe('auth-or-network')
    expect(describeError(new TypeError('Load failed'), KEY)).toMatchObject({ code: 'auth-or-network', retryable: true })
    const wrapped = new Error('Cannot connect to API: Failed to fetch', { cause: new TypeError('Failed to fetch') })
    expect(describeError(wrapped, KEY).code).toBe('auth-or-network')
  })

  test('a stream error event by its type, without a made-up status', () => {
    const e = describeError({ type: 'overloaded_error', message: 'Overloaded', statusCode: 529, data: {} }, KEY)
    expect(e).toEqual({ code: 'overloaded', message: 'Overloaded', retryable: true })
  })

  test('the key is scrubbed and long messages cut', () => {
    const e = describeError(http(401, `{"error":{"message":"bad key ${KEY}"}}`), KEY)
    expect(e.message).not.toContain(KEY)
    expect(describeError(new Error('x'.repeat(2000)), KEY).message.length).toBeLessThanOrEqual(501)
  })
})

describe('testConnection', () => {
  const now = 1_760_000_000_000
  const base = { syncKey: false, createdAt: now, updatedAt: now } as const

  test('Gemini lists its models by name', async () => {
    const seen: string[] = []
    const result = await testConnection({ ...base, id: 'g', kind: 'google', label: 'Gemini' } as ProviderConfig, KEY, {
      fetch: async (input, init) => {
        seen.push(String(input), new Headers(init?.headers).get('x-goog-api-key') ?? '')
        return new Response('{"models":[{"name":"models/gemini-3-pro"},{"name":"models/gemini-3-flash"}]}')
      },
    })
    expect(result).toEqual({ ok: true, models: ['gemini-3-pro', 'gemini-3-flash'] })
    expect(seen).toEqual(['https://generativelanguage.googleapis.com/v1beta/models', KEY])
  })

  test('Anthropic behind another host gets no direct-browser header', async () => {
    let headers: Headers | undefined
    const provider = {
      ...base,
      id: 'a',
      kind: 'anthropic',
      label: 'Proxy',
      baseUrl: 'https://llm.example.org/v1',
    } as ProviderConfig
    await testConnection(provider, KEY, {
      fetch: async (_input, init) => {
        headers = new Headers(init?.headers)
        return new Response('{"data":[]}')
      },
    })
    expect(headers?.get('x-api-key')).toBe(KEY)
    expect(headers?.has('anthropic-dangerous-direct-browser-access')).toBe(false)
  })

  test('an insecure endpoint is refused without a call', async () => {
    let called = false
    const provider = {
      ...base,
      id: 'c',
      kind: 'openai-compatible',
      label: 'LAN',
      baseUrl: 'http://192.168.1.9:11434/v1',
    } as ProviderConfig
    const result = await testConnection(provider, null, {
      fetch: async () => {
        called = true
        return new Response('{}')
      },
    })
    expect(result).toEqual({ ok: false, reason: 'insecure' })
    expect(called).toBe(false)
  })
})
