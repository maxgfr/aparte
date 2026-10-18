/*
 * Provider calls for voice and images (MediaApiModule in web/src/core/contracts/media.ts), over the AI SDK's
 * `transcribe`, `generateSpeech` and `generateImage`. Every model is created with `guardedFetch` over `providerFetch`
 * (or a test's fake), so only the provider's own headers leave, exactly as for a chat answer. The packages are loaded on
 * first use, in their own chunks.
 *
 * What each provider offers here:
 * - images: OpenAI (`gpt-image-*`, `dall-e-*`, `chatgpt-image-*`), Gemini (`gemini-*-image*`, `nano-banana`), and
 *   OpenAI-compatible servers whose model id names an image model (xAI's `grok-*-image*`, `*-imagine-*`...);
 * - transcription and speech: OpenAI, and OpenAI-compatible servers (Groq's Whisper, or any server that serves
 *   `/audio/transcriptions` and `/audio/speech`; the user names the model).
 */
import type { FetchLike } from '../contracts/ai.ts'
import { InvalidInputError } from '../contracts/crypto.ts'
import { type GeneratedImage, MediaError, type MediaTarget, type SpokenAudio } from '../contracts/media.ts'
import { baseUrlProblem } from './endpoints.ts'
import { describeError } from './errors.ts'
import { providerFetch } from './fetch.ts'
import { baseUrlOf, guardedFetch, SDK_KEY } from './providers.ts'

export { isImageModel, mediaOffer, OPENAI_VOICES } from './mediaOffer.ts'

/** Text sent to a speech API at most in one call (OpenAI's limit is 4096 characters). */
export const MAX_SPEECH_CHARS = 4096

export interface MediaDeps {
  /** Defaults to `providerFetch`. */
  readonly fetch?: FetchLike
}

function check(target: MediaTarget, needs: 'image' | 'audio'): void {
  const { provider } = target
  const callable = needs === 'image' ? ['openai', 'google', 'openai-compatible'] : ['openai', 'openai-compatible']
  if (!callable.includes(provider.kind))
    throw new InvalidInputError(`The ${provider.kind} provider has no ${needs} API here`)
  if (target.apiKey === null && provider.kind !== 'openai-compatible') {
    throw new InvalidInputError(`The ${provider.kind} provider needs an API key`)
  }
  if (baseUrlProblem(baseUrlOf(provider)) !== null) {
    throw new InvalidInputError('The base URL must be https, or http on this machine')
  }
  if (target.modelId.trim() === '') throw new InvalidInputError('A model id is needed')
}

/**
 * A keyless server (a local one) gets no `Authorization` at all: OpenAI's package insists on a key, so it is handed an
 * empty one, whose empty bearer is dropped here.
 */
function withoutEmptyBearer(base: FetchLike): FetchLike {
  return (input, init) => {
    const headers = new Headers(init?.headers)
    if (/^Bearer\s*$/i.test(headers.get('authorization') ?? 'x')) headers.delete('authorization')
    return base(input, { ...init, headers })
  }
}

/** The provider's request options, shared by the three calls. */
function settings(target: MediaTarget, deps: MediaDeps) {
  const guarded = guardedFetch(target.provider.kind, withoutEmptyBearer(deps.fetch ?? providerFetch))
  return {
    apiKey: target.apiKey ?? '',
    baseURL: baseUrlOf(target.provider),
    // The packages type `fetch` as the global one, static members included; they only ever call it.
    fetch: guarded as typeof globalThis.fetch,
  }
}

/** Runs a provider call; any failure but an abort becomes a MediaError with the chat's error codes. */
async function call<T>(target: MediaTarget, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (target.signal?.aborted) throw target.signal.reason ?? new DOMException('Aborted', 'AbortError')
    // The AI SDK wraps the HTTP failure of the last attempt; its cause carries the status.
    const inner = (error as { lastError?: unknown } | null)?.lastError ?? error
    throw new MediaError(describeError(inner, target.apiKey))
  }
}

export async function transcribe(
  target: MediaTarget,
  audio: { readonly bytes: Uint8Array; readonly mediaType: string },
  deps: MediaDeps = {},
): Promise<string> {
  check(target, 'audio')
  const [{ transcribe: run }, { createOpenAI }] = await Promise.all([import('ai'), import('@ai-sdk/openai')])
  const model = createOpenAI(settings(target, deps)).transcription(target.modelId)
  const result = await call(target, () =>
    run({
      model,
      audio: new Uint8Array(audio.bytes),
      maxRetries: 0,
      ...(target.signal === undefined ? {} : { abortSignal: target.signal }),
    }),
  )
  return result.text.trim()
}

export async function speak(
  target: MediaTarget,
  input: { readonly text: string; readonly voice: string },
  deps: MediaDeps = {},
): Promise<SpokenAudio> {
  check(target, 'audio')
  const text = input.text.trim().slice(0, MAX_SPEECH_CHARS)
  if (text === '') throw new InvalidInputError('Nothing to read aloud')
  const [{ generateSpeech }, { createOpenAI }] = await Promise.all([import('ai'), import('@ai-sdk/openai')])
  const model = createOpenAI(settings(target, deps)).speech(target.modelId)
  const result = await call(target, () =>
    generateSpeech({
      model,
      text,
      voice: input.voice.trim() || 'alloy',
      outputFormat: 'mp3',
      maxRetries: 0,
      ...(target.signal === undefined ? {} : { abortSignal: target.signal }),
    }),
  )
  return { bytes: new Uint8Array(result.audio.uint8Array), mediaType: result.audio.mediaType || 'audio/mpeg' }
}

export async function generateImage(
  target: MediaTarget,
  prompt: string,
  deps: MediaDeps = {},
): Promise<GeneratedImage> {
  check(target, 'image')
  const text = prompt.trim()
  if (text === '') throw new InvalidInputError('An image needs a prompt')
  const { generateImage: run } = await import('ai')
  const options = settings(target, deps)
  const { kind } = target.provider
  let model: Parameters<typeof run>[0]['model']
  if (kind === 'openai') {
    const { createOpenAI } = await import('@ai-sdk/openai')
    model = createOpenAI(options).image(target.modelId)
  } else if (kind === 'google') {
    const { createGoogle } = await import('@ai-sdk/google')
    model = createGoogle(options).image(target.modelId)
  } else {
    const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible')
    model = createOpenAICompatible({ ...options, name: SDK_KEY['openai-compatible'] as string }).imageModel(
      target.modelId,
    )
  }
  const result = await call(target, () =>
    run({
      model,
      prompt: text,
      n: 1,
      maxRetries: 0,
      ...(target.signal === undefined ? {} : { abortSignal: target.signal }),
    }),
  )
  const image = result.images[0]
  if (image === undefined) {
    throw new MediaError({ code: 'unknown', message: 'The provider returned no image', retryable: true })
  }
  return { bytes: new Uint8Array(image.uint8Array), mediaType: image.mediaType || 'image/png' }
}
