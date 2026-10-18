/*
 * What each provider offers for voice and images (MediaApiModule `mediaOffer` and `isImageModel`), by kind, preset and
 * the model ids it lists. Pure and without the AI SDK, so the interface reads it without loading a provider package.
 */
import type { ProviderConfig, ProviderKind } from '../contracts/ai.ts'
import type { MediaOffer } from '../contracts/media.ts'

/** Image model ids per kind, by the makers' naming. */
const IMAGE_MODEL: Readonly<Partial<Record<ProviderKind, RegExp>>> = {
  openai: /^(?:gpt-image-|dall-e-|chatgpt-image-)/,
  google: /^(?:gemini-.*-image(?:-|$)|gemini-nano-banana)/,
  'openai-compatible': /(?:^|[-/])(?:image|imagine|flux|sdxl|stable-diffusion)(?:[-.]|$)|-image-|^dall-e-|^gpt-image-/,
}

/** The image model a kind starts with when its list names none. */
const DEFAULT_IMAGE: Readonly<Partial<Record<ProviderKind, string>>> = {
  openai: 'gpt-image-1',
  google: 'gemini-2.5-flash-image',
}

/** OpenAI-compatible presets with a documented image model. */
const PRESET_IMAGE: Readonly<Record<string, string>> = { xai: 'grok-2-image-1212' }

/** Transcription models by kind or preset; a custom OpenAI-compatible server is assumed to be a Whisper server. */
const TRANSCRIPTION: Readonly<Record<string, string>> = {
  openai: 'gpt-4o-mini-transcribe',
  groq: 'whisper-large-v3-turbo',
  custom: 'whisper-1',
}

/** Speech models by kind or preset. */
const SPEECH: Readonly<Record<string, string>> = { openai: 'gpt-4o-mini-tts', custom: 'tts-1' }

/** OpenAI's voices; a server of another maker may name its own (the user types it). */
export const OPENAI_VOICES: readonly string[] = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
]

export function isImageModel(kind: ProviderKind, modelId: string): boolean {
  return IMAGE_MODEL[kind]?.test(modelId.toLowerCase()) ?? false
}

/** The key under which `transcription` and `speech` are looked up: the kind, or the preset of a compatible server. */
function presetOf(provider: ProviderConfig): string | null {
  if (provider.kind === 'openai') return 'openai'
  if (provider.kind !== 'openai-compatible') return null
  return provider.preset ?? 'custom'
}

export function mediaOffer(provider: ProviderConfig): MediaOffer {
  const listed = (provider.models ?? []).filter((id) => isImageModel(provider.kind, id))
  const fallback =
    DEFAULT_IMAGE[provider.kind] ??
    (provider.kind === 'openai-compatible' && provider.preset !== undefined ? PRESET_IMAGE[provider.preset] : undefined)
  const imageModels = listed.length > 0 ? listed : fallback === undefined ? [] : [fallback]
  const preset = presetOf(provider)
  return {
    imageModels,
    transcription: preset === null ? null : (TRANSCRIPTION[preset] ?? TRANSCRIPTION.custom ?? null),
    speech: preset === null ? null : (SPEECH[preset] ?? SPEECH.custom ?? null),
  }
}
