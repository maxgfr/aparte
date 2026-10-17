import type { Page } from '@playwright/test'
import { about } from '../src/i18n/en/about.ts'
import { shell } from '../src/i18n/en/shell.ts'
import { REFUSAL } from '../src/security/frame.ts'
import { accessible, expect, test } from './gates.ts'

/** The path the build is served under; the CSP restricts scripts to it. */
const BASE = process.env.VITE_BASE ?? '/aparte/'

/** A policy as a map from directive name to its source list, in order. */
function directives(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/)
    if (name) out.set(name.toLowerCase(), sources)
  }
  return out
}

async function openWelcome(page: Page) {
  await page.goto('./')
  await expect(page.getByRole('heading', { level: 1, name: shell.welcomeTitle })).toBeVisible()
}

/**
 * Waits until the service worker is active and controls the page. A first visit is controlled from the moment the
 * worker claims its clients; one that is not (a browser that does not claim) is controlled after a reload.
 */
async function waitForController(page: Page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  const controlled = await page.evaluate(
    () =>
      navigator.serviceWorker.controller !== null ||
      new Promise<boolean>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(true), { once: true })
        setTimeout(() => resolve(navigator.serviceWorker.controller !== null), 5_000)
      }),
  )
  if (!controlled) await page.reload()
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
}

test('the welcome screen renders with the preview notice, clean and accessible', async ({ page }) => {
  await openWelcome(page)
  await expect(page.getByText(shell.preview)).toBeVisible()
  await accessible(page, 'welcome')
})

test('the served page carries a CSP that restricts scripts to the app path and requires Trusted Types', async ({
  page,
  baseURL,
}) => {
  await openWelcome(page)
  const meta = page.locator('meta[http-equiv="Content-Security-Policy"]')
  await expect(meta).toHaveCount(1)
  const policy = directives((await meta.getAttribute('content')) ?? '')
  const origin = new URL(baseURL ?? '').origin

  // Scripts: the app's own path and WebAssembly compilation, nothing else ('self' would admit every other site
  // published on the same GitHub Pages origin).
  expect([...(policy.get('script-src') ?? [])].sort()).toEqual([`${origin}${BASE}`, "'wasm-unsafe-eval'"].sort())
  for (const banned of ["'unsafe-inline'", "'unsafe-eval'", "'self'", '*', 'https:', 'data:', 'blob:'])
    expect(policy.get('script-src')).not.toContain(banned)
  expect(policy.get('default-src')).toEqual(["'none'"])
  expect(policy.get('object-src')).toEqual(["'none'"])
  expect(policy.get('base-uri')).toEqual(["'none'"])
  expect(policy.get('form-action')).toEqual(["'none'"])
  expect(policy.get('require-trusted-types-for')).toEqual(["'script'"])
  expect(policy.get('trusted-types')).toEqual(expect.arrayContaining(['aparte']))
  expect(policy.get('trusted-types')).not.toContain("'allow-duplicates'")
  // frame-ancestors is ignored in a meta policy (and warned about): the service worker sends it as a header.
  expect(policy.has('frame-ancestors')).toBe(false)

  // A meta policy only governs what follows it: nothing that loads or runs code may come before it.
  const before = await page.evaluate(() => {
    const el = document.querySelector('meta[http-equiv="Content-Security-Policy"]')
    const found: string[] = []
    for (const node of document.querySelectorAll('script, link, style, base')) {
      if (el && node.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
        found.push(`${node.nodeName} ${node.getAttribute('src') ?? node.getAttribute('href') ?? ''}`)
    }
    return found
  })
  expect(before).toEqual([])
})

test('Trusted Types are enforced where the browser supports them', async ({ page, browserName, gates }) => {
  await openWelcome(page)
  const supported = await page.evaluate(() => 'trustedTypes' in window)
  // Chromium has shipped Trusted Types since 83: there, missing support is a failure, not a skip.
  if (browserName === 'chromium') expect(supported).toBe(true)
  test.info().annotations.push({
    type: 'trusted-types',
    description: `${browserName}: ${supported ? 'supported' : 'not supported by this engine'}`,
  })
  if (!supported) return

  // Both refusals below are the point of this test. Each engine also logs them as a console error, in its own words:
  // Chromium names the TrustedHTML assignment, WebKit and Firefox quote the directive.
  gates.expectViolation('require-trusted-types-for', /'TrustedHTML' assignment|require-trusted-types-for/)
  gates.expectViolation('trusted-types', /trusted-types aparte dompurify/)
  const outcome = await page.evaluate(() => {
    const sink = (() => {
      try {
        document.createElement('div').innerHTML = '<img src=x>'
        return 'assigned'
      } catch (e) {
        return e instanceof TypeError ? 'TypeError' : String(e)
      }
    })()
    const rogue = (() => {
      try {
        window.trustedTypes?.createPolicy('rogue', { createHTML: (s: string) => s })
        return 'created'
      } catch (e) {
        return e instanceof TypeError ? 'TypeError' : String(e)
      }
    })()
    return { sink, rogue, defaultPolicy: window.trustedTypes?.defaultPolicy ?? null }
  })
  test.info().annotations.push({
    type: 'trusted-types',
    description: `${browserName}: innerHTML string → ${outcome.sink}; createPolicy('rogue') → ${outcome.rogue}`,
  })
  expect(outcome.sink).toBe('TypeError')
  expect(outcome.rogue).toBe('TypeError')
  // A default policy would quietly turn every string sink back on.
  expect(outcome.defaultPolicy).toBeNull()
  await expect
    .poll(() => gates.violations.map((v) => v.directive).sort())
    .toEqual(['require-trusted-types-for', 'trusted-types'])
})

test('the app refuses to run inside a frame', async ({ page, context, baseURL, browserName, gates }) => {
  // Another site frames the app, played by 127.0.0.1: a different origin, served by the test itself.
  const app = new URL(baseURL ?? '')
  const framer = `http://127.0.0.1:${app.port}/framer.html`
  await gates.foreignPage(context, framer, '<!doctype html><title>Framer</title><iframe title="framed"></iframe>')
  // Chromium's local network access checks treat a page the test fulfils as public, and would refuse its frame to
  // localhost before the app could refuse anything: the framer is granted that access, as a real local page has it.
  if (browserName === 'chromium')
    await context.grantPermissions(['local-network-access'], { origin: new URL(framer).origin })
  await page.goto(framer)
  await page.locator('iframe').evaluate((frame: HTMLIFrameElement, src) => {
    frame.src = src
  }, app.href)
  const framed = page.frameLocator('iframe')
  // The refusal replaces the body before the app is imported: no root, no welcome, a message instead.
  await expect(framed.getByRole('heading', { level: 1, name: REFUSAL.title })).toBeVisible()
  await expect(framed.getByText(REFUSAL.framed)).toBeVisible()
  await expect(framed.locator('#root')).toHaveCount(0)
  await expect(framed.getByRole('heading', { name: shell.welcomeTitle })).toHaveCount(0)
})

test('the app refuses to run when opened by another page', async ({ page, context, baseURL }) => {
  await page.goto('about:blank')
  const opened = context.waitForEvent('page')
  await page.evaluate((url) => {
    window.open(url, '_blank')
  }, baseURL ?? '')
  const popup = await opened
  await popup.waitForLoadState()
  await expect(popup.getByRole('heading', { level: 1, name: REFUSAL.title })).toBeVisible()
  await expect(popup.getByText(REFUSAL.opened)).toBeVisible()
  await expect(popup.locator('#root')).toHaveCount(0)
  await expect(popup.getByRole('heading', { name: shell.welcomeTitle })).toHaveCount(0)
})

test('once loaded, the shell opens offline', async ({ page, context, browserName }) => {
  await openWelcome(page)
  await waitForController(page)
  if (browserName === 'firefox') {
    // Firefox's offline mode fails a navigation before its service worker sees it, which no real offline visit does.
    // There, offline is played by failing every request that reaches the network: only the worker can answer.
    await context.route(
      () => true,
      (route) => route.abort('internetdisconnected'),
    )
    test.info().annotations.push({ type: 'offline', description: 'firefox: every network request failed by a route' })
  } else await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: shell.welcomeTitle })).toBeVisible()
  // Served by the worker, not by a network that happened to answer.
  expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
  await context.setOffline(false)
})

test('navigations served by the service worker carry the security headers', async ({ page, browserName, baseURL }) => {
  await openWelcome(page)
  await waitForController(page)
  const response = await page.reload()
  if (browserName !== 'chromium') {
    // Playwright reports whether a response came from the service worker in Chromium only; elsewhere this test can
    // only check that the worker controls the page.
    test.info().annotations.push({
      type: 'service-worker-headers',
      description: `${browserName}: not observable (response.fromServiceWorker() is Chromium-only)`,
    })
    expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
    return
  }
  expect(response?.fromServiceWorker()).toBe(true)
  const headers = response?.headers() ?? {}
  const header = directives(headers['content-security-policy'] ?? '')
  expect(header.get('frame-ancestors')).toEqual(["'none'"])
  expect(headers['cross-origin-opener-policy']).toBe('same-origin')
  expect(headers['cross-origin-resource-policy']).toBe('same-origin')
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['referrer-policy']).toBe('no-referrer')
  expect(headers['permissions-policy']).toContain('camera=(self)')
  expect(headers['permissions-policy']).toContain('geolocation=()')

  // The header is the meta policy plus frame-ancestors: the worker computes the same origin and path as the build.
  const meta = directives(
    (await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')) ?? '',
  )
  for (const [name, sources] of meta) expect(header.get(name), name).toEqual(sources)
  expect(header.get('script-src')).toContain(`${new URL(baseURL ?? '').origin}${BASE}`)
  test.info().annotations.push({ type: 'service-worker-headers', description: `${browserName}: verified` })
})

test('About shows the build version and the security status', async ({ page, browserName }) => {
  await openWelcome(page)
  await page
    .getByRole('link', { name: new RegExp(`^(${shell.welcomeLearnMore}|${shell.navAbout})$`) })
    .first()
    .click()
  await expect(page.getByRole('heading', { level: 1, name: about.title })).toBeVisible()
  await expect(page.getByText(about.version, { exact: true })).toBeVisible()
  await expect(page.getByText(/^\d+\.\d+\.\d+(-[\w.]+)?$/).first()).toBeVisible()
  await expect(page.getByText(about.trustedTypes, { exact: true })).toBeVisible()
  const status = page.getByText(
    new RegExp(
      `^(${[about.trustedTypesEnforced, about.trustedTypesAvailable, about.trustedTypesUnsupported].join('|')})$`,
    ),
  )
  await expect(status).toBeVisible()
  // Chromium enforces the policy: anything else shown there would be the About screen lying.
  if (browserName === 'chromium') await expect(status).toHaveText(about.trustedTypesEnforced)
  test
    .info()
    .annotations.push({ type: 'trusted-types', description: `${browserName} About: ${await status.textContent()}` })
  await expect(page.getByText(about.serviceWorker, { exact: true })).toBeVisible()
  await accessible(page, 'about')
})

test('the web app manifest is valid and scoped to the app path', async ({ page, request, baseURL }) => {
  await openWelcome(page)
  const href = await page.locator('link[rel="manifest"]').getAttribute('href')
  expect(href).toBeTruthy()
  const manifestUrl = new URL(href ?? '', page.url())
  expect(manifestUrl.origin).toBe(new URL(baseURL ?? '').origin)
  expect(manifestUrl.pathname.startsWith(BASE)).toBe(true)
  const res = await request.get(manifestUrl.toString())
  expect(res.ok()).toBe(true)
  const m = await res.json()
  expect(m.name).toContain('Aparté')
  expect(typeof m.short_name).toBe('string')
  const appUrl = new URL(BASE, manifestUrl).toString()
  expect(new URL(m.start_url, manifestUrl).toString()).toBe(appUrl)
  expect(new URL(m.scope, manifestUrl).toString()).toBe(appUrl)
  expect(m.display).toBe('standalone')
  const icons = m.icons as { src: string; sizes: string; type?: string; purpose?: string }[]
  expect(icons.map((i) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))
  expect(icons.some((i) => i.purpose?.split(/\s+/).includes('maskable'))).toBe(true)
  for (const icon of icons) {
    const url = new URL(icon.src, manifestUrl)
    expect(url.origin, icon.src).toBe(manifestUrl.origin)
    const got = await request.get(url.toString())
    expect(got.ok(), icon.src).toBe(true)
    expect(got.headers()['content-type'], icon.src).toMatch(/^image\//)
  }
})
