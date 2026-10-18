/*
 * Text embeddings and speech recognition with transformers.js, off the main thread (the page sides are
 * web/src/core/ai/local/embed.ts and web/src/core/ai/local/transcribe.ts). ONNX Runtime runs on its WebAssembly
 * backend, single-threaded, from the app's own copy of its binary, which is checked against the digest the build
 * computed before it is compiled. Model files are pinned and hash-checked: the cache transformers.js uses is the
 * verifying one of web/src/core/ai/local/pinnedCache.ts. Started on first use, never precached; each pipeline loads
 * only when first asked for.
 */
import './transformersSetup.ts'
import {
  type AutomaticSpeechRecognitionPipeline,
  env,
  type FeatureExtractionPipeline,
  pipeline,
} from '@huggingface/transformers'
import { type EmbedScopeLike, serveEmbedder } from '../core/ai/local/embed.ts'
import { type CacheStorageLike, pinnedCaches } from '../core/ai/local/pinnedCache.ts'
import { serveTranscriber, type TranscribeScopeLike } from '../core/ai/local/transcribe.ts'
import { LocalModelError } from '../core/contracts/local.ts'
import type { DownloadProgress } from '../core/contracts/media.ts'
import pins from './embedding-pins.json'
import { download, MODEL_DIGESTS, ORT_WASM } from './transformersSetup.ts'
import whisper from './whisper-pins.json'

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

let runtime: Promise<void> | null = null

/** Hands ONNX Runtime its verified binary, once for both pipelines. */
function loadRuntime(): Promise<void> {
  runtime ??= (async () => {
    if (onnx.wasm && onnx.wasm.wasmBinary === undefined) onnx.wasm.wasmBinary = await ortBinary()
  })().catch((e: unknown) => {
    runtime = null
    throw e
  })
  return runtime
}

let extractor: Promise<FeatureExtractionPipeline> | null = null

function load(): Promise<FeatureExtractionPipeline> {
  extractor ??= (async () => {
    await loadRuntime()
    return pipeline('feature-extraction', pins.repo, { revision: pins.commit, dtype: 'q8', device: 'wasm' })
  })().catch((e: unknown) => {
    extractor = null
    throw e
  })
  return extractor
}

let recognizer: Promise<AutomaticSpeechRecognitionPipeline> | null = null
/** Who hears the download progress of the speech model while it loads (the request that started it). */
let onDownload: ((p: DownloadProgress) => void) | null = null

function loadRecognizer(): Promise<AutomaticSpeechRecognitionPipeline> {
  recognizer ??= (async () => {
    await loadRuntime()
    // Bytes per file, summed: transformers.js reports each file of the model separately.
    const files = new Map<string, { loaded: number; total: number }>()
    return pipeline('automatic-speech-recognition', whisper.repo, {
      revision: whisper.commit,
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
        if (info.status !== 'progress' || typeof info.file !== 'string') return
        files.set(info.file, { loaded: info.loaded ?? 0, total: info.total ?? 0 })
        let loaded = 0
        let total = 0
        for (const f of files.values()) {
          loaded += f.loaded
          total += f.total
        }
        onDownload?.({ loaded, total })
      },
    }) as Promise<AutomaticSpeechRecognitionPipeline>
  })().catch((e: unknown) => {
    recognizer = null
    throw e
  })
  return recognizer
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

serveTranscriber(globalThis as unknown as TranscribeScopeLike, {
  async transcribe(audio, onProgress, language) {
    if (audio.length === 0) return ''
    onDownload = onProgress
    try {
      const run = await loadRecognizer()
      // Whisper reads 30-second windows: a longer dictation is cut into overlapping chunks and joined.
      const output = await run(audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        task: 'transcribe',
        ...(language === undefined ? {} : { language }),
      })
      const result = Array.isArray(output) ? output[0] : output
      return typeof result?.text === 'string' ? result.text : ''
    } finally {
      onDownload = null
    }
  },
})
