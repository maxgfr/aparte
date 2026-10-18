/*
 * Recorded speech as pure data: downmixing and resampling to the 16 kHz mono samples Whisper takes, and WAV encoding
 * for a provider's transcription API (16-bit PCM, which every Whisper server reads). Decoding the recording (WebM/Opus,
 * MP4/AAC) is the browser's job (src/app/voice.ts); nothing here touches the DOM.
 */
import type { Bytes } from '../contracts/crypto.ts'
import { MAX_DICTATION_SECONDS, SPEECH_SAMPLE_RATE } from '../contracts/media.ts'

/**
 * Averages the channels and resamples to `rate` (16 kHz by default), keeping at most `maxSeconds`. Downsampling
 * averages every input sample that falls in an output sample's span (a box filter, enough against aliasing for
 * speech); upsampling interpolates linearly.
 */
export function toSpeechSamples(
  channels: readonly Float32Array[],
  sourceRate: number,
  rate = SPEECH_SAMPLE_RATE,
  maxSeconds = MAX_DICTATION_SECONDS,
): Float32Array {
  if (!Number.isFinite(sourceRate) || sourceRate <= 0) throw new RangeError('The sample rate must be positive')
  const first = channels[0]
  if (first === undefined) return new Float32Array(0)
  const length = Math.min(first.length, Math.floor(sourceRate * maxSeconds))
  const mono = new Float32Array(length)
  for (const channel of channels) for (let i = 0; i < length; i++) mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0)
  if (channels.length > 1) for (let i = 0; i < length; i++) mono[i] = (mono[i] ?? 0) / channels.length
  if (sourceRate === rate) return mono
  const ratio = sourceRate / rate
  const out = new Float32Array(Math.floor(length / ratio))
  for (let i = 0; i < out.length; i++) {
    if (ratio > 1) {
      const start = Math.floor(i * ratio)
      const end = Math.min(length, Math.max(start + 1, Math.floor((i + 1) * ratio)))
      let sum = 0
      for (let j = start; j < end; j++) sum += mono[j] ?? 0
      out[i] = sum / (end - start)
    } else {
      const at = i * ratio
      const j = Math.floor(at)
      const frac = at - j
      out[i] = (mono[j] ?? 0) * (1 - frac) + (mono[Math.min(j + 1, length - 1)] ?? 0) * frac
    }
  }
  return out
}

/** Mono 16-bit PCM WAV of `samples` (clamped to [-1, 1]). */
export function encodeWav(samples: Float32Array, rate = SPEECH_SAMPLE_RATE): Bytes {
  const dataBytes = samples.length * 2
  const out = new Uint8Array(44 + dataBytes)
  const view = new DataView(out.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(44 + i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true)
  }
  return out
}

/** Whether the samples hold anything above a whisper of noise (an empty recording is not sent anywhere). */
export function hasSpeech(samples: Float32Array, threshold = 0.01): boolean {
  let peak = 0
  for (const s of samples) {
    const a = Math.abs(s)
    if (a > peak) peak = a
    if (peak >= threshold) return true
  }
  return false
}
