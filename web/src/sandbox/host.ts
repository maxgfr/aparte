/*
 * The app's side of the runner frame: the SandboxRunner of contracts/sandbox.ts. It frames
 * `<base>sandbox/runner.html` with `sandbox="allow-scripts"` (hidden), fetches and checks the runtimes a run needs
 * (runtime.ts), transfers them with the run, and waits for the one result.
 *
 * Invariants:
 * - Messages are taken only from the frame it made (`event.source` is its window, `event.origin` is `null`) and only
 *   when protocol.ts accepts them; a result is matched to its run by a random id the frame never chose.
 * - A run gets exactly one result. The frame enforces the time limit; the page adds a watchdog past it, and when the
 *   frame does not answer in time it is thrown away and the run ends as `crashed`. An abort cancels the run in the
 *   frame and rejects at once.
 * - Inputs are checked before anything is sent: plain file names, MAX_INPUT_BYTES in all, the code within its limit.
 * - `reset()` (on lock) removes the frame: its workers, its held runtimes and every run in flight go with it.
 */
import { InvalidInputError } from '../core/contracts/crypto.ts'
import {
  DEFAULT_LIMITS,
  MAX_INPUT_BYTES,
  MAX_LIMITS,
  type RunRequest,
  type RunResult,
  type RuntimeAsset,
  type RuntimeFetcher,
  type SandboxLimits,
  type SandboxRunner,
} from '../core/contracts/sandbox.ts'
import { toHex } from '../core/crypto/bytes.ts'
import {
  isFileName,
  MAX_CODE_CHARS,
  PROTOCOL,
  parseFromRunner,
  type WireAsset,
  type WireRunResult,
} from '../core/sandbox/protocol.ts'
import {
  type PyodideLock,
  packageFile,
  parsePyodideLock,
  pyodideCore,
  resolvePackages,
} from '../core/sandbox/runtimes.ts'

// Vite replaces it at build time; under `bun test` it is undefined.
const BASE: unknown = import.meta.env.BASE_URL

/** The URL of a sandbox page of this build. */
export function sandboxPageURL(page: 'runner' | 'artifact'): string {
  const base = typeof BASE === 'string' ? BASE : '/'
  return new URL(`${base}sandbox/${page}.html`, globalThis.location.href).href
}

/** A fresh run id: 128 random bits, as protocol.ts requires. */
export function newRunId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(16)))
}

/** Limits within MAX_LIMITS, defaults for what the request leaves out. */
export function limitsOf(asked: Partial<SandboxLimits> | undefined): SandboxLimits {
  const out = { ...DEFAULT_LIMITS }
  for (const key of Object.keys(MAX_LIMITS) as (keyof SandboxLimits)[]) {
    const v = asked?.[key]
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.max(1, Math.min(MAX_LIMITS[key], Math.round(v)))
  }
  return out
}

function abortError(): Error {
  const error = new Error('The run was stopped')
  error.name = 'AbortError'
  return error
}

/** A result without output, for a run that never reached the code. */
function ended(status: RunResult['status'], error: string): RunResult {
  return { status, stdout: '', stderr: '', truncated: false, error, files: [], images: [], packages: [], durationMs: 0 }
}

function fromWire(r: WireRunResult): RunResult {
  const file = (f: WireRunResult['files'][number]) => ({
    name: f.name,
    mediaType: f.mediaType,
    data: new Uint8Array(f.data),
  })
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    truncated: r.truncated,
    ...(r.value === undefined ? {} : { value: r.value }),
    ...(r.error === undefined ? {} : { error: r.error }),
    files: r.files.map(file),
    images: r.images.map(file),
    packages: [...r.packages],
    durationMs: r.durationMs,
  }
}

interface Frame {
  readonly iframe: HTMLIFrameElement
  readonly ready: Promise<boolean>
  /** Hashes of the runtime files this frame already holds. */
  readonly sent: Set<string>
  readonly pending: Map<string, (result: WireRunResult | null) => void>
  dispose(): void
}

export interface SandboxHostOptions {
  readonly fetcher: RuntimeFetcher
  /** How long the frame may take to say it is ready. */
  readonly readyTimeoutMs?: number
  /** How long past a run's time limit the page waits for the frame before throwing it away. */
  readonly graceMs?: number
}

export function createSandboxRunner(options: SandboxHostOptions): SandboxRunner {
  let frame: Frame | null = null
  let lock: Promise<PyodideLock> | null = null

  const openFrame = (): Frame => {
    const iframe = document.createElement('iframe')
    iframe.setAttribute('sandbox', 'allow-scripts')
    iframe.setAttribute('aria-hidden', 'true')
    iframe.setAttribute('referrerpolicy', 'no-referrer')
    iframe.tabIndex = -1
    iframe.title = 'Sandbox'
    iframe.hidden = true
    iframe.dataset.sandbox = 'runner'
    const pending = new Map<string, (result: WireRunResult | null) => void>()
    let onReady: (ok: boolean) => void = () => undefined
    const ready = new Promise<boolean>((resolve) => {
      onReady = resolve
    })
    const timer = setTimeout(() => onReady(false), options.readyTimeoutMs ?? 20_000)
    const listener = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || event.origin !== 'null') return
      const message = parseFromRunner(event.data)
      if (message === null) return
      if (message.type === 'ready') {
        clearTimeout(timer)
        onReady(true)
        return
      }
      const settle = pending.get(message.id)
      if (settle === undefined) return
      pending.delete(message.id)
      settle(message.result)
    }
    window.addEventListener('message', listener)
    iframe.src = sandboxPageURL('runner')
    document.body.append(iframe)
    const opened: Frame = {
      iframe,
      ready,
      sent: new Set(),
      pending,
      dispose() {
        clearTimeout(timer)
        onReady(false)
        window.removeEventListener('message', listener)
        iframe.remove()
        for (const settle of pending.values()) settle(null)
        pending.clear()
      },
    }
    return opened
  }

  const reset = () => {
    frame?.dispose()
    frame = null
  }

  const pyodideAssets = async (
    code: string,
    asked: readonly string[],
    signal: AbortSignal,
  ): Promise<{ assets: RuntimeAsset[]; packages: string[] } | RunResult> => {
    const core = pyodideCore()
    const bytes = await Promise.all(core.map((f) => options.fetcher.get(f, signal)))
    const assets: RuntimeAsset[] = core.map((f, i) => ({
      name: f.name,
      sha256: f.sha256,
      data: bytes[i] as Uint8Array<ArrayBuffer>,
    }))
    const lockAsset = assets.find((a) => a.name === 'pyodide-lock.json') as RuntimeAsset
    lock ??= Promise.resolve().then(() => parsePyodideLock(new TextDecoder().decode(lockAsset.data)))
    lock.catch(() => {
      lock = null
    })
    const { packages, unknown } = resolvePackages(await lock, code, asked)
    if (unknown.length > 0)
      return ended(
        'error',
        `No package named ${unknown.map((n) => JSON.stringify(n)).join(', ')} in the Pyodide distribution`,
      )
    const files = await Promise.all(packages.map((p) => options.fetcher.get(packageFile(p), signal)))
    packages.forEach((p, i) => {
      assets.push({ name: p.fileName, sha256: p.sha256, data: files[i] as Uint8Array<ArrayBuffer> })
    })
    return { assets, packages: packages.map((p) => p.name) }
  }

  return {
    reset,
    async run(request: RunRequest, signal: AbortSignal): Promise<RunResult> {
      if (signal.aborted) throw abortError()
      if (request.code.length > MAX_CODE_CHARS) throw new InvalidInputError('The code is too long to run')
      let total = 0
      for (const f of request.files ?? []) {
        if (!isFileName(f.name)) throw new InvalidInputError(`Not a plain file name: ${f.name}`)
        total += f.data.length
      }
      if (total > MAX_INPUT_BYTES) throw new InvalidInputError('The input files are too large for one run')
      const limits = limitsOf(request.limits)

      let assets: RuntimeAsset[] = []
      let packages: string[] = []
      if (request.language === 'python') {
        try {
          const loaded = await pyodideAssets(request.code, request.packages ?? [], signal)
          if ('status' in loaded) return loaded
          assets = loaded.assets
          packages = loaded.packages
        } catch (error) {
          if (signal.aborted) throw abortError()
          return ended('unavailable', error instanceof Error ? error.message : String(error))
        }
      }
      if (signal.aborted) throw abortError()

      frame ??= openFrame()
      const current = frame
      if (!(await current.ready)) {
        if (frame === current) reset()
        if (signal.aborted) throw abortError()
        return ended('crashed', 'The sandbox did not start')
      }
      const id = newRunId()
      const wireAssets: WireAsset[] = assets.map((a) =>
        current.sent.has(a.sha256)
          ? { name: a.name, sha256: a.sha256 }
          : { name: a.name, sha256: a.sha256, data: a.data.slice().buffer },
      )
      const files = (request.files ?? []).map((f) => ({
        name: f.name,
        mediaType: f.mediaType,
        data: f.data.slice().buffer,
      }))
      const result = new Promise<WireRunResult | null>((resolve) => current.pending.set(id, resolve))
      const transfer = [
        ...wireAssets.flatMap((a) => (a.data === undefined ? [] : [a.data])),
        ...files.map((f) => f.data),
      ]
      current.iframe.contentWindow?.postMessage(
        {
          p: PROTOCOL,
          type: 'run',
          id,
          language: request.language,
          code: request.code,
          files,
          assets: wireAssets,
          packages,
          limits,
        },
        '*',
        transfer,
      )
      for (const a of assets) current.sent.add(a.sha256)

      let watchdog: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      try {
        const outcome = await Promise.race([
          result,
          new Promise<'late'>((resolve) => {
            watchdog = setTimeout(() => resolve('late'), limits.timeoutMs + (options.graceMs ?? 20_000))
          }),
          new Promise<'aborted'>((resolve) => {
            onAbort = () => resolve('aborted')
            signal.addEventListener('abort', onAbort, { once: true })
          }),
        ])
        if (outcome === 'aborted') {
          current.pending.delete(id)
          current.iframe.contentWindow?.postMessage({ p: PROTOCOL, type: 'cancel', id }, '*')
          throw abortError()
        }
        if (outcome === 'late') {
          if (frame === current) reset()
          return ended('crashed', 'The sandbox stopped answering, so it was closed')
        }
        if (outcome === null) return ended('crashed', 'The sandbox was closed during the run')
        return fromWire(outcome)
      } finally {
        clearTimeout(watchdog)
        if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
      }
    },
  }
}
