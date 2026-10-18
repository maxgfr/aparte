/*
 * The JavaScript worker of the runner frame, started from a `blob:` URL for one run and terminated after it. It takes
 * one `start` message, removes every network, storage and worker API from its scope (lockdown.ts), then loads the
 * code as the body of an async function from another `blob:` URL and awaits it. It reports what the code printed as
 * it goes and, once the function settles, its value, its error and the files it wrote.
 */
import { MAX_LIMITS } from '../../core/contracts/sandbox.ts'
import {
  type DoneMessage,
  isFileName,
  mediaTypeFor,
  PROTOCOL,
  parseToWorker,
  type WireFile,
} from '../../core/sandbox/protocol.ts'
import { lockDown } from './lockdown.ts'

interface Scope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent) => void) | null
  importScripts(...urls: string[]): void
  [key: string]: unknown
}

const scope = globalThis as unknown as Scope
const post = scope.postMessage.bind(scope)
const load = scope.importScripts.bind(scope)
const MAIN = '__aparteMain'

/** One argument of console.log as text: strings as they are, errors with their stack, the rest as JSON when it can. */
function show(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'function' || typeof value === 'symbol' || value === undefined) return String(value)
  try {
    const json = JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v))
    return json ?? String(value)
  } catch {
    return String(value)
  }
}

/** The returned value as text: JSON when it has one, its string form otherwise; undefined when there is none. */
function returned(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  try {
    return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)) ?? String(value)
  } catch {
    return String(value)
  }
}

function out(stream: 'stdout' | 'stderr', args: readonly unknown[]): void {
  post({ p: PROTOCOL, type: 'out', stream, text: `${args.map(show).join(' ')}\n` })
}

scope.onmessage = (event: MessageEvent) => {
  scope.onmessage = null
  const start = parseToWorker(event.data)
  if (start === null || start.language !== 'javascript') return
  void run(start.code, start.files, start.limits.maxFiles, start.limits.maxFileBytes)
}

async function run(code: string, inputs: readonly WireFile[], maxFiles: number, maxFileBytes: number): Promise<void> {
  const written = new Map<string, Promise<WireFile>>()
  const input = (name: unknown): Uint8Array => {
    const file = inputs.find((f) => f.name === name)
    if (file === undefined) throw new Error(`No input file named ${JSON.stringify(name)}`)
    return new Uint8Array(file.data.slice(0))
  }
  const bytesOf = async (data: unknown): Promise<ArrayBuffer> => {
    if (typeof data === 'string') return new TextEncoder().encode(data).buffer as ArrayBuffer
    if (data instanceof Blob) return data.arrayBuffer()
    if (data instanceof ArrayBuffer) return data.slice(0)
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer
    throw new TypeError('writeFile takes a string, bytes or a Blob')
  }
  const api = {
    readFile: (name: unknown) => input(name),
    readText: (name: unknown) => new TextDecoder().decode(input(name)),
    writeFile: (name: unknown, data: unknown, mediaType?: unknown) => {
      if (!isFileName(name)) throw new TypeError(`Not a plain file name: ${JSON.stringify(name)}`)
      if (!written.has(name) && written.size >= Math.min(maxFiles, MAX_LIMITS.maxFiles))
        throw new RangeError('Too many output files')
      const type =
        typeof mediaType === 'string' && /^[a-z]+\/[a-z0-9.+-]+$/.test(mediaType) ? mediaType : mediaTypeFor(name)
      written.set(
        name,
        bytesOf(data).then((buffer) => {
          if (buffer.byteLength > maxFileBytes) throw new RangeError(`${name} is larger than the file cap`)
          return { name, mediaType: type, data: buffer }
        }),
      )
    },
  }
  const consoleApi = {
    log: (...a: unknown[]) => out('stdout', a),
    info: (...a: unknown[]) => out('stdout', a),
    debug: (...a: unknown[]) => out('stdout', a),
    warn: (...a: unknown[]) => out('stderr', a),
    error: (...a: unknown[]) => out('stderr', a),
  }
  lockDown(scope)
  Object.assign(scope, api)
  scope.console = consoleApi

  let done: Omit<DoneMessage, 'p' | 'type' | 'files' | 'images' | 'packages'>
  try {
    const source = `self.${MAIN} = async function () {\n${code}\n}\n`
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    try {
      load(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const main = scope[MAIN] as () => Promise<unknown>
    delete scope[MAIN]
    const value = returned(await main())
    done = value === undefined ? { status: 'ok' } : { status: 'ok', value }
  } catch (error) {
    done = { status: 'error', error: show(error) }
  }
  const files: WireFile[] = []
  for (const [name, pending] of written) {
    try {
      files.push(await pending)
    } catch (error) {
      out('stderr', [`writeFile(${JSON.stringify(name)}) failed: ${show(error)}`])
    }
  }
  post(
    { p: PROTOCOL, type: 'done', ...done, files, images: [], packages: [] },
    files.map((f) => f.data),
  )
}
