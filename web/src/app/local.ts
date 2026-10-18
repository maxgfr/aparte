/*
 * The on-device runtimes of this page, created on first use: the in-browser model service and its WebLLM worker, the
 * embedding worker, and Chrome's Prompt API. This module is loaded lazily (by the session and the model screen), so
 * none of it weighs on the first paint; the workers themselves are separate chunks fetched only when started.
 */
import { createChromeAiAdapter, createWebllmAdapter } from '../core/ai/local/adapters.ts'
import { CHROME_AI_MODEL, isOnDevice, localModelName, WEBLLM_MODELS } from '../core/ai/local/catalog.ts'
import { connectEmbedder } from '../core/ai/local/embed.ts'
import { connectEngine } from '../core/ai/local/engine.ts'
import { createLocalModels, type LocalModels } from '../core/ai/local/models.ts'
import type { ChatAdapter, ProviderKind } from '../core/contracts/ai.ts'
import type { Embedder, GpuLike, LanguageModelLike } from '../core/contracts/local.ts'
import { createWorker } from '../security/workers.ts'
import transformersWorkerUrl from '../workers/transformers.worker.ts?worker&url'
import webllmWorkerUrl from '../workers/webllm.worker.ts?worker&url'

interface BrowserGlobals {
  readonly navigator?: {
    readonly gpu?: GpuLike
    readonly deviceMemory?: number
    readonly storage?: { estimate(): Promise<{ usage?: number; quota?: number }> }
  }
  readonly caches?: CacheStorage
  readonly LanguageModel?: LanguageModelLike
}

const g = globalThis as unknown as BrowserGlobals

let models: LocalModels | null = null
let embedder: Embedder | null = null

/** The page's in-browser model service. */
export function localModels(): LocalModels {
  models ??= createLocalModels({
    env: () => ({ gpu: g.navigator?.gpu, deviceMemory: g.navigator?.deviceMemory }),
    startEngine: () => connectEngine(createWorker(webllmWorkerUrl, { name: 'webllm' })),
    caches: () => g.caches as never,
    storage: () => g.navigator?.storage as never,
  })
  return models
}

/** The page's embedder (used by retrieval and voice in later milestones). */
export function localEmbedder(): Embedder {
  embedder ??= connectEmbedder(() => createWorker(transformersWorkerUrl, { name: 'transformers' }) as never)
  return embedder
}

/** Chrome's Prompt API, when this browser has it. */
export function promptApi(): LanguageModelLike | undefined {
  return typeof g.LanguageModel?.availability === 'function' ? g.LanguageModel : undefined
}

/** The chat adapter of an on-device kind. */
export function localAdapter(kind: ProviderKind): ChatAdapter | null {
  if (kind === 'webllm') return createWebllmAdapter({ engine: () => localModels().engine() })
  if (kind === 'chrome-ai') return createChromeAiAdapter({ api: promptApi })
  return null
}

/** Stops every on-device engine (on lock): their workers terminate, and nothing of a conversation stays in memory. */
export function releaseLocal(): void {
  models?.release()
  embedder?.dispose()
  embedder = null
}

export { CHROME_AI_MODEL, isOnDevice, localModelName, WEBLLM_MODELS }
