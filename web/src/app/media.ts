/*
 * Dictation and reading aloud as the interface asks for them: the engine this device chose (app/prefs.ts), and for a
 * provider engine the model the vault's settings name (`transcriptionModel`, `speechModel`, `speechVoice`) with its
 * stored key. Provider calls go through core/ai/media.ts (and so through web/src/security/net.ts).
 */
import type { ProviderConfig } from '../core/contracts/ai.ts'
import type { DownloadProgress, MediaTarget } from '../core/contracts/media.ts'
import type { ModelRef } from '../core/contracts/workspace.ts'
import { encodeWav } from '../core/media/audio.ts'
import { speakableText } from '../core/media/speech.ts'
import type { ChatSession } from './chat.tsx'
import { readPref } from './prefs.ts'
import { localTranscriber, localVoices, pickLocalVoice, playSpeech, type Speaking, speakLocally } from './voice.ts'

/** Dictation or reading aloud through a provider needs one chosen in the Voice and media screen. */
export class NoProviderError extends Error {
  constructor() {
    super('No provider is chosen for this')
    this.name = 'NoProviderError'
  }
}

/** Reading aloud found no voice of this device for the text. */
export class NoVoiceError extends Error {
  constructor() {
    super('No local voice')
    this.name = 'NoVoiceError'
  }
}

/** The providers that offer `what`, with what each offers. */
export async function mediaProviders(
  session: ChatSession,
  what: 'transcription' | 'speech',
): Promise<readonly { readonly provider: ProviderConfig; readonly model: string }[]> {
  const { mediaOffer } = await import('../core/ai/mediaOffer.ts')
  const out: { provider: ProviderConfig; model: string }[] = []
  for (const provider of session.workspace.providers.list()) {
    const model = mediaOffer(provider)[what]
    if (model !== null) out.push({ provider, model })
  }
  return out
}

async function target(session: ChatSession, ref: ModelRef | null, signal?: AbortSignal): Promise<MediaTarget> {
  if (ref === null) throw new NoProviderError()
  const provider = session.workspace.providers.get(ref.provider)
  if (provider === undefined) throw new NoProviderError()
  const apiKey = await session.keys.get(provider.id)
  return { provider, apiKey, modelId: ref.id, ...(signal === undefined ? {} : { signal }) }
}

/** The text of a recording, with the engine this device chose (`local` or `api`; `browser` records on its own). */
export async function transcribeRecording(
  session: ChatSession,
  samples: Float32Array,
  options: { readonly signal?: AbortSignal; readonly onProgress?: (p: DownloadProgress) => void } = {},
): Promise<string> {
  if (readPref('dictation') === 'api') {
    const to = await target(session, session.workspace.settings.get('transcriptionModel'), options.signal)
    const wav = encodeWav(samples)
    try {
      const { transcribe } = await import('../core/ai/media.ts')
      return await transcribe(to, { bytes: wav, mediaType: 'audio/wav' })
    } finally {
      wav.fill(0)
    }
  }
  // On-device Whisper does not detect the language: it is told the device's (else it takes English).
  const language = speechLanguage()
  return localTranscriber().transcribe(samples, { ...options, ...(language === null ? {} : { language }) })
}

/** The device's language as Whisper names it (`fr` for `fr-CA`), or null. */
function speechLanguage(): string | null {
  const tag = typeof navigator === 'undefined' ? '' : (navigator.language ?? '')
  const base = tag.toLowerCase().split('-')[0] ?? ''
  return /^[a-z]{2,3}$/.test(base) ? base : null
}

/** The languages a text is most likely in, best first: the device's languages, then the interface's. */
function languages(): string[] {
  const device = typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? [])]
  const ui = typeof document === 'undefined' ? '' : document.documentElement.lang
  return [...device, ui].filter(Boolean)
}

/** Whether this device can read aloud on its own (it has at least one local voice). */
export function hasLocalVoice(): boolean {
  return localVoices().length > 0
}

/** Reads an answer aloud with the engine this device chose; NoVoiceError or NoProviderError when it cannot. */
export async function readAloud(session: ChatSession, markdown: string): Promise<Speaking> {
  const text = speakableText(markdown)
  if (readPref('readAloud') === 'api') {
    const to = await target(session, session.workspace.settings.get('speechModel'))
    const { speak } = await import('../core/ai/media.ts')
    const audio = await speak(to, { text, voice: session.workspace.settings.get('speechVoice') })
    try {
      return await playSpeech(audio.bytes)
    } finally {
      audio.bytes.fill(0)
    }
  }
  const voices = localVoices()
  for (const lang of languages()) {
    const voice = pickLocalVoice(lang, voices)
    if (voice !== null) return speakLocally(text, voice)
  }
  throw new NoVoiceError()
}
