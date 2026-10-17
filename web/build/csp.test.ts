import { describe, expect, test } from 'bun:test'
import type { ConfigEnv, IndexHtmlTransformContext, Plugin } from 'vite'
import { contentSecurityPolicy, parsePolicy } from '../src/security/policy.ts'
import { CSP_PLACEHOLDER, cspPlugin, escapeAttribute } from './csp.ts'

const site = { origin: 'https://maxgfr.github.io', base: '/aparte/' }
const html = `<head><meta http-equiv="Content-Security-Policy" content="${CSP_PLACEHOLDER}" /></head>`

type ConfigHook = (config: object, env: ConfigEnv) => unknown
type HtmlHook = (html: string, ctx: IndexHtmlTransformContext) => string

/** Runs the plugin as Vite would for a command, and returns the transformed page. */
function transform(env: ConfigEnv, page = html): string {
  const plugin: Plugin = cspPlugin(site)
  ;(plugin.config as ConfigHook)({}, env)
  const hook = plugin.transformIndexHtml as { order: string; handler: HtmlHook }
  expect(hook.order).toBe('pre')
  return hook.handler(page, { path: '/index.html', filename: '/web/index.html' } as IndexHtmlTransformContext)
}

/** The policy as the browser reads it back from the attribute. */
function metaPolicy(page: string): string {
  const content = /content="([^"]*)"/.exec(page)?.[1] ?? ''
  return content.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
}

describe('cspPlugin', () => {
  test('writes the production policy for vite build', () => {
    const out = transform({ command: 'build', mode: 'production' })
    expect(out).not.toContain(CSP_PLACEHOLDER)
    expect(metaPolicy(out)).toBe(contentSecurityPolicy(site))
    const csp = parsePolicy(metaPolicy(out))
    expect(csp.get('script-src')).toEqual(['https://maxgfr.github.io/aparte/', "'wasm-unsafe-eval'"])
    expect(csp.get('trusted-types')).toEqual(['aparte', 'dompurify'])
  })

  test('keeps the production policy when the config is resolved for vite preview', () => {
    const out = transform({ command: 'serve', mode: 'production', isPreview: true })
    expect(metaPolicy(out)).toBe(contentSecurityPolicy(site))
  })

  test('writes the dev policy only for vite serve', () => {
    const out = transform({ command: 'serve', mode: 'development' })
    expect(metaPolicy(out)).toBe(contentSecurityPolicy({ ...site, dev: true }))
    expect(parsePolicy(metaPolicy(out)).get('script-src')).toContain("'unsafe-inline'")
  })

  test('never puts frame-ancestors in the meta, where browsers ignore it', () => {
    expect(metaPolicy(transform({ command: 'build', mode: 'production' }))).not.toContain('frame-ancestors')
  })

  test('fails the build when the placeholder is missing', () => {
    expect(() => transform({ command: 'build', mode: 'production' }, '<head></head>')).toThrow(CSP_PLACEHOLDER)
  })
})

describe('escapeAttribute', () => {
  test('cannot break out of a double-quoted attribute', () => {
    expect(escapeAttribute(`a"b<c>&d'e`)).toBe(`a&quot;b&lt;c&gt;&amp;d'e`)
  })
})
