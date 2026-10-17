import { describe, expect, test } from 'bun:test'
import { classifyTrustedTypes, cspRequiresTrustedTypes } from './checks.ts'

describe('classifyTrustedTypes', () => {
  test('enforced needs the API, the policy and the directive', () => {
    expect(classifyTrustedTypes({ api: true, policy: true, required: true })).toBe('enforced')
    expect(classifyTrustedTypes({ api: true, policy: true, required: false })).toBe('available')
    expect(classifyTrustedTypes({ api: true, policy: false, required: true })).toBe('available')
    expect(classifyTrustedTypes({ api: false, policy: false, required: true })).toBe('unsupported')
  })
})

describe('cspRequiresTrustedTypes', () => {
  test('finds the directive among others, in any case', () => {
    expect(
      cspRequiresTrustedTypes("default-src 'none'; require-trusted-types-for 'script'; trusted-types aparte"),
    ).toBe(true)
    expect(cspRequiresTrustedTypes("REQUIRE-TRUSTED-TYPES-FOR   'script'")).toBe(true)
  })

  test('absent, empty or only mentioned elsewhere is not required', () => {
    expect(cspRequiresTrustedTypes(null)).toBe(false)
    expect(cspRequiresTrustedTypes('')).toBe(false)
    expect(cspRequiresTrustedTypes("trusted-types aparte; script-src 'self'")).toBe(false)
    expect(cspRequiresTrustedTypes("script-src 'require-trusted-types-for' 'script'")).toBe(false)
  })
})
