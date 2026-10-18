/*
 * The speech worker protocol, both ends wired together in memory: transcripts, download progress, aborts, errors and
 * the worker failing; and the requests of the embedder sharing the worker are left alone.
 */
import { describe, expect, test } from 'bun:test'
import type { DownloadProgress } from '../../contracts/media.ts'
import {
  connectTranscriber,
  serveTranscriber,
  type TranscribeBackend,
  type TranscribeRequest,
  type TranscribeResponse,
} from './transcribe.ts'

function wire(backend: TranscribeBackend) {
  const toWorker: ((e: { data?: unknown }) => void)[] = []
  const toPage: ((e: { data?: unknown; message?: string }) => void)[] = []
  const pageErrors: ((e: { data?: unknown; message?: string }) => void)[] = []
  const sent: TranscribeRequest[] = []
  let terminated = 0
  serveTranscriber(
    {
      postMessage: (m: TranscribeResponse) =>
        queueMicrotask(() => {
          for (const l of toPage) l({ data: m })
        }),
      addEventListener: (_type, l) => toWorker.push(l),
    },
    backend,
  )
  const worker = {
    postMessage: (m: TranscribeRequest) => {
      sent.push(m)
      queueMicrotask(() => {
        for (const l of toWorker) l({ data: m })
      })
    },
    addEventListener: (type: 'message' | 'error', l: (e: { data?: unknown; message?: string }) => void) => {
      ;(type === 'message' ? toPage : pageErrors).push(l)
    },
    terminate: () => {
      terminated++
    },
  }
  let started = 0
  const transcriber = connectTranscriber(() => {
    started++
    return worker
  })
  return {
    transcriber,
    sent,
    fail: (message: string) => {
      for (const l of pageErrors) l({ message })
    },
    started: () => started,
    terminated: () => terminated,
    other: (data: unknown) => {
      for (const l of toWorker) l({ data })
    },
  }
}

describe('transcriber', () => {
  test('returns the transcript and reports the model download', async () => {
    const w = wire({
      async transcribe(audio, onProgress) {
        onProgress({ loaded: 5, total: 10 })
        onProgress({ loaded: 10, total: 10 })
        return `  heard ${audio.length} samples  `
      },
    })
    const progress: DownloadProgress[] = []
    const audio = new Float32Array(160)
    const text = await w.transcriber.transcribe(audio, { onProgress: (p) => progress.push(p) })
    expect(text).toBe('heard 160 samples')
    expect(progress).toEqual([
      { loaded: 5, total: 10 },
      { loaded: 10, total: 10 },
    ])
    // The caller's samples are left as they were; a copy went to the worker.
    expect(audio.length).toBe(160)
    expect(w.started()).toBe(1)
  })

  test('an abort rejects at once and the worker drops the answer', async () => {
    let release: () => void = () => undefined
    const w = wire({
      transcribe: () =>
        new Promise((resolve) => {
          release = () => resolve('late')
        }),
    })
    const abort = new AbortController()
    const pending = w.transcriber.transcribe(new Float32Array(1), { signal: abort.signal })
    await new Promise((r) => setTimeout(r, 0))
    abort.abort()
    await expect(pending).rejects.toThrow()
    release()
    expect(w.sent.map((m) => m.op)).toEqual(['transcribe', 'transcribe-abort'])
    const before = new AbortController()
    before.abort()
    await expect(w.transcriber.transcribe(new Float32Array(1), { signal: before.signal })).rejects.toThrow()
  })

  test('errors cross as errors, a dead worker fails what waits, dispose terminates', async () => {
    const w = wire({
      async transcribe() {
        throw new TypeError('no model')
      },
    })
    await expect(w.transcriber.transcribe(new Float32Array(1))).rejects.toThrow('no model')
    const hung = wire({ transcribe: () => new Promise(() => undefined) })
    const waiting = hung.transcriber.transcribe(new Float32Array(1))
    await new Promise((r) => setTimeout(r, 0))
    hung.fail('out of memory')
    await expect(waiting).rejects.toThrow('out of memory')
    const next = hung.transcriber.transcribe(new Float32Array(1))
    expect(hung.started()).toBe(2)
    hung.transcriber.dispose()
    await expect(next).rejects.toThrow('stopped')
    expect(hung.terminated()).toBe(1)
  })

  test('passes a well-formed language code on, and drops anything else', async () => {
    const heard: (string | undefined)[] = []
    const w = wire({
      async transcribe(_audio, _onProgress, language) {
        heard.push(language)
        return 'ok'
      },
    })
    await w.transcriber.transcribe(new Float32Array(1), { language: 'fr' })
    await w.transcriber.transcribe(new Float32Array(1))
    w.other({ id: 99, op: 'transcribe', audio: new Float32Array(1), language: '<script>' })
    await new Promise((r) => setTimeout(r, 0))
    expect(heard).toEqual(['fr', undefined, undefined])
  })

  test('ignores the embedder protocol and malformed requests', async () => {
    let calls = 0
    const w = wire({
      async transcribe() {
        calls++
        return 'x'
      },
    })
    w.other({ id: 1, op: 'embed', texts: ['a'] })
    w.other({ id: 2, op: 'transcribe', audio: 'not samples' })
    await new Promise((r) => setTimeout(r, 0))
    expect(calls).toBe(0)
  })
})
