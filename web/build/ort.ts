import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Plugin } from 'vite'

/**
 * The ONNX Runtime binary transformers.js runs on. transformers.js imports `onnxruntime-web/webgpu`, whose glue builds
 * functions from strings (Embind's `emval` method callers), which the CSP forbids; the build aliases it to the
 * WebAssembly-only bundle (`ORT_ALIAS`), which has no such code and a smaller binary. Embeddings run on the CPU.
 */
export const ORT_WASM_FILE = 'ort-wasm-simd-threaded.wasm'

/** The alias that swaps ONNX Runtime's WebGPU bundle for its WebAssembly-only one, in every bundle. */
export const ORT_ALIAS = { find: /^onnxruntime-web\/webgpu$/, replacement: 'onnxruntime-web/wasm' }

/** The installed onnxruntime-web's `dist` directory (the one @huggingface/transformers resolves). */
function ortDist(): string {
  const fromTransformers = createRequire(createRequire(import.meta.url).resolve('@huggingface/transformers'))
  return dirname(fromTransformers.resolve('onnxruntime-web'))
}

/** The binary's bytes and SHA-256 (hex). */
export function ortWasm(): { bytes: Buffer; sha256: string } {
  const bytes = readFileSync(join(ortDist(), ORT_WASM_FILE))
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

/**
 * Self-hosts ONNX Runtime's WebAssembly: the build writes it to `<base>ort/` (never precached: pwa.config.ts ignores
 * `ort/**`), and `__ORT_WASM_SHA256__` carries its digest into the transformers.js worker, which refuses any other
 * bytes. Nothing is fetched from a CDN.
 */
export function ortPlugin(): Plugin {
  const wasm = ortWasm()
  return {
    name: 'aparte:ort',
    config: () => ({
      define: { __ORT_WASM_SHA256__: JSON.stringify(wasm.sha256) },
      resolve: { alias: [ORT_ALIAS] },
    }),
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: `ort/${ORT_WASM_FILE}`, source: wasm.bytes })
    },
  }
}
