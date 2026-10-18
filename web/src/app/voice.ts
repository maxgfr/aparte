/*
 * The browser side of voice: recording the microphone as samples, Whisper in the transformers.js worker, the
 * browser's own speech recognition (off unless the user accepted that it sends audio away), this device's own voices
 * for reading aloud, and playing a provider's speech. Loaded lazily, with the chat chunks.
 *
 * Invariants:
 * - The recording stays in memory: samples are collected from the microphone stream (no MediaRecorder file), handed
 *   to the transcriber, then zeroed. The microphone is released as soon as a recording stops or is cancelled, or
 *   when Web Audio does not start (a machine without a sound server, where Firefox never runs an AudioContext).
 * - Reading aloud uses `localService` voices only. A remote voice would send the answer to the browser maker; without
 *   a local voice for the text's language nothing is spoken.
 * - Speech from a provider is decoded and played through Web Audio, never as a `blob:` URL.
 * - `releaseVoice()` (on lock) cancels a recording, stops speech and playback, and terminates the speech worker.
 */
import { connectTranscriber } from '../core/ai/local/transcribe.ts'
import { MAX_DICTATION_SECONDS, type Transcriber } from '../core/contracts/media.ts'
import { toSpeechSamples } from '../core/media/audio.ts'
import { startTransformersWorker } from './local.ts'

// Recording

/** Why a recording could not start. */
export type RecordFailure = 'denied' | 'no-microphone' | 'no-audio' | 'unsupported' | 'failed'

export class RecordError extends Error {
  constructor(readonly reason: RecordFailure) {
    super(reason)
    this.name = 'RecordError'
  }
}

export interface Recording {
  /** Stops and returns 16 kHz mono samples. */
  stop(): Promise<Float32Array>
  /** Stops and drops what was recorded. */
  cancel(): void
}

type AudioContextCtor = typeof AudioContext

function audioContextCtor(): AudioContextCtor | null {
  const g = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor }
  return g.AudioContext ?? g.webkitAudioContext ?? null
}

export function recordingSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && audioContextCtor() !== null
}

let active: Recording | null = null

/** How long recording or playback waits for Web Audio to start before giving up (and releasing the microphone). */
const AUDIO_START_MS = 3_000

/**
 * Resumes `ctx` and resolves true once it runs, false when it still does not after `ms`. Without a sound server
 * (Firefox on a Linux machine with no audio output) an AudioContext stays suspended and resume() never settles, so
 * waiting for it would leave dictation listening to nothing, or a reading busy, forever.
 */
function audioStarts(ctx: AudioContext, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (running: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.removeEventListener('statechange', check)
      resolve(running)
    }
    const check = () => {
      if (ctx.state === 'running') finish(true)
    }
    const timer = setTimeout(() => finish(false), ms)
    ctx.addEventListener('statechange', check)
    check()
    ctx.resume().then(check, () => undefined)
  })
}

/** Starts recording the microphone; RecordError when it cannot. `onLevel` hears the input level, 0 to 1. */
export async function startRecording(onLevel?: (level: number) => void): Promise<Recording> {
  const Ctor = audioContextCtor()
  if (!recordingSupported() || Ctor === null) throw new RecordError('unsupported')
  active?.cancel()
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
  } catch (error) {
    const name = (error as { name?: string } | null)?.name
    if (name === 'NotAllowedError' || name === 'SecurityError') throw new RecordError('denied')
    if (name === 'NotFoundError' || name === 'OverconstrainedError') throw new RecordError('no-microphone')
    throw new RecordError('failed')
  }
  const ctx = new Ctor()
  if (!(await audioStarts(ctx, AUDIO_START_MS))) {
    for (const track of stream.getTracks()) track.stop()
    void ctx.close().catch(() => undefined)
    throw new RecordError('no-audio')
  }
  const source = ctx.createMediaStreamSource(stream)
  // A ScriptProcessor, deprecated but in every engine, hands the samples over without a module to load.
  const processor = ctx.createScriptProcessor(4096, 1, 1)
  const mute = ctx.createGain()
  mute.gain.value = 0
  const limit = Math.ceil(ctx.sampleRate * MAX_DICTATION_SECONDS)
  const chunks: Float32Array[] = []
  let length = 0
  processor.onaudioprocess = (event) => {
    const data = event.inputBuffer.getChannelData(0)
    if (length < limit) {
      chunks.push(new Float32Array(data))
      length += data.length
    }
    if (onLevel) {
      let peak = 0
      for (const s of data) peak = Math.max(peak, Math.abs(s))
      onLevel(Math.min(1, peak))
    }
  }
  source.connect(processor)
  processor.connect(mute)
  mute.connect(ctx.destination)

  let ended = false
  const end = () => {
    if (ended) return false
    ended = true
    processor.onaudioprocess = null
    source.disconnect()
    processor.disconnect()
    mute.disconnect()
    for (const track of stream.getTracks()) track.stop()
    void ctx.close().catch(() => undefined)
    if (active === recording) active = null
    return true
  }
  const drop = () => {
    for (const c of chunks) c.fill(0)
    chunks.length = 0
  }
  const recording: Recording = {
    async stop() {
      if (!end()) return new Float32Array(0)
      const all = new Float32Array(length)
      let offset = 0
      for (const c of chunks) {
        all.set(c, offset)
        offset += c.length
      }
      drop()
      const samples = toSpeechSamples([all], ctx.sampleRate)
      all.fill(0)
      return samples
    },
    cancel() {
      if (end()) drop()
    },
  }
  active = recording
  return recording
}

// On-device transcription

let transcriber: Transcriber | null = null

/** Whisper in the transformers.js worker, started on first use. */
export function localTranscriber(): Transcriber {
  transcriber ??= connectTranscriber(() => startTransformersWorker('speech') as never)
  return transcriber
}

// The browser's speech recognition (Chrome's Web Speech API: audio goes to Google)

interface RecognitionResultList {
  readonly length: number
  [index: number]: { readonly isFinal: boolean; readonly 0: { readonly transcript: string } }
}

interface RecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: { readonly resultIndex: number; readonly results: RecognitionResultList }) => void) | null
  onerror: ((event: { readonly error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
  abort(): void
}

type RecognitionCtor = new () => RecognitionLike

function recognitionCtor(): RecognitionCtor | null {
  const g = globalThis as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null
}

export function browserRecognitionSupported(): boolean {
  return recognitionCtor() !== null
}

export interface BrowserDictation {
  /** Stops listening and resolves with what was heard. */
  stop(): Promise<string>
  cancel(): void
}

let listening: BrowserDictation | null = null

/** Starts the browser's recognition in `lang`; RecordError when it cannot. */
export function startBrowserDictation(lang: string): BrowserDictation {
  const Ctor = recognitionCtor()
  if (Ctor === null) throw new RecordError('unsupported')
  listening?.cancel()
  const recognition = new Ctor()
  recognition.lang = lang
  recognition.continuous = true
  recognition.interimResults = false
  const heard: string[] = []
  let failure: RecordFailure | null = null
  let finish: (text: string) => void = () => undefined
  let fail: (error: unknown) => void = () => undefined
  const finished = new Promise<string>((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      if (result?.isFinal) heard.push(result[0].transcript.trim())
    }
  }
  recognition.onerror = (event) => {
    failure = event.error === 'not-allowed' || event.error === 'service-not-allowed' ? 'denied' : 'failed'
    if (event.error === 'audio-capture') failure = 'no-microphone'
    if (event.error === 'no-speech' || event.error === 'aborted') failure = null
  }
  recognition.onend = () => {
    if (listening === dictation) listening = null
    if (failure !== null) fail(new RecordError(failure))
    else finish(heard.filter(Boolean).join(' '))
  }
  const dictation: BrowserDictation = {
    stop() {
      recognition.stop()
      return finished
    },
    cancel() {
      heard.length = 0
      recognition.abort()
      finished.catch(() => undefined)
    },
  }
  try {
    recognition.start()
  } catch {
    throw new RecordError('failed')
  }
  listening = dictation
  return dictation
}

// Reading aloud with this device's own voices

export function speechSynthesisSupported(): boolean {
  return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined'
}

/** The voices that run on this device: never one of the browser maker's servers. */
export function localVoices(): SpeechSynthesisVoice[] {
  if (!speechSynthesisSupported()) return []
  return speechSynthesis.getVoices().filter((v) => v.localService)
}

/** Calls `fn` when the list of voices changes (they load asynchronously in Chrome). */
export function onVoicesChanged(fn: () => void): () => void {
  if (!speechSynthesisSupported()) return () => undefined
  speechSynthesis.addEventListener('voiceschanged', fn)
  return () => speechSynthesis.removeEventListener('voiceschanged', fn)
}

/** The best local voice for a BCP-47 tag: the exact tag, then the same language; null when none. */
export function pickLocalVoice(
  lang: string,
  voices: readonly SpeechSynthesisVoice[] = localVoices(),
): SpeechSynthesisVoice | null {
  const wanted = lang.toLowerCase().replace('_', '-')
  const base = wanted.split('-')[0]
  const norm = (v: SpeechSynthesisVoice) => v.lang.toLowerCase().replace('_', '-')
  return (
    voices.find((v) => norm(v) === wanted && v.default) ??
    voices.find((v) => norm(v) === wanted) ??
    voices.find((v) => norm(v).split('-')[0] === base) ??
    null
  )
}

/** Something being read aloud. */
export interface Speaking {
  stop(): void
  readonly done: Promise<void>
}

let speaking: Speaking | null = null

/**
 * Reads `text` with `voice`, a local voice (the caller picked it with `pickLocalVoice`). The voice is always set, so the
 * browser never falls back to a default that may be remote.
 */
export function speakLocally(text: string, voice: SpeechSynthesisVoice): Speaking {
  if (!voice.localService) throw new RecordError('unsupported')
  speaking?.stop()
  speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.voice = voice
  utterance.lang = voice.lang
  let settle: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  utterance.onend = () => settle()
  utterance.onerror = () => settle()
  const handle: Speaking = {
    stop() {
      speechSynthesis.cancel()
      settle()
    },
    done,
  }
  done.then(() => {
    if (speaking === handle) speaking = null
  })
  speaking = handle
  speechSynthesis.speak(utterance)
  return handle
}

/** Plays a provider's speech through Web Audio. */
export async function playSpeech(bytes: Uint8Array): Promise<Speaking> {
  const Ctor = audioContextCtor()
  if (Ctor === null) throw new RecordError('unsupported')
  speaking?.stop()
  const ctx = new Ctor()
  if (!(await audioStarts(ctx, AUDIO_START_MS))) {
    void ctx.close().catch(() => undefined)
    throw new RecordError('no-audio')
  }
  const buffer = await ctx.decodeAudioData(new Uint8Array(bytes).buffer)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  let settle: () => void = () => undefined
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  source.onended = () => settle()
  const handle: Speaking = {
    stop() {
      try {
        source.stop()
      } catch {
        // Already stopped.
      }
      settle()
    },
    done,
  }
  done.then(() => {
    if (speaking === handle) speaking = null
    void ctx.close().catch(() => undefined)
  })
  speaking = handle
  source.start()
  return handle
}

/** Stops everything voice holds: on lock, nothing of a conversation may keep playing or listening. */
export function releaseVoice(): void {
  active?.cancel()
  active = null
  listening?.cancel()
  listening = null
  speaking?.stop()
  speaking = null
  if (speechSynthesisSupported()) speechSynthesis.cancel()
  transcriber?.dispose()
  transcriber = null
}
