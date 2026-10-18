/*
 * The runner frame (`<base>sandbox/runner.html`): takes runs from the app and runs each in a worker of its own,
 * started from a `blob:` URL (js-worker.ts, py-worker.ts), terminated once it is done, out of time or cancelled.
 *
 * Invariants:
 * - It runs only framed, with an opaque origin (guard.ts); it takes messages only from its parent and from the app's
 *   origin, and from each worker only for that worker's run, all checked by core/sandbox/protocol.ts.
 * - It answers each run exactly once, posting the result to the app's origin only, with what was printed so far
 *   even when the worker was stopped. Output is capped as the run's limits say.
 * - Runtime files are kept by their hash for the frame's lifetime, so the app sends each one once; every worker gets
 *   its own copy.
 */

import { jsWorker, pyWorker } from 'virtual:aparte-sandbox-workers'
import type { RunStatus } from '../../core/contracts/sandbox.ts'
import {
  capText,
  type DoneMessage,
  PROTOCOL,
  parseFromWorker,
  parseToRunner,
  type RunMessage,
  type WireFile,
  type WireRunResult,
} from '../../core/sandbox/protocol.ts'
import { createBlobWorker } from '../../security/workers.ts'
import { APP_ORIGIN, refusal, showRefusal } from './guard.ts'

interface Run {
  readonly message: RunMessage
  readonly worker: Worker | null
  readonly started: number
  stdout: string
  stderr: string
  timer: ReturnType<typeof setTimeout> | null
  done: boolean
}

const held = new Map<string, ArrayBuffer>()
const runs = new Map<string, Run>()

function reply(id: string, result: WireRunResult): void {
  const transfer = [...result.files, ...result.images].map((f) => f.data)
  window.parent.postMessage({ p: PROTOCOL, type: 'result', id, result }, APP_ORIGIN, transfer)
}

/** Keeps a capped stream: a little over the cap while running, cut to it at the end. */
function append(current: string, text: string, cap: number): string {
  if (current.length > cap + 4096) return current
  return current + text
}

function capFiles(files: readonly WireFile[], max: number, maxBytes: number): { files: WireFile[]; cut: boolean } {
  const kept = files.filter((f) => f.data.byteLength <= maxBytes).slice(0, max)
  return { files: kept, cut: kept.length !== files.length }
}

function finish(run: Run, status: RunStatus, done?: DoneMessage, error?: string): void {
  if (run.done) return
  run.done = true
  if (run.timer !== null) clearTimeout(run.timer)
  run.worker?.terminate()
  runs.delete(run.message.id)
  const limits = run.message.limits
  const stdout = capText(run.stdout, limits.outputChars)
  const stderr = capText(run.stderr, limits.outputChars)
  const files = capFiles(done?.files ?? [], limits.maxFiles, limits.maxFileBytes)
  const images = capFiles(done?.images ?? [], limits.maxFiles, limits.maxFileBytes)
  const value = done?.value === undefined ? undefined : capText(done.value, limits.outputChars)
  const message = done?.error ?? error
  const err = message === undefined ? undefined : capText(message, limits.outputChars)
  reply(run.message.id, {
    status,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.cut || stderr.cut || files.cut || images.cut || (value?.cut ?? false) || (err?.cut ?? false),
    ...(value === undefined ? {} : { value: value.text }),
    ...(err === undefined ? {} : { error: err.text }),
    files: files.files,
    images: images.files,
    packages: done?.packages ?? [],
    durationMs: Math.max(0, Math.round(performance.now() - run.started)),
  })
}

function start(message: RunMessage): void {
  if (runs.has(message.id)) return
  for (const asset of message.assets) if (asset.data !== undefined) held.set(asset.sha256, asset.data)
  const missing = message.assets.filter((a) => !held.has(a.sha256))
  const base = { message, started: performance.now(), stdout: '', stderr: '', timer: null, done: false }
  if (missing.length > 0) {
    const run: Run = { ...base, worker: null }
    finish(run, 'unavailable', undefined, `The runtime files ${missing.map((a) => a.name).join(', ')} were not sent`)
    return
  }
  const source = message.language === 'python' ? pyWorker : jsWorker
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  let worker: Worker
  try {
    worker = createBlobWorker(url)
  } catch (error) {
    URL.revokeObjectURL(url)
    finish({ ...base, worker: null }, 'crashed', undefined, String(error))
    return
  }
  const run: Run = { ...base, worker }
  runs.set(message.id, run)
  run.timer = setTimeout(
    () => finish(run, 'timeout', undefined, `Stopped after ${message.limits.timeoutMs / 1000} s`),
    message.limits.timeoutMs,
  )
  worker.onmessage = (event: MessageEvent) => {
    const m = parseFromWorker(event.data)
    if (m === null || run.done) return
    if (m.type === 'out') {
      if (m.stream === 'stdout') run.stdout = append(run.stdout, m.text, message.limits.outputChars)
      else run.stderr = append(run.stderr, m.text, message.limits.outputChars)
    } else {
      finish(run, m.status, m)
    }
  }
  worker.onerror = (event: ErrorEvent) => {
    event.preventDefault()
    const text = event.message || 'The worker stopped'
    finish(run, /memory/i.test(text) ? 'memory' : 'crashed', undefined, text)
  }
  const assets = message.assets.map((a) => ({ name: a.name, data: (held.get(a.sha256) as ArrayBuffer).slice(0) }))
  const files = message.files.map((f) => ({ name: f.name, mediaType: f.mediaType, data: f.data }))
  worker.postMessage(
    {
      p: PROTOCOL,
      type: 'start',
      language: message.language,
      code: message.code,
      files,
      assets,
      packages: message.packages,
      limits: message.limits,
    },
    [...assets.map((a) => a.data), ...files.map((f) => f.data)],
  )
  // The worker has read its script once it answers; revoking now would race its load on some engines.
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

const refused = refusal({ origin: self.origin, top: window.top, self: window })
if (refused !== null) {
  showRefusal(refused)
} else {
  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== APP_ORIGIN) return
    const message = parseToRunner(event.data)
    if (message === null) return
    if (message.type === 'run') start(message)
    else {
      const run = runs.get(message.id)
      if (run !== undefined) finish(run, 'cancelled', undefined, 'Cancelled')
    }
  })
  window.parent.postMessage({ p: PROTOCOL, type: 'ready', frame: 'runner' }, APP_ORIGIN)
}
