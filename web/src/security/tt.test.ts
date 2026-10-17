import { describe, expect, test } from 'bun:test'
import { checkScriptURL, POLICY } from './tt.ts'

const ctx = { href: 'https://maxgfr.github.io/aparte/#/settings', base: '/aparte/' }

describe('checkScriptURL', () => {
  test('names the policy the CSP allows', () => {
    expect(POLICY).toBe('aparte')
  })

  test.each([
    ['/aparte/assets/worker-BX12_a-z.js', 'https://maxgfr.github.io/aparte/assets/worker-BX12_a-z.js'],
    ['/aparte/assets/engine.min.mjs', 'https://maxgfr.github.io/aparte/assets/engine.min.mjs'],
    ['/aparte/sw.js', 'https://maxgfr.github.io/aparte/sw.js'],
    ['sw.js', 'https://maxgfr.github.io/aparte/sw.js'],
    ['assets/a.js', 'https://maxgfr.github.io/aparte/assets/a.js'],
    ['https://maxgfr.github.io/aparte/assets/a.js', 'https://maxgfr.github.io/aparte/assets/a.js'],
  ])('accepts %s', (url, href) => {
    expect(checkScriptURL(url, ctx)).toBe(href)
    expect(checkScriptURL(new URL(url, ctx.href), ctx)).toBe(href)
  })

  test.each([
    ['another origin', 'https://evil.example/aparte/assets/a.js'],
    ['another scheme', 'http://maxgfr.github.io/aparte/assets/a.js'],
    ['a sibling project on the shared origin', 'https://maxgfr.github.io/other/assets/a.js'],
    ['a prefix that is not the base', '/aparte-evil/assets/a.js'],
    ['dot segments out of the base', '/aparte/../other/assets/a.js'],
    ['dot segments out of assets', '/aparte/assets/../evil.js'],
    ['encoded dot segments', '/aparte/assets/%2e%2e/evil.js'],
    ['an encoded slash', '/aparte/assets/a%2fb.js'],
    ['a nested asset path', '/aparte/assets/sub/a.js'],
    ['a non-module asset', '/aparte/assets/a.css'],
    ['a TypeScript source', '/aparte/src/a.ts'],
    ['a query', '/aparte/assets/a.js?v=1'],
    ['an empty query', '/aparte/assets/a.js?'],
    ['a fragment', '/aparte/sw.js#x'],
    ['credentials', 'https://u:p@maxgfr.github.io/aparte/sw.js'],
    ['a data URL', 'data:text/javascript,alert(1)'],
    ['a blob URL', 'blob:https://maxgfr.github.io/0b1c'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a protocol-relative URL', '//evil.example/aparte/sw.js'],
    ['another file at the root', '/aparte/index.js'],
    ['a service worker elsewhere', '/aparte/assets/sw.js.map'],
  ])('refuses %s', (_, url) => {
    expect(() => checkScriptURL(url, ctx)).toThrow(TypeError)
  })

  test('dev accepts Vite source modules with queries, still same-origin under the base', () => {
    const dev = { href: 'http://localhost:5173/aparte/', base: '/aparte/', dev: true }
    expect(checkScriptURL('/aparte/src/x.ts?worker_file&type=module', dev)).toBe(
      'http://localhost:5173/aparte/src/x.ts?worker_file&type=module',
    )
    expect(checkScriptURL('/aparte/dev-sw.js?dev-sw', dev)).toBe('http://localhost:5173/aparte/dev-sw.js?dev-sw')
    expect(() => checkScriptURL('http://127.0.0.1:5173/aparte/sw.js', dev)).toThrow(TypeError)
    expect(() => checkScriptURL('/elsewhere/sw.js', dev)).toThrow(TypeError)
    expect(() => checkScriptURL('/aparte/sw.js#x', dev)).toThrow(TypeError)
  })
})
