/*
 * The first module the transformers.js worker evaluates: it confines the worker's network before transformers.js and
 * ONNX Runtime load. Admitted: the pinned files of the embedding model and of the speech recognition model on Hugging
 * Face (purpose `download`; a file a pinned repository does not list gets a local 404) and ONNX Runtime's WebAssembly,
 * self-hosted under the app's base (purpose `app`). Nothing else.
 *
 * transformers.js asks for some files under the moving `main` revision whatever revision it is given (the file list a
 * pipeline builds, the tokenizer and processor checks): those names are served from the pinned commit, under the same
 * digest, and its one-byte range probes (which only ask whether a file exists) are answered here, from the pins.
 */
import { confineFetch } from '../security/workerNet.ts'
import embedding from './embedding-pins.json'
import whisper from './whisper-pins.json'

/** SHA-256 (hex) of the ONNX Runtime binary the build copied, computed by vite.config.ts. */
declare const __ORT_WASM_SHA256__: string

interface Pins {
  readonly repo: string
  readonly commit: string
  readonly files: Record<string, string>
}

/** Where a model's files are read: its repository at the pinned commit. */
const baseOf = (pins: Pins): string => `https://huggingface.co/${pins.repo}/resolve/${pins.commit}/`

/** The same repository's moving `main` revision, which transformers.js asks for in places. */
const mainOf = (pins: Pins): string => `https://huggingface.co/${pins.repo}/resolve/main/`

/** The embedding model's files. */
export const MODEL_BASE = baseOf(embedding)

/** The speech recognition model's files. */
export const WHISPER_BASE = baseOf(whisper)

const PINNED: readonly Pins[] = [embedding, whisper]
const BASES = PINNED.flatMap((pins) => [baseOf(pins), mainOf(pins)])

/** The pinned URL of each name a model file may be asked under (its pinned name, and its `main` alias). */
const PINNED_URL: ReadonlyMap<string, string> = new Map(
  PINNED.flatMap((pins) =>
    Object.keys(pins.files).flatMap((path) => {
      const pinned = new URL(path, baseOf(pins)).href
      return [
        [pinned, pinned],
        [new URL(path, mainOf(pins)).href, pinned],
      ] as const
    }),
  ),
)

/** Every model file transformers.js may fetch or cache, under each of its names, with its SHA-256. */
export const MODEL_DIGESTS: ReadonlyMap<string, string> = new Map(
  PINNED.flatMap((pins) =>
    Object.entries(pins.files).flatMap(([path, sha]) => [
      [new URL(path, baseOf(pins)).href, sha] as const,
      [new URL(path, mainOf(pins)).href, sha] as const,
    ]),
  ),
)

/** Whether a request only probes for a file (transformers.js sends `Range: bytes=0-0`). */
function isProbe(init: RequestInit | undefined): boolean {
  return new Headers(init?.headers).get('range') === 'bytes=0-0'
}

/** ONNX Runtime's WebAssembly, copied into the build at `<base>ort/` by vite.config.ts. */
export const ORT_WASM = new URL(`${import.meta.env.BASE_URL}ort/ort-wasm-simd-threaded.wasm`, globalThis.location.href)
  .href

/** The worker's only network: pinned model files and the app's ONNX Runtime binary. */
export const download = confineFetch((url, init) => {
  if (url.href === ORT_WASM) return { purpose: 'app', sha256: __ORT_WASM_SHA256__ }
  const sha256 = MODEL_DIGESTS.get(url.href)
  const pinned = PINNED_URL.get(url.href)
  if (sha256 !== undefined && pinned !== undefined) {
    // A probe learns only that the file exists, which the pins say: nothing is fetched for it.
    if (isProbe(init)) return { respond: () => new Response(null, { status: 200 }) }
    return { purpose: 'download', sha256, via: pinned }
  }
  if (BASES.some((base) => url.href.startsWith(base))) return { respond: () => new Response(null, { status: 404 }) }
  return null
})
