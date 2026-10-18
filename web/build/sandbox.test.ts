import { describe, expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { parsePolicy, sandboxPolicy } from '../src/security/policy.ts'
import { bundleSandbox, SANDBOX_CSP_PLACEHOLDER, SANDBOX_SCRIPT_PLACEHOLDER, sandboxPage } from './sandbox.ts'

const site = { origin: 'https://maxgfr.github.io', base: '/aparte/' }
const root = fileURLToPath(new URL('..', import.meta.url))

describe('sandboxPage', () => {
  test('fills the policy and the script URL, and refuses a template without them', () => {
    const template = `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP_PLACEHOLDER}"><script src="${SANDBOX_SCRIPT_PLACEHOLDER}"></script>`
    const page = sandboxPage(template, 'runner', site)
    expect(page).toContain('src="https://maxgfr.github.io/aparte/sandbox/runner.js"')
    expect(page).toContain(sandboxPolicy('runner', site))
    expect(() => sandboxPage('<p>no policy</p>', 'runner', site)).toThrow(SANDBOX_CSP_PLACEHOLDER)
    expect(() => sandboxPage(`<meta content="${SANDBOX_CSP_PLACEHOLDER}">`, 'artifact', site)).toThrow(
      SANDBOX_SCRIPT_PLACEHOLDER,
    )
  })
})

describe('bundleSandbox', () => {
  test('builds each page and a classic script for it, with the app origin baked in', async () => {
    const files = await bundleSandbox({ ...site, root })
    expect([...files.keys()].sort()).toEqual(['artifact.html', 'artifact.js', 'runner.html', 'runner.js'])
    for (const page of ['runner', 'artifact'] as const) {
      const html = files.get(`${page}.html`) ?? ''
      const meta = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? ''
      expect(parsePolicy(meta.replaceAll('&amp;', '&'))).toEqual(parsePolicy(sandboxPolicy(page, site)))
      // The policy comes first, before the one script, which is the page's own.
      expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'))
      expect([...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])).toEqual([
        `<script src="https://maxgfr.github.io/aparte/sandbox/${page}.js">`,
      ])
      expect(html).not.toMatch(/\son[a-z]+=/i)
      const js = files.get(`${page}.js`) ?? ''
      // A classic script: nothing imported or exported at run time.
      expect(js).not.toMatch(/^\s*(?:import|export)\s/m)
      expect(js).toMatch(/["'`]https:\/\/maxgfr\.github\.io["'`]/)
    }
    // The runner carries both worker scripts as text.
    expect(files.get('runner.js')).toContain('_aparte_run')
    expect(files.get('runner.js')).toContain('__aparteMain')
  }, 60_000)
})
