/*
 * Runs the in-browser models: WebLLM on WebGPU, off the main thread. The page talks to it through
 * web/src/core/ai/local/engine.ts. `./webllmSetup.ts` is imported first, so the network and the cache are confined
 * before WebLLM evaluates. This worker is the only place WebLLM is bundled; it is never precached.
 */
import './webllmSetup.ts'
import { type AppConfig, type ChatCompletionChunk, MLCEngine, prebuiltAppConfig } from '@mlc-ai/web-llm'
import { modelBaseUrl, pinnedModel, WEBLLM_MODELS } from '../core/ai/local/catalog.ts'
import { type EngineBackend, serveEngine, type WorkerScopeLike } from '../core/ai/local/engine.ts'
import { type EngineChunk, type LoadProgress, LocalModelError } from '../core/contracts/local.ts'
import { downloads } from './webllmSetup.ts'

const pinned = new Set(WEBLLM_MODELS.map((m) => m.id))

/** WebLLM's own records of the pinned models, with their files read at the pinned commits. */
const appConfig: AppConfig = {
  cacheBackend: 'cache',
  model_list: prebuiltAppConfig.model_list
    .filter((r) => pinned.has(r.model_id))
    .map((r) => {
      const m = pinnedModel(r.model_id)
      return m ? { ...r, model: modelBaseUrl(m), model_lib: m.lib.url } : r
    }),
}

let report: (p: LoadProgress) => void = () => {}
const engine = new MLCEngine({
  appConfig,
  initProgressCallback: (p) => report({ fraction: p.progress, text: p.text }),
})
let loaded: string | null = null

const backend: EngineBackend = {
  async load(modelId, download, onProgress) {
    if (!pinned.has(modelId)) throw new LocalModelError('unsupported-model', `${modelId} is not a pinned model`)
    if (loaded === modelId) return
    report = onProgress
    downloads.allowed = download
    try {
      await engine.reload(modelId)
      loaded = modelId
    } finally {
      downloads.allowed = false
      report = () => {}
    }
  },
  async *chat(request, signal): AsyncGenerator<EngineChunk> {
    if (loaded !== request.modelId) throw new LocalModelError('engine', `${request.modelId} is not loaded`)
    const onAbort = () => void engine.interruptGenerate()
    signal.addEventListener('abort', onAbort, { once: true })
    const common = {
      messages: request.messages as never,
      ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.topP === undefined ? {} : { top_p: request.topP }),
      ...(request.presencePenalty === undefined ? {} : { presence_penalty: request.presencePenalty }),
      ...(request.frequencyPenalty === undefined ? {} : { frequency_penalty: request.frequencyPenalty }),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
    }
    try {
      if (request.tools !== undefined && request.tools.length > 0) {
        // WebLLM's function calling (Hermes models) answers in one piece.
        const reply = await engine.chat.completions.create({ ...common, tools: request.tools as never, stream: false })
        const choice = reply.choices[0]
        if (choice?.message.content) yield { type: 'delta', text: choice.message.content }
        const toolCalls = (choice?.message.tool_calls ?? []).map((c) => ({
          id: c.id,
          name: c.function.name,
          arguments: c.function.arguments,
        }))
        yield {
          type: 'done',
          finish: choice?.finish_reason ?? 'stop',
          ...(reply.usage
            ? { usage: { input: reply.usage.prompt_tokens, output: reply.usage.completion_tokens } }
            : {}),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        }
        return
      }
      const stream = await engine.chat.completions.create({
        ...common,
        stream: true,
        stream_options: { include_usage: true },
      })
      let finish = 'stop'
      let usage: { input: number; output: number } | undefined
      for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
        const choice = chunk.choices[0]
        const text = choice?.delta.content
        if (text) yield { type: 'delta', text }
        if (choice?.finish_reason) finish = choice.finish_reason
        if (chunk.usage) usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens }
      }
      yield { type: 'done', finish: signal.aborted ? 'abort' : finish, ...(usage ? { usage } : {}) }
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  },
}

serveEngine(globalThis as unknown as WorkerScopeLike, backend)
