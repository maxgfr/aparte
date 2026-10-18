/* Regex rules: placement, order, macros, and invalid or oversized rules left alone. */
import { describe, expect, test } from 'bun:test'
import type { RegexRule } from '../contracts/extras.ts'
import { applyRules, compileRule, MAX_PATTERN, ruleProblem } from './regex.ts'

const rule = (find: string, replace: string, extra: Partial<RegexRule> = {}): RegexRule => ({
  name: 'r',
  find,
  flags: 'g',
  replace,
  placement: 'display',
  enabled: true,
  ...extra,
})

describe('regex rules', () => {
  test('applies enabled rules of the placement, in order, with groups and macros', () => {
    const rules = [
      rule('\\*(\\w+)\\*', '_$1_'),
      rule('hello', 'hi {{user}}', { placement: 'input' }),
      rule('_', '~'),
      rule('x', 'y', { enabled: false }),
    ]
    expect(applyRules('*waves* x', rules, 'display')).toBe('~waves~ x')
    expect(applyRules('hello', rules, 'input', { char: 'C', user: 'Ana' })).toBe('hi Ana')
  })

  test('invalid patterns and flags are skipped, not thrown', () => {
    expect(compileRule({ find: '(', flags: 'g' })).toBeNull()
    expect(compileRule({ find: 'a', flags: 'gy' })).toBeNull()
    expect(compileRule({ find: 'a'.repeat(MAX_PATTERN + 1), flags: '' })).toBeNull()
    expect(ruleProblem({ find: '', flags: '' })).toBe('empty')
    expect(ruleProblem({ find: 'a', flags: 'z' })).toBe('flags')
    expect(ruleProblem({ find: '[', flags: '' })).toBe('pattern')
    expect(ruleProblem({ find: 'a', flags: 'gi' })).toBeNull()
    expect(applyRules('abc', [rule('(', 'x'), rule('b', 'B')], 'display')).toBe('aBc')
  })
})
