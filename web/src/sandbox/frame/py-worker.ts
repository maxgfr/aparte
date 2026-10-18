/*
 * The Python worker of the runner frame, started from a `blob:` URL for one run and terminated after it. Everything it
 * loads arrives in its `start` message: Pyodide's scripts are loaded from `blob:` URLs, and every file Pyodide asks for
 * (its WebAssembly, the standard library, its lock file, the packages) is answered from memory by a `fetch` of its
 * own, the only one left in its scope. Nothing it does reaches the network: the frame's CSP refuses it, and the real
 * network APIs are gone (lockdown.ts).
 *
 * The memory cap is enforced on WebAssembly memory: Emscripten grows its heap from JavaScript
 * (`WebAssembly.Memory.prototype.grow`), so a growth past the cap fails and Python raises MemoryError.
 *
 * The run: input files are written to the working directory (`/home/pyodide`), the packages are loaded, the code runs
 * with `eval_code_async` (top-level await, the value of the last expression), then open matplotlib figures are saved
 * as PNG and the files of the working directory that are new or changed are returned.
 */
import {
  type DoneMessage,
  isFileName,
  mediaTypeFor,
  PROTOCOL,
  parseToWorker,
  type StartMessage,
  type WireFile,
} from '../../core/sandbox/protocol.ts'
import { lockDown } from './lockdown.ts'

interface Scope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent) => void) | null
  importScripts(...urls: string[]): void
  loadPyodide?: (options: Record<string, unknown>) => Promise<Pyodide>
}

interface PyProxyFn {
  (...args: unknown[]): Promise<unknown> | unknown
  destroy(): void
}

interface Pyodide {
  loadPackage(names: readonly string[], options?: Record<string, unknown>): Promise<unknown>
  runPython(code: string): unknown
  FS: {
    writeFile(path: string, data: Uint8Array): void
    readFile(path: string): Uint8Array
    readdir(path: string): string[]
    stat(path: string): { mode: number; size: number }
    isFile(mode: number): boolean
    unlink(path: string): void
  }
}

const scope = globalThis as unknown as Scope
const post = scope.postMessage.bind(scope)
const load = scope.importScripts.bind(scope)
const HOME = '/home/pyodide'
const FIGURES = '/tmp/aparte-figures'
/** Where Pyodide believes its files live; only the in-memory fetch below ever answers for it. */
const INDEX = 'https://pyodide.invalid/'

const DRIVER = `
import sys
from pyodide.code import eval_code_async

async def _aparte_run(code):
    value = await eval_code_async(code, {"__name__": "__main__"}, filename="<run>")
    return None if value is None else repr(value)

def _aparte_figures(folder):
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return 0
    import os
    os.makedirs(folder, exist_ok=True)
    numbers = plt.get_fignums()
    for i, n in enumerate(numbers):
        plt.figure(n).savefig(f"{folder}/figure-{i + 1}.png", format="png", dpi=100, bbox_inches="tight")
    plt.close("all")
    return len(numbers)
`

function text(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  return String(error)
}

function say(stream: 'stdout' | 'stderr', line: string): void {
  post({ p: PROTOCOL, type: 'out', stream, text: `${line}\n` })
}

scope.onmessage = (event: MessageEvent) => {
  scope.onmessage = null
  const start = parseToWorker(event.data)
  if (start === null || start.language !== 'python') return
  void run(start)
}

/** Caps WebAssembly memory growth at `cap` bytes; `hit()` says whether a growth was refused. */
function capMemory(cap: number): { hit(): boolean } {
  let refused = false
  const proto = WebAssembly.Memory.prototype
  const grow = proto.grow
  Object.defineProperty(proto, 'grow', {
    configurable: false,
    writable: false,
    value: function capped(this: WebAssembly.Memory, delta: number): number {
      if (this.buffer.byteLength + delta * 65536 > cap) {
        refused = true
        throw new RangeError('The memory cap of this run is reached')
      }
      return grow.call(this, delta)
    },
  })
  return { hit: () => refused }
}

async function run(start: StartMessage): Promise<void> {
  const memory = capMemory(start.limits.memoryBytes)
  const assets = new Map(start.assets.map((a) => [a.name, a.data]))
  const asset = (name: string): ArrayBuffer => {
    const data = assets.get(name)
    if (data === undefined) throw new Error(`The runtime file ${name} is missing`)
    return data
  }
  const memoryFetch = async (input: unknown): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const name = href.startsWith(INDEX) ? href.slice(INDEX.length).split(/[?#]/)[0] : undefined
    const data = name === undefined ? undefined : assets.get(name)
    if (name === undefined || data === undefined) throw new TypeError('The sandbox has no network')
    assets.delete(name)
    const type = name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream'
    return new Response(data, { status: 200, headers: { 'Content-Type': type } })
  }

  let done: Omit<DoneMessage, 'p' | 'type' | 'files' | 'images'>
  const images: WireFile[] = []
  const files: WireFile[] = []
  let pyodide: Pyodide | null = null
  try {
    for (const name of ['pyodide.asm.js', 'pyodide.js']) {
      const url = URL.createObjectURL(new Blob([asset(name)], { type: 'text/javascript' }))
      try {
        load(url)
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    const loadPyodide = scope.loadPyodide
    if (typeof loadPyodide !== 'function') throw new Error('Pyodide did not load')
    const lockText = new TextDecoder().decode(asset('pyodide-lock.json'))
    lockDown(scope, { fetch: memoryFetch })
    pyodide = await loadPyodide({
      indexURL: INDEX,
      packageBaseUrl: INDEX,
      lockFileContents: JSON.parse(lockText),
      env: { HOME, MPLBACKEND: 'Agg' },
      stdout: (line: string) => say('stdout', line),
      stderr: (line: string) => say('stderr', line),
    })
    const py = pyodide
    if (start.packages.length > 0) {
      await py.loadPackage(start.packages, {
        messageCallback: () => undefined,
        errorCallback: (message: string) => say('stderr', message),
      })
    }
    const inputs = new Map<string, Uint8Array>()
    for (const file of start.files) {
      const bytes = new Uint8Array(file.data)
      py.FS.writeFile(`${HOME}/${file.name}`, bytes)
      inputs.set(file.name, bytes)
    }
    py.runPython(DRIVER)
    const runner = py.runPython('_aparte_run') as PyProxyFn
    try {
      const value = await runner(start.code)
      done =
        typeof value === 'string'
          ? { status: 'ok', value, packages: start.packages }
          : { status: 'ok', packages: start.packages }
    } catch (error) {
      done = { status: memory.hit() ? 'memory' : 'error', error: text(error), packages: start.packages }
    } finally {
      runner.destroy()
    }
    collectFigures(py, images, start.limits.maxFiles)
    collectFiles(py, inputs, files, start.limits.maxFiles, start.limits.maxFileBytes)
  } catch (error) {
    done = { status: memory.hit() ? 'memory' : 'error', error: text(error), packages: start.packages }
  }
  const transfer = [...images, ...files].map((f) => f.data)
  post({ p: PROTOCOL, type: 'done', ...done, files, images }, transfer)
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer
}

function collectFigures(py: Pyodide, images: WireFile[], max: number): void {
  let count = 0
  try {
    const figures = py.runPython('_aparte_figures') as PyProxyFn
    try {
      count = Number(figures(FIGURES))
    } finally {
      figures.destroy()
    }
  } catch (error) {
    say('stderr', `Saving the figures failed: ${text(error)}`)
  }
  for (let i = 1; i <= Math.min(count, max); i++) {
    const path = `${FIGURES}/figure-${i}.png`
    images.push({ name: `figure-${i}.png`, mediaType: 'image/png', data: bufferOf(py.FS.readFile(path)) })
    py.FS.unlink(path)
  }
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** The regular files of the working directory that are new or changed, by name; dot files and folders are left. */
function collectFiles(
  py: Pyodide,
  inputs: ReadonlyMap<string, Uint8Array>,
  files: WireFile[],
  max: number,
  maxBytes: number,
): void {
  for (const name of py.FS.readdir(HOME).sort()) {
    if (files.length >= max) {
      say('stderr', `Only the first ${max} output files are returned.`)
      break
    }
    if (!isFileName(name)) continue
    const path = `${HOME}/${name}`
    const stat = py.FS.stat(path)
    if (!py.FS.isFile(stat.mode)) continue
    if (stat.size > maxBytes) {
      say('stderr', `${name} is larger than the file cap, so it is not returned.`)
      continue
    }
    const bytes = py.FS.readFile(path)
    const before = inputs.get(name)
    if (before !== undefined && same(before, bytes)) continue
    files.push({ name, mediaType: mediaTypeFor(name), data: bufferOf(bytes) })
  }
}
