/*
 * Recorded speech as data: downmixing, resampling to 16 kHz, the cut at the dictation limit, and the WAV a provider
 * receives (16-bit PCM, little-endian, mono).
 */
import { describe, expect, test } from 'bun:test'
import { encodeWav, hasSpeech, toSpeechSamples } from './audio.ts'

describe('speech samples', () => {
  test('downmix averages the channels', () => {
    const out = toSpeechSamples([Float32Array.from([1, 0.5]), Float32Array.from([0, -0.5])], 16000)
    expect([...out]).toEqual([0.5, 0])
  })

  test('48 kHz to 16 kHz averages each span of three samples', () => {
    const out = toSpeechSamples([Float32Array.from([0.3, 0.3, 0.3, 0.9, 0.6, 0.3])], 48000)
    expect(out.length).toBe(2)
    expect(out[0]).toBeCloseTo(0.3, 6)
    expect(out[1]).toBeCloseTo(0.6, 6)
  })

  test('8 kHz to 16 kHz interpolates', () => {
    const out = toSpeechSamples([Float32Array.from([0, 1, 0, 1])], 8000)
    expect(out.length).toBe(8)
    expect(out[1]).toBeCloseTo(0.5, 6)
  })

  test('keeps at most the dictation limit, and refuses a bad rate', () => {
    expect(toSpeechSamples([new Float32Array(16000 * 3)], 16000, 16000, 2).length).toBe(32000)
    expect(toSpeechSamples([], 16000).length).toBe(0)
    expect(() => toSpeechSamples([new Float32Array(4)], 0)).toThrow(RangeError)
  })

  test('silence is not speech', () => {
    expect(hasSpeech(new Float32Array(100))).toBe(false)
    expect(hasSpeech(Float32Array.from([0, 0.2, 0]))).toBe(true)
  })
})

describe('wav', () => {
  test('a mono 16-bit PCM file with the samples clamped', () => {
    const wav = encodeWav(Float32Array.from([0, 1, -1, 2]), 16000)
    const view = new DataView(wav.buffer)
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(wav.subarray(8, 16))).toBe('WAVEfmt ')
    expect(view.getUint32(4, true)).toBe(36 + 8)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(28, true)).toBe(32000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(new TextDecoder().decode(wav.subarray(36, 40))).toBe('data')
    expect(view.getUint32(40, true)).toBe(8)
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 32767])
  })
})
