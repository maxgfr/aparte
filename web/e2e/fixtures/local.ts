import { readFileSync } from 'node:fs'
import type { BrowserContext } from '@playwright/test'
import type { PinnedModel } from '../../src/core/contracts/local.ts'

const pins = JSON.parse(
  readFileSync(new URL('../../src/core/ai/local/webllm-models.json', import.meta.url), 'utf8'),
) as { models: PinnedModel[] }

/*
 * The on-device runtimes, played by the test. Browsers under test have no usable GPU and no built-in model, so:
 *
 * - WebGPU is a fake adapter, installed before the app runs (`navigator.gpu`), with the memory of an 8 GiB machine,
 *   and the storage estimate is that of a disk with room for a model (WebKit grants a test profile 1 GB);
 * - the WebLLM worker is replaced at its boundary: the request for the built worker script is answered with a fake
 *   that speaks the same protocol (web/src/core/ai/local/engine.ts). Its "download" writes the model's pinned file
 *   URLs into the app's caches, in WebLLM's layout, so the model screen sees it exactly as it would the real one; its
 *   chat streams a fixed answer with a `<think>` block. Nothing leaves the machine;
 * - Chrome's Prompt API (`LanguageModel`) is a fake that streams a fixed answer.
 */

export const LOCAL_ANSWER = 'The local model answers.'
export const LOCAL_REASONING = 'Thinking on this device.'
export const PROMPT_ANSWER = 'Gemini Nano answers.'

/** What the fake worker needs of each pinned model: where its files live. */
const MODELS = Object.fromEntries(
  pins.models.map((m) => [m.id, { base: `https://huggingface.co/${m.repo}/resolve/${m.commit}/`, lib: m.lib.url }]),
)

/** The fake WebLLM worker (a module worker, plain JavaScript). */
export const FAKE_WEBLLM_WORKER = `
const MODELS = ${JSON.stringify(MODELS)};
const ANSWER = ${JSON.stringify(`<think>${LOCAL_REASONING}</think>\n\n${LOCAL_ANSWER}`)};
const send = (m) => self.postMessage(m);
const open = (scope) => caches.open('aparte-' + scope);
async function present(m) {
  const model = await open('webllm/model');
  return (await model.match(m.base + 'params_shard_0.bin')) !== undefined;
}
async function load(req) {
  const m = MODELS[req.modelId];
  if (!m) throw { name: 'LocalModelError', message: 'not pinned', code: 'unsupported-model' };
  if (await present(m)) return;
  if (!req.download) throw { name: 'LocalModelError', message: 'not downloaded', code: 'not-downloaded' };
  const model = await open('webllm/model');
  await model.put(m.base + 'tensor-cache.json', new Response(JSON.stringify({ records: [
    { dataPath: 'params_shard_0.bin', nbytes: 4000000 }, { dataPath: 'params_shard_1.bin', nbytes: 4000000 } ] })));
  send({ id: req.id, kind: 'progress', progress: { fraction: 0.25, text: 'Fetching param cache[1/2]' } });
  await new Promise((r) => setTimeout(r, 200));
  await model.put(m.base + 'params_shard_1.bin', new Response(new Uint8Array(8)));
  send({ id: req.id, kind: 'progress', progress: { fraction: 0.75, text: 'Fetching param cache[2/2]' } });
  await (await open('webllm/config')).put(m.base + 'mlc-chat-config.json', new Response('{}'));
  await (await open('webllm/wasm')).put(m.lib, new Response(new Uint8Array(8)));
  await model.put(m.base + 'params_shard_0.bin', new Response(new Uint8Array(8)));
  send({ id: req.id, kind: 'progress', progress: { fraction: 1, text: 'Loaded' } });
}
self.addEventListener('message', async (event) => {
  const req = event.data;
  if (!req || typeof req.id !== 'number') return;
  try {
    if (req.op === 'load') {
      await load(req);
      send({ id: req.id, kind: 'loaded' });
    } else if (req.op === 'chat') {
      self.lastChat = req.request;
      for (let i = 0; i < ANSWER.length; i += 6) {
        send({ id: req.id, kind: 'chunk', chunk: { type: 'delta', text: ANSWER.slice(i, i + 6) } });
        await new Promise((r) => setTimeout(r, 5));
      }
      send({ id: req.id, kind: 'chunk', chunk: { type: 'done', finish: 'stop', usage: { input: 12, output: 9 } } });
    }
  } catch (error) {
    send({ id: req.id, kind: 'error', error: { name: error.name || 'Error', message: String(error.message), code: error.code } });
  }
});
`

/** Installs the fake WebGPU adapter and serves the fake worker in place of the built one. */
export async function playWebllm(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const GiB = 1024 ** 3
    const adapter = {
      limits: { maxBufferSize: 4 * GiB, maxStorageBufferBindingSize: 2 * GiB, maxComputeWorkgroupStorageSize: 32768 },
      features: new Set(['shader-f16']),
      info: { vendor: 'e2e' },
    }
    const gpu = { requestAdapter: async () => adapter }
    Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => gpu })
    Object.defineProperty(Navigator.prototype, 'deviceMemory', { configurable: true, get: () => 8 })
    // Insecure documents (about:blank) have no StorageManager.
    if (typeof StorageManager !== 'undefined') {
      const estimate = StorageManager.prototype.estimate
      StorageManager.prototype.estimate = async function () {
        const real = await estimate.call(this)
        return { usage: real.usage ?? 0, quota: 64 * GiB }
      }
    }
  })
  await context.route(/\/assets\/webllm\.worker-[\w-]+\.js$/, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: FAKE_WEBLLM_WORKER }),
  )
}

/** Installs a fake Prompt API whose model is available and streams `PROMPT_ANSWER`. */
export async function playPromptApi(context: BrowserContext): Promise<void> {
  await context.addInitScript((answer: string) => {
    const LanguageModel = {
      availability: async () => 'available',
      create: async (options: { initialPrompts?: unknown[] }) => {
        ;(window as unknown as { __promptCreated: unknown[] }).__promptCreated ??= []
        ;(window as unknown as { __promptCreated: unknown[] }).__promptCreated.push(options.initialPrompts ?? [])
        return {
          promptStreaming: () =>
            new ReadableStream<string>({
              start(controller) {
                for (const piece of answer.split(' ')) controller.enqueue(`${piece} `)
                controller.close()
              },
            }),
          destroy: () => {},
        }
      },
    }
    Object.defineProperty(window, 'LanguageModel', { configurable: true, value: LanguageModel })
  }, PROMPT_ANSWER)
}
