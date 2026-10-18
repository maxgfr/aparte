/*
 * The first module the transformers.js worker evaluates: it confines the worker's network before transformers.js and
 * ONNX Runtime load. Admitted: the pinned files of the embedding model on Hugging Face (purpose `download`; a file the
 * pinned repository does not list gets a local 404) and ONNX Runtime's WebAssembly, self-hosted under the app's base
 * (purpose `app`). Nothing else.
 */
import { confineFetch } from '../security/workerNet.ts'
import pins from './embedding-pins.json'

/** SHA-256 (hex) of the ONNX Runtime binary the build copied, computed by vite.config.ts. */
declare const __ORT_WASM_SHA256__: string

/** Where the embedding model's files are read: its repository at the pinned commit. */
export const MODEL_BASE = `https://huggingface.co/${pins.repo}/resolve/${pins.commit}/`

/** Every model file transformers.js may fetch, with its SHA-256. */
export const MODEL_DIGESTS: ReadonlyMap<string, string> = new Map(
  Object.entries(pins.files as Record<string, string>).map(([path, sha]) => [new URL(path, MODEL_BASE).href, sha]),
)

/** ONNX Runtime's WebAssembly, copied into the build at `<base>ort/` by vite.config.ts. */
export const ORT_WASM = new URL(`${import.meta.env.BASE_URL}ort/ort-wasm-simd-threaded.wasm`, globalThis.location.href)
  .href

/** The worker's only network: pinned model files and the app's ONNX Runtime binary. */
export const download = confineFetch((url) => {
  if (url.href === ORT_WASM) return { purpose: 'app', sha256: __ORT_WASM_SHA256__ }
  const sha256 = MODEL_DIGESTS.get(url.href)
  if (sha256 !== undefined) return { purpose: 'download', sha256 }
  if (url.href.startsWith(MODEL_BASE)) return { respond: () => new Response(null, { status: 404 }) }
  return null
})
