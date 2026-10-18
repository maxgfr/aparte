/*
 * The messages between the app and its sandbox frames, and between a frame and the worker it starts
 * (contracts/sandbox.ts). Each side checks every message it receives with the parser of its direction: a message
 * that is not exactly one of these shapes is dropped. Pure, and depending on contracts/sandbox.ts only, so the frames
 * bundle it as it is.
 *
 *   app → runner      run, cancel
 *   runner → app      ready, result
 *   app → artifact    render
 *   artifact → app    ready, rendered, failed, height
 *   frame → worker    start
 *   worker → frame    out, done
 *
 * Invariants:
 * - Every message carries `p: PROTOCOL`; ids are 16 to 64 lowercase letters and digits, chosen at random by the app.
 * - File names are one plain segment (no `/`, `\`, `..`, control characters or leading dot); media types are
 *   `type/subtype`; bytes are ArrayBuffers (structured-cloned or transferred, so `instanceof` holds in the receiver).
 * - Numbers are finite and within the caps of contracts/sandbox.ts; strings within their size limits.
 */
import {
  type ArtifactKind,
  MAX_ARTIFACT_CHARS,
  MAX_LIMITS,
  type RunStatus,
  type SandboxLanguage,
  type SandboxLimits,
} from '../contracts/sandbox.ts'

export const PROTOCOL = 'aparte-sandbox/1'

/** The longest code a run takes. */
export const MAX_CODE_CHARS = 256 * 1024

/** A file on the wire. */
export interface WireFile {
  readonly name: string
  readonly mediaType: string
  readonly data: ArrayBuffer
}

/** A runtime file on the wire: known by its pinned hash; `data` is left out when the frame already holds it. */
export interface WireAsset {
  readonly name: string
  readonly sha256: string
  readonly data?: ArrayBuffer
}

export interface RunMessage {
  readonly p: typeof PROTOCOL
  readonly type: 'run'
  readonly id: string
  readonly language: SandboxLanguage
  readonly code: string
  readonly files: readonly WireFile[]
  /** The runtime files the run needs (Pyodide's core, then its packages). */
  readonly assets: readonly WireAsset[]
  /** The Pyodide packages to load before the code runs. */
  readonly packages: readonly string[]
  readonly limits: SandboxLimits
}

export interface CancelMessage {
  readonly p: typeof PROTOCOL
  readonly type: 'cancel'
  readonly id: string
}

export interface ReadyMessage {
  readonly p: typeof PROTOCOL
  readonly type: 'ready'
  readonly frame: 'runner' | 'artifact'
}

export interface WireRunResult {
  readonly status: RunStatus
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly value?: string
  readonly error?: string
  readonly files: readonly WireFile[]
  readonly images: readonly WireFile[]
  readonly packages: readonly string[]
  readonly durationMs: number
}

export interface ResultMessage {
  readonly p: typeof PROTOCOL
  readonly type: 'result'
  readonly id: string
  readonly result: WireRunResult
}

export interface RenderMessage {
  readonly p: typeof PROTOCOL
  readonly type: 'render'
  readonly id: string
  readonly kind: ArtifactKind
  readonly source: string
  /** The user clicked Run: scripts may run. Otherwise the artifact is shown inert. */
  readonly run: boolean
  readonly theme: 'light' | 'dark'
  /** Mermaid's bundle, for a `mermaid` artifact. */
  readonly assets: readonly WireAsset[]
}

export interface RenderedMessage {
  readonly p: typeof PROTOCOL
  readonly type: 'rendered'
  readonly id: string
  readonly height: number
}

export interface FailedMessage {
  readonly p: typeof PROTOCOL
  readonly type: 'failed'
  readonly id: string
  readonly message: string
}

export interface HeightMessage {
  readonly p: typeof PROTOCOL
  readonly type: 'height'
  readonly id: string
  readonly height: number
}

export interface StartMessage {
  readonly p: typeof PROTOCOL
  readonly type: 'start'
  readonly language: SandboxLanguage
  readonly code: string
  readonly files: readonly WireFile[]
  /** The runtime files by name (Pyodide's core files and package files). */
  readonly assets: readonly { readonly name: string; readonly data: ArrayBuffer }[]
  readonly packages: readonly string[]
  readonly limits: SandboxLimits
}

export interface OutMessage {
  readonly p: typeof PROTOCOL
  readonly type: 'out'
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
}

export interface DoneMessage {
  readonly p: typeof PROTOCOL
  readonly type: 'done'
  readonly status: 'ok' | 'error' | 'memory'
  readonly value?: string
  readonly error?: string
  readonly files: readonly WireFile[]
  readonly images: readonly WireFile[]
  readonly packages: readonly string[]
}

export type ToRunner = RunMessage | CancelMessage
export type FromRunner = ReadyMessage | ResultMessage
export type ToArtifact = RenderMessage
export type FromArtifact = ReadyMessage | RenderedMessage | FailedMessage | HeightMessage
export type ToWorker = StartMessage
export type FromWorker = OutMessage | DoneMessage

const ID = /^[a-z0-9]{16,64}$/
const HEX64 = /^[0-9a-f]{64}$/
const MEDIA_TYPE = /^[a-z]+\/[a-z0-9][a-z0-9.+-]{0,100}$/
// One plain segment: letters, digits and a few separators, not starting with a dot.
const FILE_NAME = /^[\p{L}\p{N}_][\p{L}\p{N} _.,()+=@-]{0,127}$/u
const ASSET_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,200}$/
const PACKAGE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,100}$/
const STATUSES: readonly RunStatus[] = ['ok', 'error', 'timeout', 'memory', 'cancelled', 'crashed', 'unavailable']
const KINDS: readonly ArtifactKind[] = ['html', 'svg', 'mermaid']

/** The longest text of a result field (stdout, stderr, value, error, a failure message). */
const MAX_TEXT = MAX_LIMITS.outputChars + 1024
/** The most files or assets one message carries. */
const MAX_ITEMS = 512
/** The tallest height a frame may report. */
export const MAX_HEIGHT = 20_000

type Obj = Readonly<Record<string, unknown>>

function object(value: unknown): Obj | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : null
}

/** The message as an object of this protocol with exactly these keys (optional ones may be absent), or null. */
function shaped(value: unknown, type: string, required: readonly string[], optional: readonly string[] = []) {
  const o = object(value)
  if (o === null || o.p !== PROTOCOL || o.type !== type) return null
  const keys = Object.keys(o)
  for (const key of keys)
    if (key !== 'p' && key !== 'type' && !required.includes(key) && !optional.includes(key)) return null
  for (const key of required) if (!(key in o)) return null
  return o
}

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

function optionalText(o: Obj, key: string, max: number): boolean {
  return !(key in o) || text(o[key], max)
}

function int(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

/** Whether a file name is a plain, safe segment. */
export function isFileName(name: unknown): name is string {
  return typeof name === 'string' && FILE_NAME.test(name) && !name.includes('..')
}

export function isRunId(id: unknown): id is string {
  return typeof id === 'string' && ID.test(id)
}

function files(value: unknown): value is readonly WireFile[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return false
  return value.every((f) => {
    const o = object(f)
    return (
      o !== null &&
      Object.keys(o).length === 3 &&
      isFileName(o.name) &&
      typeof o.mediaType === 'string' &&
      MEDIA_TYPE.test(o.mediaType) &&
      o.data instanceof ArrayBuffer
    )
  })
}

function names(value: unknown, pattern: RegExp): value is readonly string[] {
  return (
    Array.isArray(value) && value.length <= MAX_ITEMS && value.every((v) => typeof v === 'string' && pattern.test(v))
  )
}

function language(value: unknown): value is SandboxLanguage {
  return value === 'javascript' || value === 'python'
}

/** Limits within MAX_LIMITS, every one a positive integer. */
export function isLimits(value: unknown): value is SandboxLimits {
  const o = object(value)
  if (o === null || Object.keys(o).length !== 5) return false
  return (Object.keys(MAX_LIMITS) as (keyof SandboxLimits)[]).every((k) => int(o[k], 1, MAX_LIMITS[k]))
}

function assets(value: unknown, withHash: boolean): boolean {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return false
  return value.every((a) => {
    const o = object(a)
    if (o === null || !(typeof o.name === 'string' && ASSET_NAME.test(o.name)) || o.name.includes('..')) return false
    const keys = Object.keys(o)
    if (withHash) {
      return (
        typeof o.sha256 === 'string' &&
        HEX64.test(o.sha256) &&
        (!('data' in o) || o.data instanceof ArrayBuffer) &&
        keys.every((k) => k === 'name' || k === 'sha256' || k === 'data')
      )
    }
    return o.data instanceof ArrayBuffer && keys.length === 2
  })
}

function resultBody(value: unknown): value is WireRunResult {
  const o = object(value)
  if (o === null) return false
  const allowed = [
    'status',
    'stdout',
    'stderr',
    'truncated',
    'value',
    'error',
    'files',
    'images',
    'packages',
    'durationMs',
  ]
  if (!Object.keys(o).every((k) => allowed.includes(k))) return false
  return (
    STATUSES.includes(o.status as RunStatus) &&
    text(o.stdout, MAX_TEXT) &&
    text(o.stderr, MAX_TEXT) &&
    typeof o.truncated === 'boolean' &&
    optionalText(o, 'value', MAX_TEXT) &&
    optionalText(o, 'error', MAX_TEXT) &&
    files(o.files) &&
    files(o.images) &&
    names(o.packages, PACKAGE) &&
    int(o.durationMs, 0, 24 * 3600 * 1000)
  )
}

/** A message the runner frame accepts from the app. */
export function parseToRunner(value: unknown): ToRunner | null {
  const run = shaped(value, 'run', ['id', 'language', 'code', 'files', 'assets', 'packages', 'limits'])
  if (run !== null) {
    const ok =
      isRunId(run.id) &&
      language(run.language) &&
      text(run.code, MAX_CODE_CHARS) &&
      files(run.files) &&
      assets(run.assets, true) &&
      names(run.packages, PACKAGE) &&
      isLimits(run.limits)
    return ok ? (run as unknown as RunMessage) : null
  }
  const cancel = shaped(value, 'cancel', ['id'])
  return cancel !== null && isRunId(cancel.id) ? (cancel as unknown as CancelMessage) : null
}

function ready(value: unknown, frame: 'runner' | 'artifact'): ReadyMessage | null {
  const o = shaped(value, 'ready', ['frame'])
  return o !== null && o.frame === frame ? (o as unknown as ReadyMessage) : null
}

/** A message the app accepts from a runner frame. */
export function parseFromRunner(value: unknown): FromRunner | null {
  const r = ready(value, 'runner')
  if (r !== null) return r
  const o = shaped(value, 'result', ['id', 'result'])
  return o !== null && isRunId(o.id) && resultBody(o.result) ? (o as unknown as ResultMessage) : null
}

/** A message the artifact frame accepts from the app. */
export function parseToArtifact(value: unknown): ToArtifact | null {
  const o = shaped(value, 'render', ['id', 'kind', 'source', 'run', 'theme', 'assets'])
  if (o === null) return null
  const ok =
    isRunId(o.id) &&
    KINDS.includes(o.kind as ArtifactKind) &&
    text(o.source, MAX_ARTIFACT_CHARS) &&
    typeof o.run === 'boolean' &&
    (o.theme === 'light' || o.theme === 'dark') &&
    assets(o.assets, true)
  return ok ? (o as unknown as RenderMessage) : null
}

/** A message the app accepts from an artifact frame. */
export function parseFromArtifact(value: unknown): FromArtifact | null {
  const r = ready(value, 'artifact')
  if (r !== null) return r
  const rendered = shaped(value, 'rendered', ['id', 'height'])
  if (rendered !== null)
    return isRunId(rendered.id) && int(rendered.height, 0, MAX_HEIGHT) ? (rendered as unknown as RenderedMessage) : null
  const height = shaped(value, 'height', ['id', 'height'])
  if (height !== null)
    return isRunId(height.id) && int(height.height, 0, MAX_HEIGHT) ? (height as unknown as HeightMessage) : null
  const failed = shaped(value, 'failed', ['id', 'message'])
  if (failed !== null)
    return isRunId(failed.id) && text(failed.message, 2000) ? (failed as unknown as FailedMessage) : null
  return null
}

/** A message a worker accepts from its frame. */
export function parseToWorker(value: unknown): ToWorker | null {
  const o = shaped(value, 'start', ['language', 'code', 'files', 'assets', 'packages', 'limits'])
  if (o === null) return null
  const ok =
    language(o.language) &&
    text(o.code, MAX_CODE_CHARS) &&
    files(o.files) &&
    assets(o.assets, false) &&
    names(o.packages, PACKAGE) &&
    isLimits(o.limits)
  return ok ? (o as unknown as StartMessage) : null
}

/** A message a frame accepts from its worker. Output text is capped by the frame, not here (it arrives in pieces). */
export function parseFromWorker(value: unknown): FromWorker | null {
  const out = shaped(value, 'out', ['stream', 'text'])
  if (out !== null)
    return (out.stream === 'stdout' || out.stream === 'stderr') && text(out.text, MAX_TEXT)
      ? (out as unknown as OutMessage)
      : null
  const done = shaped(value, 'done', ['status', 'files', 'images', 'packages'], ['value', 'error'])
  if (done === null) return null
  const ok =
    (done.status === 'ok' || done.status === 'error' || done.status === 'memory') &&
    optionalText(done, 'value', MAX_TEXT) &&
    optionalText(done, 'error', MAX_TEXT) &&
    files(done.files) &&
    files(done.images) &&
    names(done.packages, PACKAGE)
  return ok ? (done as unknown as DoneMessage) : null
}

/** A text cut to `max` characters, keeping its start and its end, and whether it was cut. */
export function capText(value: string, max: number): { readonly text: string; readonly cut: boolean } {
  if (value.length <= max) return { text: value, cut: false }
  const marker = `\n… ${value.length - max} characters cut …\n`
  const keep = Math.max(0, max - marker.length)
  const head = Math.ceil(keep * 0.6)
  return { text: value.slice(0, head) + marker + value.slice(value.length - (keep - head)), cut: true }
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  py: 'text/x-python',
  js: 'text/javascript',
  pdf: 'application/pdf',
  zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  parquet: 'application/vnd.apache.parquet',
}

/** The media type a file name suggests; `application/octet-stream` when the extension says nothing. */
export function mediaTypeFor(name: string): string {
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(name)?.[1]?.toLowerCase()
  return (ext === undefined ? undefined : MEDIA_TYPES[ext]) ?? 'application/octet-stream'
}

/** Raster images the interface shows inline and models may read. SVG is shown as an artifact, never as an image. */
export function isRasterImage(mediaType: string): boolean {
  return (
    mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/gif' || mediaType === 'image/webp'
  )
}
