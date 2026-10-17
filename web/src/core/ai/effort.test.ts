/*
 * The effort scale and how each provider takes it (web/src/core/contracts/ai.ts, EffortModule). The Anthropic rows
 * follow Anthropic's model documentation: Claude 4.7 and later take `low` to `max` including `xhigh`, Claude 4.6 takes
 * `low`, `medium`, `high` and `max`, and older models take a thinking budget. A model nobody documented takes none.
 */
import { describe, expect, test } from 'bun:test'
import type { Effort, EffortModule, ProviderKind } from '../contracts/ai.ts'
import * as effortImpl from './effort.ts'

const E: EffortModule = effortImpl

const LOW_TO_MAX = ['low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly Effort[]

describe('the scale', () => {
  test('lists every level, weakest first', () => {
    expect([...E.EFFORTS]).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('Anthropic', () => {
  test.each([
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'claude-haiku-5-5',
    'claude-fable-5-1',
    'claude-fable-5',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
  ])('%s takes low to max, xhigh included, and never none', (model) => {
    expect([...E.effortLevels('anthropic', model)]).toEqual([...LOW_TO_MAX])
  })

  test('Claude 4.6 has no xhigh', () => {
    expect([...E.effortLevels('anthropic', 'claude-sonnet-4-6')]).toEqual(['low', 'medium', 'high', 'max'])
    expect([...E.effortLevels('anthropic', 'claude-opus-4-6')]).toEqual(['low', 'medium', 'high', 'max'])
  })

  test('a date suffix does not change the answer', () => {
    expect([...E.effortLevels('anthropic', 'claude-sonnet-4-6-20260115')]).toEqual(['low', 'medium', 'high', 'max'])
  })

  test('an undocumented model takes none', () => {
    expect([...E.effortLevels('anthropic', 'claude-unknown-9')]).toEqual([])
    expect([...E.effortLevels('anthropic', 'claude-3-haiku-20240307')]).toEqual([])
  })

  test('Claude 4.7 and later send the level as output_config.effort, xhigh as xhigh', () => {
    for (const level of LOW_TO_MAX) {
      expect(E.effortWire('anthropic', 'claude-opus-5-5', level)).toEqual({
        param: 'output_config.effort',
        value: level,
      })
    }
    expect(E.effortWire('anthropic', 'claude-opus-5-5', 'none')).toBeNull()
    expect(E.effortWire('anthropic', 'claude-opus-5-5', 'minimal')).toBeNull()
    expect(E.effortWire('anthropic', 'claude-sonnet-4-6', 'xhigh')).toBeNull()
    expect(E.effortWire('anthropic', 'claude-sonnet-4-6', 'max')).toEqual({
      param: 'output_config.effort',
      value: 'max',
    })
  })

  test('Claude 4.5 takes a thinking budget that grows with the level', () => {
    expect([...E.effortLevels('anthropic', 'claude-haiku-4-5')]).toEqual(['low', 'medium', 'high'])
    const budgets = (['low', 'medium', 'high'] as const).map((level) => {
      const wire = E.effortWire('anthropic', 'claude-haiku-4-5', level)
      if (wire?.param !== 'thinking.budget_tokens') throw new Error(`unexpected wire ${JSON.stringify(wire)}`)
      return wire.value
    })
    for (const b of budgets) {
      expect(Number.isSafeInteger(b)).toBe(true)
      expect(b).toBeGreaterThanOrEqual(1024)
      expect(b).toBeLessThan(64_000)
    }
    expect(budgets[0]).toBeLessThan(budgets[1] as number)
    expect(budgets[1]).toBeLessThan(budgets[2] as number)
  })
})

describe('other providers', () => {
  const cases: [ProviderKind, string, Effort[]][] = [
    ['openai', 'gpt-5', ['minimal', 'low', 'medium', 'high']],
    ['openai', 'gpt-5.1', ['none', 'low', 'medium', 'high']],
    ['openai', 'o3', ['low', 'medium', 'high']],
    ['openai', 'gpt-4o', []],
    ['google', 'gemini-3-pro', ['low', 'high']],
    ['google', 'gemini-2.5-flash', ['low', 'medium', 'high']],
    ['google', 'gemini-2.0-flash', []],
    // OpenRouter maps its own `reasoning.effort` scale onto the maker's, which has no `max`.
    ['openrouter', 'anthropic/claude-opus-5-5', ['low', 'medium', 'high', 'xhigh']],
    ['openrouter', 'openai/gpt-5', ['minimal', 'low', 'medium', 'high']],
    ['openrouter', 'claude-opus-5-5', []],
    // A server speaking the same protocol may refuse a parameter it does not know.
    ['openai-compatible', 'deepseek-reasoner', []],
    ['openai-compatible', 'llama-3.3-70b-versatile', []],
    ['mistral', 'mistral-large-latest', []],
  ]
  test.each(cases)('%s %s', (kind, model, levels) => {
    expect([...E.effortLevels(kind, model)]).toEqual(levels)
  })

  test('each provider names its own parameter', () => {
    expect(E.effortWire('openai', 'gpt-5', 'minimal')).toEqual({ param: 'reasoning.effort', value: 'minimal' })
    expect(E.effortWire('openrouter', 'anthropic/claude-opus-5-5', 'xhigh')).toEqual({
      param: 'reasoning.effort',
      value: 'xhigh',
    })
    expect(E.effortWire('openrouter', 'anthropic/claude-opus-5-5', 'max')).toBeNull()
    expect(E.effortWire('google', 'gemini-3-pro', 'high')).toEqual({
      param: 'thinkingConfig.thinkingLevel',
      value: 'high',
    })
    const budget = E.effortWire('google', 'gemini-2.5-flash', 'medium')
    expect(budget?.param).toBe('thinkingConfig.thinkingBudget')
    expect(E.effortWire('openai-compatible', 'deepseek-reasoner', 'high')).toBeNull()
  })
})

describe('usableEffort', () => {
  test('keeps a level the model takes and drops the rest', () => {
    expect(E.usableEffort('xhigh', LOW_TO_MAX)).toBe('xhigh')
    expect(E.usableEffort('xhigh', ['low', 'medium', 'high', 'max'])).toBeNull()
    expect(E.usableEffort(null, LOW_TO_MAX)).toBeNull()
    expect(E.usableEffort(undefined, LOW_TO_MAX)).toBeNull()
    expect(E.usableEffort('low', [])).toBeNull()
  })
})
