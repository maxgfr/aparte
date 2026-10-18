/*
 * The sandbox tools of the registry (contracts/tools.ts, source `sandbox`):
 *
 *   run_js      JavaScript in a worker of the runner frame
 *   run_python  Python (Pyodide) in a worker of the runner frame, packages from the pinned distribution
 *
 * Invariants:
 * - Both change things (they compute and write files) but never reach the network: `readOnly: false`,
 *   `destructive: false`, `openWorld: false`. Being sandbox tools they never run unasked (core/tools/policy.ts): every
 *   call waits for the user's approval unless the user allowed this definition for the chat or always.
 * - The code, the files it reads and what it returns are untrusted. The result goes back to the model as JSON and as
 *   image and file content, which the controller stores as encrypted blobs; nothing of it is interpreted here.
 * - The descriptions are written for the model and are part of each tool's fingerprint.
 */
import type { JsonValue } from '../contracts/crypto.ts'
import {
  DEFAULT_LIMITS,
  MAX_LIMITS,
  type RunResult,
  type SandboxFile,
  type SandboxLanguage,
  type SandboxRunner,
} from '../contracts/sandbox.ts'
import type { Tool, ToolContent, ToolResult } from '../contracts/tools.ts'
import type { Id } from '../contracts/workspace.ts'
import { isRasterImage } from './protocol.ts'
import { PYODIDE_VERSION } from './runtimes.ts'

/** A file of the conversation a run may read: a photo or file of a message, or a file an earlier run returned. */
export interface ConversationFile {
  readonly name: string
  readonly mediaType: string
  readonly size: number
  /** The bytes, or null when this device does not have them. */
  read(): Promise<Uint8Array | null>
}

export interface SandboxToolDeps {
  readonly runner: SandboxRunner
  /** The files of a conversation, by name; without it no input file can be named. */
  readonly files?: (conversationId: Id) => Promise<readonly ConversationFile[]>
}

const MAX_TIMEOUT_SECONDS = MAX_LIMITS.timeoutMs / 1000

const filesProperty = {
  type: 'array',
  items: { type: 'string' },
  description: 'Names of files of this conversation (attached by the user or returned by an earlier run) to provide.',
} as const

const timeoutProperty = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_TIMEOUT_SECONDS,
  description: `Time limit in seconds (default ${DEFAULT_LIMITS.timeoutMs / 1000}).`,
} as const

const failure = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true })

function abortError(): Error {
  const error = new Error('The tool was stopped')
  error.name = 'AbortError'
  return error
}

interface Input {
  readonly code: string
  readonly files: readonly string[]
  readonly packages: readonly string[]
  readonly timeoutMs: number
}

function readInput(input: unknown, python: boolean): Input | string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'The arguments must be an object.'
  const o = input as Record<string, unknown>
  if (typeof o.code !== 'string' || o.code.trim() === '') return 'Missing "code": the source to run.'
  const list = (key: string): string[] | string => {
    const v = o[key]
    if (v === undefined || v === null) return []
    if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return `"${key}" must be a list of strings.`
    return [...new Set(v as string[])]
  }
  const files = list('files')
  if (typeof files === 'string') return files
  const packages = python ? list('packages') : []
  if (typeof packages === 'string') return packages
  let timeoutMs = DEFAULT_LIMITS.timeoutMs
  if (o.timeout_seconds !== undefined && o.timeout_seconds !== null) {
    const t = o.timeout_seconds
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 1 || t > MAX_TIMEOUT_SECONDS)
      return `"timeout_seconds" must be a number from 1 to ${MAX_TIMEOUT_SECONDS}.`
    timeoutMs = Math.round(t * 1000)
  }
  return { code: o.code, files, packages, timeoutMs }
}

/** The files named, read from the conversation; a message for the model when one is missing. */
async function inputFiles(
  deps: SandboxToolDeps,
  conversationId: Id,
  names: readonly string[],
): Promise<SandboxFile[] | string> {
  if (names.length === 0) return []
  const available = (await deps.files?.(conversationId)) ?? []
  const out: SandboxFile[] = []
  const missing: string[] = []
  for (const name of names) {
    const file = available.find((f) => f.name === name)
    const data = file === undefined ? null : await file.read()
    if (file === undefined || data === null) missing.push(name)
    else out.push({ name: file.name, mediaType: file.mediaType, data: new Uint8Array(data) })
  }
  if (missing.length === 0) return out
  const known = available.map((f) => f.name)
  return `No file named ${missing.map((n) => JSON.stringify(n)).join(', ')} in this conversation.${
    known.length > 0 ? ` Available: ${known.map((n) => JSON.stringify(n)).join(', ')}.` : ' It has no files.'
  }`
}

const STATUS_TEXT: Readonly<Record<RunResult['status'], string>> = {
  ok: 'The code ran to its end.',
  error: 'The code raised an error.',
  timeout: 'The run was stopped: it reached its time limit.',
  memory: 'The run was stopped: it ran out of memory (its cap).',
  cancelled: 'The run was cancelled.',
  crashed: 'The sandbox stopped unexpectedly.',
  unavailable: 'The runtime could not be loaded on this device (offline, or a download did not match its pinned hash).',
}

/** A run's result as the model reads it: a JSON summary, then each figure and each file. */
export function runResult(language: SandboxLanguage, result: RunResult): ToolResult {
  const summary: Record<string, JsonValue> = { status: result.status, note: STATUS_TEXT[result.status] }
  if (result.stdout !== '') summary.stdout = result.stdout
  if (result.stderr !== '') summary.stderr = result.stderr
  if (result.value !== undefined) summary.value = result.value
  if (result.error !== undefined) summary.error = result.error
  if (result.truncated) summary.truncated = true
  if (result.files.length > 0)
    summary.files = result.files.map((f) => ({ name: f.name, mediaType: f.mediaType, bytes: f.data.length }))
  if (result.images.length > 0) summary.figures = result.images.map((f) => f.name)
  if (result.packages.length > 0) summary.packages = [...result.packages]
  const content: ToolContent[] = [{ type: 'json', value: summary }]
  for (const image of result.images) content.push({ type: 'image', data: image.data, mediaType: image.mediaType })
  for (const file of result.files) {
    if (isRasterImage(file.mediaType)) content.push({ type: 'image', data: file.data, mediaType: file.mediaType })
    else content.push({ type: 'file', data: file.data, mediaType: file.mediaType, name: file.name })
  }
  return {
    content,
    ...(result.status === 'ok' ? {} : { isError: true }),
    details: { sandbox: { language, status: result.status, durationMs: result.durationMs } },
  }
}

function sandboxTool(
  deps: SandboxToolDeps,
  spec: Pick<Tool, 'name' | 'title' | 'description' | 'inputSchema' | 'origin'>,
  language: SandboxLanguage,
): Tool {
  return {
    ...spec,
    annotations: { readOnly: false, destructive: false, openWorld: false },
    source: 'sandbox',
    async execute(input, context) {
      const parsed = readInput(input, language === 'python')
      if (typeof parsed === 'string') return failure(parsed)
      const files = await inputFiles(deps, context.conversationId, parsed.files)
      if (context.signal.aborted) throw abortError()
      if (typeof files === 'string') return failure(files)
      try {
        const result = await deps.runner.run(
          {
            language,
            code: parsed.code,
            files,
            ...(parsed.packages.length > 0 ? { packages: parsed.packages } : {}),
            limits: { timeoutMs: parsed.timeoutMs },
          },
          context.signal,
        )
        return runResult(language, result)
      } catch (error) {
        if (context.signal.aborted) throw abortError()
        return failure(`The run was refused: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

export function runJsTool(deps: SandboxToolDeps): Tool {
  return sandboxTool(
    deps,
    {
      name: 'run_js',
      origin: 'javascript',
      description:
        "Runs JavaScript in an isolated sandbox on the user's device (a Web Worker with no network, no storage and no access to the app or the page) and returns what it printed, its return value and the files it wrote. The code is the body of an async function: use await, and return a value to get it back as JSON. console.log, info, warn and error print. Input files: readText(name) returns a string, readFile(name) a Uint8Array. Output files: writeFile(name, data, mediaType?) with a string, bytes or a Blob; images (.png, .svg) are shown to the user. There is no DOM, no fetch and no import of packages.",
      inputSchema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'The body of an async function, for example: return [1, 2, 3].map((x) => x * 2)',
          },
          files: filesProperty,
          timeout_seconds: timeoutProperty,
        },
        required: ['code'],
        additionalProperties: false,
      },
    },
    'javascript',
  )
}

export function runPythonTool(deps: SandboxToolDeps): Tool {
  return sandboxTool(
    deps,
    {
      name: 'run_python',
      origin: 'python',
      description: `Runs Python 3.13 (Pyodide ${PYODIDE_VERSION}) in an isolated sandbox on the user's device, with no network and no access to the app or to other chats, and returns stdout, stderr, the repr of the last expression and the files it wrote. Packages: the standard library plus numpy, pandas, matplotlib and the other packages of the Pyodide distribution, loaded from the imports or from "packages" (pip and downloads are not available). Input files are in the working directory; files the code writes there are returned to the user. matplotlib figures left open are returned as PNG images. Large packages take a while to load the first time, and memory is limited on phones.`,
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Python source; the value of its last expression is returned.' },
          packages: {
            type: 'array',
            items: { type: 'string' },
            description: 'Pyodide packages to load besides those the imports name, such as "scikit-learn".',
          },
          files: filesProperty,
          timeout_seconds: timeoutProperty,
        },
        required: ['code'],
        additionalProperties: false,
      },
    },
    'python',
  )
}

/** Both sandbox tools, in name order. */
export function sandboxTools(deps: SandboxToolDeps): Tool[] {
  return [runJsTool(deps), runPythonTool(deps)]
}
