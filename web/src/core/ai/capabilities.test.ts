/*
 * Capability resolution (web/src/core/contracts/ai.ts, CapabilitiesModule). The Anthropic table is pinned to
 * Anthropic's documentation: what a request may contain on each current model (sampling, prefill, forced tool choice,
 * effort levels and defaults, mid-conversation system messages, the web search variant, refusal fallbacks, limits and
 * prices). For other providers the catalog decides, with conservative defaults for what it does not say.
 */
import { describe, expect, test } from 'bun:test'
import type { Capabilities, CapabilitiesModule, CatalogModelInfo } from '../contracts/ai.ts'
import * as capabilitiesImpl from './capabilities.ts'

const C: CapabilitiesModule = capabilitiesImpl

const anthropic = (modelId: string): Capabilities => C.resolveCapabilities({ kind: 'anthropic', modelId })

describe('Claude Opus 5.5', () => {
  const c = anthropic('claude-opus-5-5')

  test('effort low to max, explicit default medium, summarized thinking', () => {
    expect(c.reasoning).toBe(true)
    expect([...c.effort.levels]).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(c.effort.default).toBe('medium')
    expect(c.thinkingDisplay).toBe('summarized')
  })

  test('no sampling, no prefill, no forced tool choice', () => {
    expect([...c.sampling]).toEqual([])
    expect(c.prefill).toBe(false)
    expect(c.forcedToolChoice).toBe(false)
  })

  test('mid-conversation system messages and tool changes, dynamic-filtering web search, default fallback', () => {
    expect(c.midConversationSystem).toBe(true)
    expect(c.toolChanges).toBe(true)
    expect(c.webSearch).toBe('anthropic:web_search_20260209')
    expect(c.refusalFallback).toBe('default')
  })

  test('limits and prices', () => {
    expect(c.contextWindow).toBe(1_000_000)
    expect(c.maxOutput).toBe(128_000)
    expect(c.cost).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })
    expect(c.vision).toBe(true)
    expect(c.pdf).toBe(true)
    expect(c.tools).toBe(true)
  })
})

describe('the other current Claude models', () => {
  test('Sonnet 5.5: default high, no sampling, no forced tool choice, default fallback', () => {
    const c = anthropic('claude-sonnet-5-5')
    expect(c.effort.default).toBe('high')
    expect([...c.effort.levels]).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect([...c.sampling]).toEqual([])
    expect(c.forcedToolChoice).toBe(false)
    expect(c.prefill).toBe(false)
    expect(c.midConversationSystem).toBe(true)
    expect(c.refusalFallback).toBe('default')
    expect(c.cost).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 })
  })

  test('Haiku 5.5: default medium, forced tool choice allowed, no server fallback', () => {
    const c = anthropic('claude-haiku-5-5')
    expect(c.effort.default).toBe('medium')
    expect([...c.sampling]).toEqual([])
    expect(c.forcedToolChoice).toBe(true)
    expect(c.prefill).toBe(false)
    expect(c.refusalFallback).toBeNull()
    expect(c.contextWindow).toBe(1_000_000)
  })

  test('Fable 5.1: default high, no forced tool choice, default fallback', () => {
    const c = anthropic('claude-fable-5-1')
    expect(c.effort.default).toBe('high')
    expect(c.forcedToolChoice).toBe(false)
    expect([...c.sampling]).toEqual([])
    expect(c.refusalFallback).toBe('default')
    expect(c.cost?.input).toBe(10)
    expect(c.cost?.output).toBe(50)
  })

  test('Opus 5 keeps forced tool choice; Sonnet 5 has no mid-conversation system messages', () => {
    expect(anthropic('claude-opus-5').forcedToolChoice).toBe(true)
    expect(anthropic('claude-opus-5').refusalFallback).toBe('default')
    expect(anthropic('claude-sonnet-5').midConversationSystem).toBe(false)
    expect(anthropic('claude-sonnet-5').refusalFallback).toBeNull()
    expect([...anthropic('claude-sonnet-5').sampling]).toEqual([])
  })

  test('Opus 4.8 has mid-conversation system messages, Opus 4.7 does not; neither takes sampling', () => {
    expect(anthropic('claude-opus-4-8').midConversationSystem).toBe(true)
    expect(anthropic('claude-opus-4-7').midConversationSystem).toBe(false)
    expect([...anthropic('claude-opus-4-8').sampling]).toEqual([])
    expect([...anthropic('claude-opus-4-7').sampling]).toEqual([])
  })

  test('Claude 4.6 takes sampling but no prefill, and has no xhigh', () => {
    const c = anthropic('claude-sonnet-4-6')
    expect([...c.sampling].sort()).toEqual(['temperature', 'topK', 'topP'])
    expect(c.prefill).toBe(false)
    expect([...c.effort.levels]).toEqual(['low', 'medium', 'high', 'max'])
    expect(c.webSearch).toBe('anthropic:web_search_20260209')
  })

  test('Haiku 4.5 still takes prefill and sampling, with the basic web search and a 200K window', () => {
    const c = anthropic('claude-haiku-4-5')
    expect(c.prefill).toBe(true)
    expect([...c.sampling].sort()).toEqual(['temperature', 'topK', 'topP'])
    expect(c.webSearch).toBe('anthropic:web_search_20250305')
    expect(c.contextWindow).toBe(200_000)
    expect(c.maxOutput).toBe(64_000)
  })

  test('the pinned table names exact ids', () => {
    for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']) {
      expect(C.KNOWN_ANTHROPIC_MODELS.has(id)).toBe(true)
    }
    expect(C.KNOWN_ANTHROPIC_MODELS.has('claude-opus-5-5-20260401')).toBe(false)
  })

  test('the pinned table wins over a catalog that disagrees', () => {
    const catalog: CatalogModelInfo = { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', contextWindow: 200_000 }
    const c = C.resolveCapabilities({ kind: 'anthropic', modelId: 'claude-opus-5-5', catalog })
    expect(c.contextWindow).toBe(1_000_000)
  })
})

describe('unknown and catalog models', () => {
  test('an unknown Claude model gets the conservative surface', () => {
    const c = anthropic('claude-future-9')
    expect([...c.sampling]).toEqual([])
    expect(c.prefill).toBe(false)
    expect(c.forcedToolChoice).toBe(false)
    expect(c.midConversationSystem).toBe(false)
    expect([...c.effort.levels]).toEqual([])
    expect(c.refusalFallback).toBeNull()
  })

  test('an OpenAI-compatible model follows its catalog entry', () => {
    const catalog: CatalogModelInfo = {
      id: 'deepseek-reasoner',
      name: 'DeepSeek Reasoner',
      contextWindow: 128_000,
      maxOutput: 64_000,
      input: ['text'],
      reasoning: true,
      toolCall: true,
      cost: { input: 0.28, output: 0.42 },
    }
    const c = C.resolveCapabilities({ kind: 'openai-compatible', modelId: 'deepseek-reasoner', catalog })
    expect(c.reasoning).toBe(true)
    expect(c.thinkingDisplay).toBe('raw')
    expect(c.vision).toBe(false)
    expect(c.tools).toBe(true)
    expect(c.contextWindow).toBe(128_000)
    expect(c.maxOutput).toBe(64_000)
    expect(c.cost).toEqual({ input: 0.28, output: 0.42 })
    expect([...c.effort.levels]).toEqual([])
    expect(c.midConversationSystem).toBe(false)
    expect(c.toolChanges).toBe(false)
    expect(c.refusalFallback).toBeNull()
  })

  test('image input in the catalog means vision', () => {
    const catalog: CatalogModelInfo = { id: 'gpt-5', name: 'GPT-5', input: ['text', 'image', 'pdf'], reasoning: true }
    const c = C.resolveCapabilities({ kind: 'openai', modelId: 'gpt-5', catalog })
    expect(c.vision).toBe(true)
    expect(c.pdf).toBe(true)
    expect(c.thinkingDisplay).toBe('summarized')
    expect([...c.effort.levels]).toEqual(['minimal', 'low', 'medium', 'high'])
  })

  test('without a catalog entry nothing optional is assumed', () => {
    const c = C.resolveCapabilities({ kind: 'openai-compatible', modelId: 'my-local-model' })
    expect(c.vision).toBe(false)
    expect(c.pdf).toBe(false)
    expect(c.reasoning).toBe(false)
    expect(c.thinkingDisplay).toBeNull()
    expect(c.webSearch).toBeNull()
    expect(c.cost).toBeNull()
    expect(c.contextWindow).toBeGreaterThan(0)
    expect(c.maxOutput).toBeGreaterThan(0)
  })

  test('a user override is applied last', () => {
    const c = C.resolveCapabilities({
      kind: 'openai-compatible',
      modelId: 'my-local-model',
      override: { vision: true, contextWindow: 32_768 },
    })
    expect(c.vision).toBe(true)
    expect(c.contextWindow).toBe(32_768)
  })
})
