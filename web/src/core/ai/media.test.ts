/*
 * Voice and image provider calls (MediaApiModule in web/src/core/contracts/media.ts) against a fake fetch: what each
 * provider offers, the endpoint and headers of each call (the provider's own only, no AI SDK user-agent, no empty
 * bearer for a keyless server), the bytes that come back, and provider failures as MediaError with the chat's codes.
 */
import { describe, expect, test } from 'bun:test'
import type { FetchLike, ProviderConfig } from '../contracts/ai.ts'
import { InvalidInputError } from '../contracts/crypto.ts'
import { type MediaApiModule, MediaError } from '../contracts/media.ts'
import * as mediaImpl from './media.ts'

const M: MediaApiModule = mediaImpl
const KEY = 'sk-test-media-0123456789'

function provider(kind: ProviderConfig['kind'], extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: `p-${kind}`, kind, label: kind, syncKey: false, createdAt: 0, updatedAt: 0, ...extra }
}

interface Seen {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: BodyInit | null | undefined
}

function fakeFetch(respond: (url: string) => Response): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = []
  const fetch: FetchLike = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v
    })
    seen.push({ url, method: init?.method ?? 'GET', headers, body: init?.body })
    return respond(url)
  }
  return { fetch, seen }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')

function onlyOwnHeaders(seen: Seen, allowed: readonly string[]): void {
  for (const name of Object.keys(seen.headers)) expect([...allowed, 'content-type', 'accept']).toContain(name)
}

describe('what a provider offers', () => {
  test('image models by the makers naming, then the kind default', () => {
    expect(M.mediaOffer(provider('openai')).imageModels).toEqual(['gpt-image-1'])
    expect(M.mediaOffer(provider('openai', { models: ['gpt-5', 'dall-e-3', 'gpt-image-1.5'] })).imageModels).toEqual([
      'dall-e-3',
      'gpt-image-1.5',
    ])
    expect(M.mediaOffer(provider('google')).imageModels).toEqual(['gemini-2.5-flash-image'])
    expect(
      M.mediaOffer(provider('google', { models: ['gemini-3-flash', 'gemini-3-pro-image-preview'] })).imageModels,
    ).toEqual(['gemini-3-pro-image-preview'])
    expect(M.mediaOffer(provider('openai-compatible', { preset: 'xai' })).imageModels).toEqual(['grok-2-image-1212'])
    expect(
      M.mediaOffer(provider('openai-compatible', { preset: 'xai', models: ['grok-4', 'grok-imagine-image'] }))
        .imageModels,
    ).toEqual(['grok-imagine-image'])
    expect(M.mediaOffer(provider('openai-compatible', { preset: 'groq' })).imageModels).toEqual([])
    expect(M.mediaOffer(provider('anthropic')).imageModels).toEqual([])
    expect(M.isImageModel('openai', 'gpt-5')).toBe(false)
    expect(M.isImageModel('google', 'gemini-2.5-flash')).toBe(false)
  })

  test('transcription and speech on OpenAI and OpenAI-compatible servers only', () => {
    expect(M.mediaOffer(provider('openai'))).toMatchObject({
      transcription: 'gpt-4o-mini-transcribe',
      speech: 'gpt-4o-mini-tts',
    })
    expect(M.mediaOffer(provider('openai-compatible', { preset: 'groq' })).transcription).toBe('whisper-large-v3-turbo')
    expect(M.mediaOffer(provider('openai-compatible', { preset: 'custom' }))).toMatchObject({
      transcription: 'whisper-1',
      speech: 'tts-1',
    })
    expect(M.mediaOffer(provider('anthropic'))).toMatchObject({ transcription: null, speech: null })
    expect(M.mediaOffer(provider('google'))).toMatchObject({ transcription: null, speech: null })
  })
})

describe('image generation', () => {
  test('OpenAI: images/generations with the bearer only, base64 back', async () => {
    const { fetch, seen } = fakeFetch(() => json({ created: 1, data: [{ b64_json: b64(PNG) }] }))
    const image = await mediaImpl.generateImage(
      { provider: provider('openai'), apiKey: KEY, modelId: 'gpt-image-1' },
      '  A red kite  ',
      { fetch },
    )
    expect([...image.bytes]).toEqual([...PNG])
    expect(image.mediaType).toBe('image/png')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://api.openai.com/v1/images/generations')
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${KEY}`)
    onlyOwnHeaders(seen[0] as Seen, ['authorization'])
    expect(JSON.parse(String(seen[0]?.body))).toMatchObject({ model: 'gpt-image-1', prompt: 'A red kite', n: 1 })
  })

  test('Gemini: generateContent asking for an image, its inline data back', async () => {
    const { fetch, seen } = fakeFetch(() =>
      json({
        candidates: [
          {
            content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: b64(PNG) } }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 1290, totalTokenCount: 1295 },
      }),
    )
    const image = await mediaImpl.generateImage(
      { provider: provider('google'), apiKey: KEY, modelId: 'gemini-2.5-flash-image' },
      'A red kite',
      { fetch },
    )
    expect([...image.bytes]).toEqual([...PNG])
    expect(seen[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
    )
    expect(seen[0]?.headers['x-goog-api-key']).toBe(KEY)
    onlyOwnHeaders(seen[0] as Seen, ['x-goog-api-key'])
    const body = JSON.parse(String(seen[0]?.body))
    expect(body.generationConfig.responseModalities).toEqual(['IMAGE'])
  })

  test('OpenAI-compatible: the server named by the user', async () => {
    const { fetch, seen } = fakeFetch(() => json({ data: [{ b64_json: b64(PNG) }] }))
    await mediaImpl.generateImage(
      {
        provider: provider('openai-compatible', { preset: 'xai', baseUrl: 'https://api.x.ai/v1' }),
        apiKey: KEY,
        modelId: 'grok-2-image-1212',
      },
      'A kite',
      { fetch },
    )
    expect(seen[0]?.url).toBe('https://api.x.ai/v1/images/generations')
    onlyOwnHeaders(seen[0] as Seen, ['authorization'])
  })

  test('a provider failure is a MediaError with the chat codes; an empty answer too', async () => {
    const refused = fakeFetch(() =>
      json({ error: { message: 'Incorrect API key', type: 'invalid_request_error' } }, 401),
    )
    const err = await mediaImpl
      .generateImage({ provider: provider('openai'), apiKey: KEY, modelId: 'gpt-image-1' }, 'x', {
        fetch: refused.fetch,
      })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MediaError)
    expect((err as MediaError).error.code).toBe('auth')
    expect((err as MediaError).error.message).not.toContain(KEY)
    const empty = fakeFetch(() => json({ data: [] }))
    await expect(
      mediaImpl.generateImage({ provider: provider('openai'), apiKey: KEY, modelId: 'gpt-image-1' }, 'x', {
        fetch: empty.fetch,
      }),
    ).rejects.toBeInstanceOf(MediaError)
  })

  test('refuses before any call what cannot be sent', async () => {
    const { fetch, seen } = fakeFetch(() => json({}))
    const target = { provider: provider('openai'), apiKey: KEY, modelId: 'gpt-image-1' }
    await expect(mediaImpl.generateImage(target, '   ', { fetch })).rejects.toBeInstanceOf(InvalidInputError)
    await expect(
      mediaImpl.generateImage({ ...target, provider: provider('anthropic') }, 'x', { fetch }),
    ).rejects.toBeInstanceOf(InvalidInputError)
    await expect(mediaImpl.generateImage({ ...target, apiKey: null }, 'x', { fetch })).rejects.toBeInstanceOf(
      InvalidInputError,
    )
    await expect(
      mediaImpl.generateImage(
        { ...target, provider: provider('openai-compatible', { baseUrl: 'http://example.org/v1' }) },
        'x',
        { fetch },
      ),
    ).rejects.toBeInstanceOf(InvalidInputError)
    expect(seen).toHaveLength(0)
  })
})

describe('transcription and speech', () => {
  const local = provider('openai-compatible', { preset: 'custom', baseUrl: 'http://127.0.0.1:8080/v1' })

  test('transcribes over multipart, with no authorization for a keyless server', async () => {
    const { fetch, seen } = fakeFetch(() => json({ text: ' Hello there. ' }))
    const wav = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])
    const text = await mediaImpl.transcribe(
      { provider: local, apiKey: null, modelId: 'whisper-1' },
      { bytes: wav, mediaType: 'audio/wav' },
      { fetch },
    )
    expect(text).toBe('Hello there.')
    expect(seen[0]?.url).toBe('http://127.0.0.1:8080/v1/audio/transcriptions')
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.headers.authorization).toBeUndefined()
    expect(seen[0]?.body).toBeInstanceOf(FormData)
    const form = seen[0]?.body as FormData
    expect(form.get('model')).toBe('whisper-1')
    expect(form.get('file')).toBeInstanceOf(Blob)
  })

  test('speaks with the chosen voice and returns the audio', async () => {
    const mp3 = Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0])
    const { fetch, seen } = fakeFetch(() => new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } }))
    const audio = await mediaImpl.speak(
      { provider: provider('openai'), apiKey: KEY, modelId: 'gpt-4o-mini-tts' },
      { text: '  Read me.  ', voice: 'coral' },
      { fetch },
    )
    expect([...audio.bytes]).toEqual([...mp3])
    expect(seen[0]?.url).toBe('https://api.openai.com/v1/audio/speech')
    onlyOwnHeaders(seen[0] as Seen, ['authorization'])
    expect(JSON.parse(String(seen[0]?.body))).toMatchObject({
      model: 'gpt-4o-mini-tts',
      input: 'Read me.',
      voice: 'coral',
    })
  })

  test('refuses providers without the APIs, and empty text', async () => {
    const { fetch, seen } = fakeFetch(() => json({}))
    await expect(
      mediaImpl.transcribe(
        { provider: provider('google'), apiKey: KEY, modelId: 'x' },
        { bytes: new Uint8Array(1), mediaType: 'audio/wav' },
        { fetch },
      ),
    ).rejects.toBeInstanceOf(InvalidInputError)
    await expect(
      mediaImpl.speak(
        { provider: provider('openai'), apiKey: KEY, modelId: 'tts-1' },
        { text: '  ', voice: 'alloy' },
        { fetch },
      ),
    ).rejects.toBeInstanceOf(InvalidInputError)
    expect(seen).toHaveLength(0)
  })
})
