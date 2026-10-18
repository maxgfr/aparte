import { expect, Gates, loadAllowlist, originMatches, test } from './gates.ts'

// The gates are what every other spec relies on to catch a CSP violation, a stray request or an error, so they are
// tested themselves: each case runs in a context of its own, watched by its own gates, and reads what they caught.

test('the allowlist file is valid and allows only the default provider hosts, the GitHub API and the pinned model hosts', () => {
  // The app contacts its own origin; for purpose `provider`, the default API host of each provider it ships; for
  // purpose `sync`, the GitHub API; for purpose `download`, the hosts the model workers read pinned, hash-checked model
  // files from. Endpoints the user types stay unlisted. A host added to the file is a reviewed change that updates
  // this test.
  expect(loadAllowlist()).toEqual([
    ...[
      'https://api.anthropic.com',
      'https://api.openai.com',
      'https://generativelanguage.googleapis.com',
      'https://api.mistral.ai',
      'https://openrouter.ai',
    ].map((origin) => ({ origin, purposes: ['provider'] })),
    { origin: 'https://api.github.com', purposes: ['sync'] },
    ...[
      'https://huggingface.co',
      'https://us.aws.cdn.hf.co',
      'https://eu.aws.cdn.hf.co',
      'https://cas-bridge.xethub.hf.co',
      'https://cdn-lfs.hf.co',
      'https://cdn-lfs-us-1.hf.co',
      'https://cdn-lfs-eu-1.hf.co',
      'https://raw.githubusercontent.com',
    ].map((origin) => ({ origin, purposes: ['download'] })),
  ])
})

test('allowlist entries match exact origins only', () => {
  const entry = { origin: 'https://api.example.com', purposes: ['provider' as const] }
  expect(originMatches(entry, new URL('https://api.example.com/v1'))).toBe(true)
  expect(originMatches(entry, new URL('wss://api.example.com/socket'))).toBe(true)
  expect(originMatches(entry, new URL('https://api.example.com:8443/v1'))).toBe(false)
  expect(originMatches(entry, new URL('http://api.example.com/v1'))).toBe(false)
  expect(originMatches(entry, new URL('https://evil-api.example.com/'))).toBe(false)
  expect(originMatches(entry, new URL('https://api.example.com.evil.test/'))).toBe(false)
  const local = { origin: 'http://localhost:11434', purposes: ['provider' as const] }
  expect(originMatches(local, new URL('http://localhost:11434/api'))).toBe(true)
  expect(originMatches(local, new URL('http://localhost:11435/api'))).toBe(false)
})

test('a user-typed endpoint is admitted for one test, by exact origin', () => {
  const gates = new Gates('http://localhost:4173', [], [])
  expect(gates.allows(new URL('http://127.0.0.1:18080/v1/chat/completions'))).toBe(false)
  gates.userEndpoint('http://127.0.0.1:18080')
  expect(gates.allows(new URL('http://127.0.0.1:18080/v1/chat/completions'))).toBe(true)
  expect(gates.allows(new URL('http://127.0.0.1:18081/v1'))).toBe(false)
  expect(gates.allows(new URL('https://127.0.0.1:18080/v1'))).toBe(false)
  expect(gates.check('http://127.0.0.1:18080/v1/models')).toBe(true)
  expect(gates.contacted.get('http://127.0.0.1:18080')).toBe('foreign')
  expect(gates.problems()).toEqual([])
  expect(() => gates.userEndpoint('http://example.com')).toThrow('loopback')
  expect(() => gates.userEndpoint('https://example.com/v1')).toThrow('bare origin')
  // Another test's gates know nothing of it.
  expect(new Gates('http://localhost:4173', [], []).allows(new URL('http://127.0.0.1:18080/v1'))).toBe(false)
})

test('a request outside the allowlist is aborted and reported; an allowed one goes through', async ({
  browser,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? '').origin
  const own = new Gates(origin, [{ origin: 'https://allowed.test', purposes: ['provider'] }], ['provider'])
  const context = await browser.newContext({ baseURL })
  await own.watch(context)
  // Registered after the gates' route, so it runs first: the request is still seen and checked by the gates.
  await context.route('https://allowed.test/**', (route) =>
    route.fulfill({ body: 'ok', headers: { 'access-control-allow-origin': '*' } }),
  )
  const page = await context.newPage()
  await page.goto('./')
  const results = await page.evaluate(async () => {
    const attempt = (url: string) =>
      fetch(url).then(
        (r) => r.text(),
        () => 'failed',
      )
    return [await attempt('https://allowed.test/ping'), await attempt('https://blocked.test/ping')]
  })
  await context.close()
  expect(results).toEqual(['ok', 'failed'])
  expect(own.blocked).toEqual(['https://blocked.test/ping'])
  expect(own.contacted.get('https://allowed.test')).toBe('allowed')
  expect(own.contacted.get('https://blocked.test')).toBe('blocked')
  expect(own.contacted.get(origin)).toBe('app')
  expect(own.problems()).toContain(
    'Request outside the network allowlist (purposes: provider): https://blocked.test/ping',
  )
})

test('an allowlisted host is refused to a test that did not declare its purpose', async ({ baseURL }) => {
  const own = new Gates(new URL(baseURL ?? '').origin, [{ origin: 'https://sync.test', purposes: ['sync'] }], [])
  expect(own.check('https://sync.test/room')).toBe(false)
  expect(own.check('wss://sync.test/room')).toBe(false)
  expect(own.check(`${new URL(baseURL ?? '').origin}/aparte/sw.js`)).toBe(true)
  expect(own.check('data:text/plain,hi')).toBe(true)
})

test('CSP violations, console errors and uncaught exceptions are all reported', async ({ browser, baseURL }) => {
  const own = new Gates(new URL(baseURL ?? '').origin, [], [])
  const context = await browser.newContext({ baseURL })
  await own.watch(context)
  const page = await context.newPage()
  await page.goto('./')
  await page.evaluate(() => {
    // img-src admits 'self', blob: and data: only: the browser refuses this before any request is made.
    const img = new Image()
    img.src = 'https://elsewhere.test/pixel.png'
    document.body.append(img)
    console.error('gate self-test: console error')
    setTimeout(() => {
      throw new Error('gate self-test: uncaught')
    }, 0)
  })
  await expect.poll(() => own.violations.map((v) => v.directive)).toContain('img-src')
  await expect.poll(() => own.pageErrors.join('\n')).toContain('gate self-test: uncaught')
  await expect.poll(() => own.consoleErrors.join('\n')).toContain('gate self-test: console error')
  await context.close()
  const problems = own.problems().join('\n')
  expect(problems).toContain('CSP/TT violation: img-src blocked https://elsewhere.test/pixel.png')
  expect(problems).toContain('Console error:')
  expect(problems).toContain('Uncaught exception:')
})

test('an expected violation that does not happen is a failure', async ({ baseURL }) => {
  const own = new Gates(new URL(baseURL ?? '').origin, [], [])
  own.expectViolation('require-trusted-types-for')
  expect(own.problems()).toEqual(['Expected violation did not happen: require-trusted-types-for'])
})
