/*
 * The OAuth callback page (web/public/oauth-callback.html): its policy allows exactly its own inline script and
 * style, by hash, and the app's icon; its script speaks the protocol of web/src/core/mcp/callback.ts and touches no
 * HTML sink, no storage and no network.
 */
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CALLBACK_TYPE, CHANNEL_PREFIX } from '../src/core/mcp/callback.ts'
import { parsePolicy } from '../src/security/policy.ts'

const page = readFileSync(fileURLToPath(new URL('../public/oauth-callback.html', import.meta.url)), 'utf8')
const one = (re: RegExp): string => {
  const all = [...page.matchAll(re)]
  expect(all).toHaveLength(1)
  return all[0]?.[1] ?? ''
}
const hash = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`

describe('oauth-callback.html', () => {
  const script = one(/<script>([\s\S]*?)<\/script>/g)
  const style = one(/<style>([\s\S]*?)<\/style>/g)
  const policy = parsePolicy(one(/http-equiv="Content-Security-Policy"\s+content="([^"]*)"/g))

  test('its policy allows its own script and style by hash, and nothing else', () => {
    expect(policy.get('default-src')).toEqual(["'none'"])
    expect(policy.get('script-src')).toEqual([hash(script)])
    expect(policy.get('style-src')).toEqual([hash(style)])
    expect(policy.get('connect-src')).toEqual(["'none'"])
    // The browser asks for an icon; it is the app's own.
    expect(policy.get('img-src')).toEqual(["'self'"])
    expect(policy.get('base-uri')).toEqual(["'none'"])
    expect(policy.get('form-action')).toEqual(["'none'"])
    expect(policy.get('require-trusted-types-for')).toEqual(["'script'"])
    expect(page).toContain('<meta name="referrer" content="no-referrer" />')
    expect(page).not.toMatch(/<script[^>]+src=|<iframe\b|<img\b/)
    expect([...page.matchAll(/<link\b[^>]*>/g)].map((m) => m[0])).toEqual([
      '<link rel="icon" href="logo.svg" type="image/svg+xml" />',
    ])
  })

  test('its script relays the callback on the flow channel and does nothing else', () => {
    expect(script).toContain(`'${CALLBACK_TYPE}'`)
    expect(script).toContain(`new BroadcastChannel(\`${CHANNEL_PREFIX}\${state}\`)`)
    expect(script).toContain('/^[A-Za-z0-9_-]{43}$/')
    expect(script).toContain("window.history.replaceState(null, '', window.location.pathname)")
    expect(script).toContain('window.top !== window.self')
    // `self` is replaceable by a framing page of the same origin; `window` is not (src/security/frame.ts).
    expect(script).toContain('window.top !== window.self || window.top !== window)')
    for (const banned of [
      'innerHTML',
      'outerHTML',
      'insertAdjacentHTML',
      'document.write',
      'eval',
      'Function(',
      'fetch',
      'XMLHttpRequest',
      'localStorage',
      'sessionStorage',
      'indexedDB',
      'opener',
      'postMessage(message, ',
      'location.href =',
    ]) {
      expect(script).not.toContain(banned)
    }
  })
})
