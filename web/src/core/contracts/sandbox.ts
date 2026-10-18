/*
 * Contract of the sandboxes (F7): what a run asks for, what it returns, how it is stopped and capped, how the pinned
 * runtimes reach a frame that has no network, and how an artifact is shown. Implemented by:
 *
 *   web/src/core/sandbox/protocol.ts   the messages between the app and the sandbox frames, and their validation
 *   web/src/core/sandbox/runtimes.ts   the pinned runtimes (runtime-lock.json), package resolution, hash checks
 *   web/src/core/sandbox/tools.ts      the `run_js` and `run_python` tools (F6) over a SandboxRunner
 *   web/src/sandbox/host.ts            the SandboxRunner and ArtifactHost of the page (frames, timeouts, transfers)
 *   web/src/sandbox/runtime.ts         the pinned downloads and their verified runtime cache
 *   web/src/sandbox/frame/*.ts         the code of the sandbox pages and of the workers they start
 *
 * Invariants:
 * - Untrusted code (model output, artifacts, skill scripts) runs only inside the sandbox pages under
 *   `<base>sandbox/`, framed with `sandbox="allow-scripts"` (an opaque origin: no cookies, no storage, nothing of the
 *   app's origin). Each page carries its own meta Content-Security-Policy with `connect-src 'none'` and no host
 *   allowed for images, styles, fonts, media or frames, and refuses to run unless `self.origin === 'null'` and it is
 *   framed. Code runs in a dedicated worker the frame starts from a `blob:` URL, never in the frame's own realm (an
 *   artifact runs in a nested `srcdoc` frame, and only after the user's Run click when it holds scripts).
 * - The sandbox has no network at all. Every runtime it needs (Pyodide, its packages, Mermaid) is fetched by the page
 *   through web/src/security/net.ts (purpose `download`), checked against the SHA-256 pinned in runtime-lock.json (or,
 *   for a Pyodide package, in the pinned `pyodide-lock.json`), and transferred into the frame as an ArrayBuffer.
 * - Every message is checked on arrival: its `source` (the frame's own window, the frame's parent, the frame's own
 *   worker) and its shape (protocol.ts). A message that fails either is dropped, never answered.
 * - A run ends with exactly one RunResult: on success, on an error of the code, on its time limit (the worker is
 *   terminated), on its memory cap, on cancellation (the AbortSignal), or when the frame dies or stops answering (the
 *   frame is thrown away). What it printed up to then is kept.
 * - Outputs (printed text, files, figures) are untrusted data. The app stores files and figures as encrypted blobs
 *   (contracts/workspace.ts `BlobPort`) and shows them as text, images or downloads, never as markup of the app.
 */

import type { Bytes } from './crypto.ts'

export type SandboxLanguage = 'javascript' | 'python'

/** A file going into a run or coming out of one. `name` is a plain file name: no directory, no `..`. */
export interface SandboxFile {
  readonly name: string
  readonly mediaType: string
  readonly data: Bytes
}

/** The caps of one run. */
export interface SandboxLimits {
  /** Wall-clock time from the start of the run, runtime loading included. */
  readonly timeoutMs: number
  /**
   * The largest heap of the run. Enforced on the Python heap (WebAssembly memory growth past it fails, which Python
   * raises as MemoryError); a JavaScript worker is held to the engine's own per-worker heap limit and reported as
   * `memory` when the engine kills it.
   */
  readonly memoryBytes: number
  /** The most characters kept of stdout and of stderr each; the rest is cut and `truncated` set. */
  readonly outputChars: number
  /** The most files a run may return, and the largest one. */
  readonly maxFiles: number
  readonly maxFileBytes: number
}

export const DEFAULT_LIMITS: SandboxLimits = Object.freeze({
  timeoutMs: 60_000,
  memoryBytes: 1024 * 1024 * 1024,
  outputChars: 20_000,
  maxFiles: 16,
  maxFileBytes: 8 * 1024 * 1024,
})

/** What a request may raise its limits to. */
export const MAX_LIMITS: SandboxLimits = Object.freeze({
  timeoutMs: 180_000,
  memoryBytes: 2 * 1024 * 1024 * 1024,
  outputChars: 100_000,
  maxFiles: 32,
  maxFileBytes: 32 * 1024 * 1024,
})

/** The input files of one run together may not exceed this. */
export const MAX_INPUT_BYTES = 64 * 1024 * 1024

export interface RunRequest {
  readonly language: SandboxLanguage
  readonly code: string
  /** Files the code can read: Python finds them in its working directory, JavaScript through `readFile(name)`. */
  readonly files?: readonly SandboxFile[]
  /** Python packages to load besides those the imports name (any package of the pinned Pyodide distribution). */
  readonly packages?: readonly string[]
  readonly limits?: Partial<SandboxLimits>
}

/**
 * How a run ended: `ok`, `error` (the code raised or threw), `timeout`, `memory`, `cancelled`, `crashed` (the worker
 * or the frame died), `unavailable` (the runtime could not be loaded or did not match its pinned hash).
 */
export type RunStatus = 'ok' | 'error' | 'timeout' | 'memory' | 'cancelled' | 'crashed' | 'unavailable'

export interface RunResult {
  readonly status: RunStatus
  readonly stdout: string
  readonly stderr: string
  /** Some output was cut to `outputChars`, or some file was dropped for the caps. */
  readonly truncated: boolean
  /**
   * What the code returned: JSON text for JavaScript (or its string form when it is not JSON), the `repr` of the last
   * expression for Python. Absent when nothing was returned (`undefined`, `None`).
   */
  readonly value?: string
  /** The error, as the runtime wrote it (a JavaScript stack, a Python traceback) or why the run was stopped. */
  readonly error?: string
  /** Files the code wrote (Python: new or changed files of its working directory; JavaScript: `writeFile`). */
  readonly files: readonly SandboxFile[]
  /** Figures the runtime captured (matplotlib figures left open, as PNG). */
  readonly images: readonly SandboxFile[]
  /** The Python packages loaded for this run. */
  readonly packages: readonly string[]
  readonly durationMs: number
}

/** Runs code in the sandbox. */
export interface SandboxRunner {
  /**
   * Runs one request to its result. Rejects with an AbortError when `signal` aborts (the run is stopped first), and
   * with InvalidInputError for a malformed request (an unsafe file name, inputs over MAX_INPUT_BYTES); every other
   * failure is a result.
   */
  run(request: RunRequest, signal: AbortSignal): Promise<RunResult>
  /** Throws the frame and its workers away (on lock); the next run starts a new one. */
  reset(): void
}

// Artifacts

/** What an artifact frame renders. `react` and `code` artifacts are shown as code (contracts/workspace.ts `artifact`). */
export type ArtifactKind = 'html' | 'svg' | 'mermaid'

export interface ArtifactSource {
  readonly kind: ArtifactKind
  readonly source: string
}

/**
 * Whether an artifact runs code when shown: HTML with a script element, an inline handler or a `javascript:` URL,
 * SVG with any of those. Such an artifact is shown inert until the user clicks Run. Mermaid diagrams never do (the
 * pinned Mermaid renders them with `securityLevel: 'strict'`).
 */
export type ArtifactScripts = boolean

/** The size of the largest artifact a frame renders. */
export const MAX_ARTIFACT_CHARS = 512 * 1024

// The pinned runtimes

/** One pinned file: where it comes from and its SHA-256 (lowercase hex). */
export interface PinnedFile {
  readonly url: string
  readonly sha256: string
}

/** A runtime file once fetched and checked, ready to transfer. */
export interface RuntimeAsset {
  readonly name: string
  readonly sha256: string
  readonly data: Bytes
}

/** Fetches pinned files; the page's implementation goes through net.ts and keeps a verified runtime cache. */
export interface RuntimeFetcher {
  /** The bytes of `file`, checked against its hash. Rejects with TamperedError on a mismatch, or when offline. */
  get(file: PinnedFile, signal?: AbortSignal): Promise<Bytes>
}
