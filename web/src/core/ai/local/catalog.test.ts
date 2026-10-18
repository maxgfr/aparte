import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import files from '../../../workers/webllm-files.json'
import {
  CHROME_AI_MODEL,
  localCapabilities,
  localModelName,
  modelBaseUrl,
  pinnedModel,
  pinnedUrls,
  WEBLLM_MODELS,
  WEBLLM_VERSION,
} from './catalog.ts'

const HEX40 = /^[0-9a-f]{40}$/
const HEX64 = /^[0-9a-f]{64}$/

describe('pinned WebLLM models', () => {
  test('match the installed WebLLM', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../../node_modules/@mlc-ai/web-llm/package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    expect(WEBLLM_VERSION).toBe(pkg.version)
  })

  test('every file is read at a commit and has a digest', () => {
    expect(WEBLLM_MODELS.length).toBeGreaterThan(0)
    const digests: Record<string, Record<string, string>> = files.files
    for (const m of WEBLLM_MODELS) {
      expect(m.commit).toMatch(HEX40)
      expect(modelBaseUrl(m)).toBe(`https://huggingface.co/${m.repo}/resolve/${m.commit}/`)
      expect(m.lib.url).toMatch(
        /^https:\/\/raw\.githubusercontent\.com\/mlc-ai\/binary-mlc-llm-libs\/[0-9a-f]{40}\/.+\.wasm$/,
      )
      expect(m.lib.sha256).toMatch(HEX64)
      const own = digests[m.id] ?? {}
      expect(Object.keys(own)).toContain('mlc-chat-config.json')
      expect(Object.keys(own)).toContain('tensor-cache.json')
      for (const sha of Object.values(own)) expect(sha).toMatch(HEX64)
      const urls = pinnedUrls(m, own)
      expect(urls.get(m.lib.url)).toBe(m.lib.sha256)
      expect(urls.get(`${modelBaseUrl(m)}mlc-chat-config.json`)).toBe(own['mlc-chat-config.json'] as string)
      for (const url of urls.keys()) expect(url.includes('/resolve/main/')).toBe(false)
    }
  })

  test('each model comes in a build for GPUs without fp16', () => {
    const f16 = WEBLLM_MODELS.filter((m) => m.f16)
    for (const m of f16) expect(pinnedModel(m.id.replace('q4f16_1', 'q4f32_1'))?.f16).toBe(false)
  })

  test('tools only where WebLLM supports function calling', () => {
    const withTools = WEBLLM_MODELS.filter((m) => localCapabilities('webllm', m.id).tools).map((m) => m.id)
    expect(withTools.length).toBeGreaterThan(0)
    for (const id of withTools) expect(id).toStartWith('Hermes-')
  })
})

describe('local capabilities', () => {
  test('text only, no effort, free, reasoning raw where the model thinks', () => {
    const qwen = localCapabilities('webllm', 'Qwen3.5-0.8B-q4f16_1-MLC')
    expect(qwen).toMatchObject({ vision: false, pdf: false, tools: false, reasoning: true, thinkingDisplay: 'raw' })
    expect(qwen.effort.levels).toEqual([])
    expect(qwen.cost).toEqual({ input: 0, output: 0 })
    expect(qwen.maxOutput).toBeLessThan(qwen.contextWindow)
    const unknown = localCapabilities('webllm', 'not-pinned')
    expect(unknown).toMatchObject({ tools: false, reasoning: false, contextWindow: 2048 })
    expect(localCapabilities('chrome-ai', CHROME_AI_MODEL)).toMatchObject({ tools: false, sampling: [] })
  })

  test('names', () => {
    expect(localModelName('webllm', 'Qwen3.5-0.8B-q4f16_1-MLC')).toBe('Qwen3.5 0.8B (q4f16)')
    expect(localModelName('chrome-ai', CHROME_AI_MODEL)).toBe('Gemini Nano')
    expect(localModelName('openai', 'gpt-5')).toBeNull()
  })
})
