/*
 * Contracts of voice and image generation (M8): dictation (speech to text) on this device or through a provider,
 * reading answers aloud (text to speech) with this device's own voices or through a provider, and images a provider
 * generates into a conversation. Implemented by web/src/core/ai/media.ts (provider calls and what each provider
 * offers), web/src/core/ai/local/transcribe.ts (on-device Whisper, the worker protocol) and
 * web/src/core/media/imageTurn.ts (an image turn of a conversation).
 *
 * Invariants:
 * - On-device first: dictation defaults to Whisper in this browser (a pinned, hash-checked model, downloaded on first
 *   use, never precached), reading aloud to the device's own voices. A provider is used only once the user chose one,
 *   and every provider call goes through `providerFetch` (web/src/security/net.ts) with the provider's own headers.
 * - The browser's built-in speech recognition (Chrome's Web Speech API) sends the audio to the browser maker's servers:
 *   it is off unless the user turns it on after a warning that says so.
 * - Reading aloud never uses a voice that is not `localService`: a remote voice would send the answer to the browser
 *   maker. Without a local voice, the device engine offers nothing.
 * - Recorded audio and generated speech live in memory only; nothing of either is stored. Generated images are stored
 *   as encrypted blobs, like photos, and only their prepared (re-encoded, metadata-free) bytes.
 * - An image turn holds the vault lock and the PWA reload while it runs, as a stream does, and commits its two
 *   messages (the user's prompt, then the assistant's images or its error) exactly once each.
 */

import type { ChatError, ProviderConfig, ProviderKind } from './ai.ts'
import type { Bytes, Rng } from './crypto.ts'
import type { Clock } from './vault.ts'
import type { BlobPort, Id, ModelRef, Workspace } from './workspace.ts'

// Dictation

/** Where dictation runs: Whisper in this browser, a provider's transcription API, or the browser's own service. */
export type DictationEngine = 'local' | 'api' | 'browser'

/** Where answers are read aloud: this device's own voices, or a provider's speech API. */
export type ReadAloudEngine = 'device' | 'api'

/** On-device transcription takes 16 kHz mono PCM, as Whisper does. */
export const SPEECH_SAMPLE_RATE = 16000

/** Dictation is cut at this length: a longer recording is transcribed up to here. */
export const MAX_DICTATION_SECONDS = 300

/** Model download progress of the on-device engine, in bytes. */
export interface DownloadProgress {
  readonly loaded: number
  readonly total: number
}

/** Speech to text on this device (Whisper in the transformers.js worker). */
export interface Transcriber {
  /**
   * The text of `audio` (16 kHz mono samples in [-1, 1]), in `language` (an ISO 639-1 code: on-device Whisper does not
   * detect the language; without one it takes English).
   */
  transcribe(
    audio: Float32Array,
    options?: {
      readonly signal?: AbortSignal
      readonly onProgress?: (p: DownloadProgress) => void
      readonly language?: string
    },
  ): Promise<string>
  /** Stops the worker (on lock); a later call starts a new one. */
  dispose(): void
}

// Provider calls

/** What every provider call of this module needs: the provider, its key (null when keyless) and the model. */
export interface MediaTarget {
  readonly provider: ProviderConfig
  readonly apiKey: string | null
  readonly modelId: string
  readonly signal?: AbortSignal
}

/** A provider call failed: the same codes as a chat answer's, with the provider's (untrusted) message. */
export class MediaError extends Error {
  readonly error: ChatError
  constructor(error: ChatError) {
    super(error.message || error.code)
    this.name = 'MediaError'
    this.error = error
  }
}

export interface GeneratedImage {
  readonly bytes: Bytes
  readonly mediaType: string
}

export interface SpokenAudio {
  readonly bytes: Bytes
  readonly mediaType: string
}

/** What a provider kind offers here, and the models it starts with. */
export interface MediaOffer {
  /** Image models among the provider's models, else the kind's default; empty when it generates none here. */
  readonly imageModels: readonly string[]
  /** The default transcription model, or null when the provider has no transcription API here. */
  readonly transcription: string | null
  /** The default speech model, or null when it has no speech API here. */
  readonly speech: string | null
}

export interface MediaApiModule {
  /** What `provider` offers (by kind and preset, and the image models its list names). */
  mediaOffer(provider: ProviderConfig): MediaOffer
  /** Whether a model id names an image model of that kind. */
  isImageModel(kind: ProviderKind, modelId: string): boolean
  /** OpenAI-compatible `/audio/transcriptions`; MediaError on a provider failure. */
  transcribe(target: MediaTarget, audio: { readonly bytes: Uint8Array; readonly mediaType: string }): Promise<string>
  /** OpenAI-compatible `/audio/speech`; MediaError on a provider failure. */
  speak(target: MediaTarget, input: { readonly text: string; readonly voice: string }): Promise<SpokenAudio>
  /** One image from the provider's image API; MediaError on a provider failure or when none came back. */
  generateImage(target: MediaTarget, prompt: string): Promise<GeneratedImage>
}

// Image turns

/** A generated image once prepared for storage (downscaled, re-encoded, metadata removed, as a photo is). */
export interface PreparedImage {
  readonly bytes: Bytes
  readonly mediaType: string
  readonly width: number
  readonly height: number
}

/** An image turn that is running. */
export interface ImageTurnState {
  readonly conversationId: Id
  /** The id the assistant message will take. */
  readonly messageId: Id
  readonly parentId: Id
  readonly model: ModelRef
  readonly startedAt: number
}

export interface ImageTurnDeps {
  readonly workspace: Workspace
  readonly blobs: BlobPort
  readonly holdLock: (reason: string) => () => void
  readonly holdReload: (reason: string) => () => void
  /** The provider call (MediaApiModule `generateImage` with the stored key); MediaError on a provider failure. */
  readonly generate: (model: ModelRef, prompt: string, signal: AbortSignal) => Promise<GeneratedImage>
  /** Prepares the provider's bytes as a photo is prepared (src/core/media/photo.ts); rejects for a non-image. */
  readonly prepare: (image: GeneratedImage) => Promise<PreparedImage>
  readonly rng: Rng
  readonly clock: Clock
}

export interface ImageTurns {
  /**
   * Commits the prompt as a user message (a child of the leaf), generates one image with `model`, stores it and
   * commits it as the assistant's answer (status `done`, an `image` part), or the failure (status `error`). Rejects,
   * having written nothing, with InvalidInputError for an empty prompt or an unknown conversation, and
   * InvalidStateError while the vault is locking or another image turn runs in that conversation.
   */
  run(conversationId: Id, prompt: string, model: ModelRef): Promise<void>
  /** Cancels the running turn of the conversation (its answer is committed as `stopped`, with no part). */
  stop(conversationId: Id): void
  state(conversationId: Id): ImageTurnState | null
  /** Conversations with an image turn running. */
  running(): readonly Id[]
  subscribe(fn: (conversationId: Id) => void): () => void
  /** Stops every turn and resolves once each has committed (the vault's `onLock`). */
  dispose(): Promise<void>
}
