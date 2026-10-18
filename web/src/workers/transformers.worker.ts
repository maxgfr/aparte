/*
 * Text embeddings with transformers.js, off the main thread (the page side is web/src/core/ai/local/embed.ts). ONNX
 * Runtime runs on its WebAssembly backend, single-threaded, from the app's own copy of its binary, which is checked
 * against the digest the build computed before it is compiled. Model files are pinned and hash-checked: the cache
 * transformers.js uses is the verifying one of web/src/core/ai/local/pinnedCache.ts. Started on first use, never
 * precached. Speech (M8) will add its pipeline to this worker.
 */
import './transformersSetup.ts'
import { env, type FeatureExtractionPipeline, pipeline } from '@huggingface/transformers'
import { type EmbedScopeLike, serveEmbedder } from '../core/ai/local/embed.ts'
import { type CacheStorageLike, pinnedCaches } from '../core/ai/local/pinnedCache.ts'
import { LocalModelError } from '../core/contracts/local.ts'
import pins from './embedding-pins.json'
import { download, MODEL_DIGESTS, ORT_WASM } from './transformersSetup.ts'

const native = (globalThis as unknown as { caches: CacheStorageLike }).caches
const verified = pinnedCaches(native, {
  digest: (url) => MODEL_DIGESTS.get(url) ?? null,
  download: (url, signal) => download(url, signal ? { signal } : {}),
  allowDownload: () => true,
})

env.allowLocalModels = false
env.useBrowserCache = false
env.useWasmCache = false
env.useCustomCache = true
env.customCache = {
  match: async (key: string) => (await verified.open('transformers')).match(key),
  put: async (key: string, response: Response) => (await verified.open('transformers')).put(key, response),
}
const onnx = env.backends.onnx
if (onnx.wasm) {
  onnx.wasm.numThreads = 1
  onnx.wasm.proxy = false
  // Only the binary is fetched; the JavaScript glue is the one bundled in this worker.
  onnx.wasm.wasmPaths = { wasm: ORT_WASM }
}

/** The ONNX Runtime binary, checked against the build's digest by the confined fetch (transformersSetup.ts). */
async function ortBinary(): Promise<ArrayBuffer> {
  const res = await download(ORT_WASM)
  if (!res.ok) throw new LocalModelError('engine', `ONNX Runtime is missing from the build (HTTP ${res.status})`)
  return res.arrayBuffer()
}

let extractor: Promise<FeatureExtractionPipeline> | null = null

function load(): Promise<FeatureExtractionPipeline> {
  extractor ??= (async () => {
    if (onnx.wasm) onnx.wasm.wasmBinary = await ortBinary()
    return pipeline('feature-extraction', pins.repo, { revision: pins.commit, dtype: 'q8', device: 'wasm' })
  })().catch((e: unknown) => {
    extractor = null
    throw e
  })
  return extractor
}

serveEmbedder(globalThis as unknown as EmbedScopeLike, {
  async embed(texts) {
    if (texts.length === 0) return []
    const run = await load()
    const output = await run([...texts], { pooling: 'mean', normalize: true })
    const [count, dim] = output.dims as [number, number]
    const data = output.data as Float32Array
    return Array.from({ length: count }, (_, i) => data.slice(i * dim, (i + 1) * dim))
  },
})
