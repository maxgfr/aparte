import { describe, expect, test } from 'bun:test'
import {
  contentSecurityPolicy,
  parsePolicy,
  SANDBOX_PAGES,
  sandboxPolicy,
  sandboxScriptURL,
  securityHeaders,
  workerHeaders,
} from './policy.ts'

const site = { origin: 'https://maxgfr.github.io', base: '/aparte/' }
const app = 'https://maxgfr.github.io/aparte/'
const connect = ["'self'", 'https:', 'http://localhost:*', 'http://127.0.0.1:*']

describe('contentSecurityPolicy (production)', () => {
  const raw = contentSecurityPolicy(site)
  const csp = parsePolicy(raw)

  test('has exactly the expected directives, in order', () => {
    expect([...csp.keys()]).toEqual([
      'default-src',
      'script-src',
      'style-src',
      'font-src',
      'manifest-src',
      'worker-src',
      'img-src',
      'media-src',
      'connect-src',
      'frame-src',
      'object-src',
      'base-uri',
      'form-action',
      'require-trusted-types-for',
      'trusted-types',
    ])
  })

  test('restricts code to the app path, never the whole shared origin', () => {
    expect(csp.get('default-src')).toEqual(["'none'"])
    expect(csp.get('script-src')).toEqual([app, "'wasm-unsafe-eval'"])
    expect(csp.get('style-src')).toEqual([app])
    expect(csp.get('font-src')).toEqual([app])
    expect(csp.get('manifest-src')).toEqual([app])
    expect(csp.get('worker-src')).toEqual([app, 'blob:'])
    expect(csp.get('frame-src')).toEqual([`${app}sandbox/`])
  })

  test('never allows inline code or JavaScript evaluation', () => {
    expect(raw).not.toContain("'unsafe-inline'")
    expect(raw).not.toContain("'unsafe-eval'")
    expect(raw).not.toContain("'unsafe-hashes'")
    expect(raw).not.toContain('*.')
    expect(raw).not.toContain('ws:')
  })

  test('keeps the strict defaults', () => {
    expect(csp.get('img-src')).toEqual(["'self'", 'blob:', 'data:'])
    expect(csp.get('media-src')).toEqual(["'self'", 'blob:'])
    expect(csp.get('connect-src')).toEqual(connect)
    expect(csp.get('object-src')).toEqual(["'none'"])
    expect(csp.get('base-uri')).toEqual(["'none'"])
    expect(csp.get('form-action')).toEqual(["'none'"])
  })

  test('requires Trusted Types and allows only the two named policies', () => {
    expect(csp.get('require-trusted-types-for')).toEqual(["'script'"])
    expect(csp.get('trusted-types')).toEqual(['aparte', 'dompurify'])
    expect(raw).not.toContain("'allow-duplicates'")
    expect(csp.get('trusted-types')).not.toContain('default')
  })

  test('adds frame-ancestors only as a header', () => {
    expect(csp.has('frame-ancestors')).toBe(false)
    const header = parsePolicy(contentSecurityPolicy({ ...site, header: true }))
    expect(header.get('frame-ancestors')).toEqual(["'none'"])
    expect(raw).toBe(contentSecurityPolicy({ ...site, header: false }))
  })

  test('follows the configured origin and base', () => {
    const local = parsePolicy(contentSecurityPolicy({ origin: 'http://localhost:4173', base: '/x/y/' }))
    expect(local.get('script-src')).toEqual(['http://localhost:4173/x/y/', "'wasm-unsafe-eval'"])
    expect(local.get('frame-src')).toEqual(['http://localhost:4173/x/y/sandbox/'])
  })
})

describe('contentSecurityPolicy (dev)', () => {
  const raw = contentSecurityPolicy({ ...site, dev: true })
  const csp = parsePolicy(raw)

  test('relaxes only what the Vite dev server needs', () => {
    expect(csp.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'", "'unsafe-inline'"])
    expect(csp.get('style-src')).toEqual(["'self'", "'unsafe-inline'"])
    expect(csp.get('connect-src')).toEqual([...connect, 'ws://localhost:*', 'ws://127.0.0.1:*'])
    expect(csp.has('require-trusted-types-for')).toBe(false)
    expect(csp.has('trusted-types')).toBe(false)
    expect(raw).not.toContain(app)
    expect(raw).not.toContain("'unsafe-eval'")
  })

  test('keeps the rest of the policy', () => {
    for (const name of ['default-src', 'object-src', 'base-uri', 'form-action']) {
      expect(csp.get(name)).toEqual(parsePolicy(contentSecurityPolicy(site)).get(name) ?? [])
    }
    expect(csp.get('img-src')).toEqual(["'self'", 'blob:', 'data:'])
  })
})

describe('option checks', () => {
  test.each([
    [{ origin: 'https://maxgfr.github.io/', base: '/aparte/' }],
    [{ origin: 'https://maxgfr.github.io/aparte', base: '/aparte/' }],
    [{ origin: 'ftp://maxgfr.github.io', base: '/aparte/' }],
    [{ origin: 'not a url', base: '/aparte/' }],
    [{ origin: 'https://maxgfr.github.io', base: '/aparte' }],
    [{ origin: 'https://maxgfr.github.io', base: 'aparte/' }],
    [{ origin: 'https://maxgfr.github.io', base: "/a'; script-src * /" }],
    [{ origin: 'https://maxgfr.github.io', base: '/a b/' }],
  ])('refuses %p', (o) => {
    expect(() => contentSecurityPolicy(o)).toThrow(TypeError)
    expect(() => workerHeaders(o)).toThrow(TypeError)
  })

  test('accepts the root base', () => {
    expect(parsePolicy(contentSecurityPolicy({ origin: 'https://example.org', base: '/' })).get('script-src')).toEqual([
      'https://example.org/',
      "'wasm-unsafe-eval'",
    ])
  })
})

describe('securityHeaders', () => {
  const headers = securityHeaders(site)

  test('sends the header policy and the isolation headers', () => {
    expect(headers['Content-Security-Policy']).toBe(contentSecurityPolicy({ ...site, header: true }))
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin')
    expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin')
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
    expect(headers['Referrer-Policy']).toBe('no-referrer')
  })

  test('keeps camera and microphone to the app and denies the rest', () => {
    const features = new Map(
      (headers['Permissions-Policy'] ?? '').split(',').map((f) => f.trim().split('=') as [string, string]),
    )
    expect(features.get('camera')).toBe('(self)')
    expect(features.get('microphone')).toBe('(self)')
    for (const denied of ['geolocation', 'payment', 'usb', 'serial', 'bluetooth', 'interest-cohort']) {
      expect(features.get(denied)).toBe('()')
    }
  })
})

describe('workerHeaders', () => {
  test('lets workers import app modules, compile WebAssembly and connect, nothing else', () => {
    const csp = parsePolicy(workerHeaders(site)['Content-Security-Policy'] ?? '')
    expect([...csp.entries()]).toEqual([
      ['default-src', ["'none'"]],
      ['script-src', [app, "'wasm-unsafe-eval'"]],
      ['connect-src', connect],
    ])
    expect(workerHeaders(site)['X-Content-Type-Options']).toBe('nosniff')
  })
})

describe('sandboxPolicy', () => {
  for (const page of ['runner', 'artifact'] as const) {
    const csp = parsePolicy(sandboxPolicy(page, site))
    test(`${page}: nothing may be fetched, framed, submitted or based elsewhere`, () => {
      expect(csp.get('default-src')).toEqual(["'none'"])
      for (const d of [
        'connect-src',
        'frame-src',
        'child-src',
        'object-src',
        'manifest-src',
        'base-uri',
        'form-action',
      ])
        expect([d, csp.get(d)]).toEqual([d, ["'none'"]])
    })

    test(`${page}: its only script URL is its own built script, exactly`, () => {
      const script = csp.get('script-src') ?? []
      expect(script[0]).toBe(sandboxScriptURL(page, site))
      expect(script[0]).toBe(`${app}sandbox/${page}.js`)
      const hosts = script.filter((s) => !s.startsWith("'"))
      expect(hosts).toEqual([`${app}sandbox/${page}.js`, 'blob:'])
      // No source anywhere names a host but that script: images, styles, fonts and media load from nowhere outside.
      for (const [name, values] of csp)
        if (name !== 'script-src')
          for (const v of values)
            expect([name, v]).toEqual([name, expect.stringMatching(/^(?:'[a-z-]+'|blob:|data:)$/)])
    })
  }

  test('runner: workers from blob: only, no image, style, font or media', () => {
    const csp = parsePolicy(sandboxPolicy('runner', site))
    expect(csp.get('worker-src')).toEqual(['blob:'])
    for (const d of ['img-src', 'style-src', 'font-src', 'media-src']) expect(csp.get(d)).toEqual(["'none'"])
  })

  test('artifact: no worker; images, fonts and media from blob: or data: only', () => {
    const csp = parsePolicy(sandboxPolicy('artifact', site))
    expect(csp.get('worker-src')).toEqual(["'none'"])
    expect(csp.get('img-src')).toEqual(['blob:', 'data:'])
    expect(csp.get('font-src')).toEqual(['data:'])
  })

  test('the app policy itself is unchanged: it frames the sandbox path only', () => {
    expect(parsePolicy(contentSecurityPolicy(site)).get('frame-src')).toEqual([`${app}sandbox/`])
    expect(SANDBOX_PAGES).toEqual(['runner', 'artifact'])
  })

  test('refuses a bad origin or base', () => {
    expect(() => sandboxPolicy('runner', { origin: 'https://maxgfr.github.io/', base: '/aparte/' })).toThrow()
    expect(() => sandboxPolicy('runner', { origin: 'https://maxgfr.github.io', base: 'aparte' })).toThrow()
  })
})
