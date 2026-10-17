import { expect, test } from 'bun:test'
import { fromOwnWindow, isSkipWaiting, isWorkerDestination, scopePath, servesAppShell } from './routes.ts'

const origin = 'https://maxgfr.github.io'
const base = '/aparte/'
const u = (path: string) => new URL(path, origin)

test('the scope path is relative to the base, decoded, and null outside it', () => {
  expect(scopePath(u('/aparte/'), origin, base)).toBe('')
  expect(scopePath(u('/aparte/assets/a.js'), origin, base)).toBe('assets/a.js')
  expect(scopePath(u('/aparte/%73andbox/x.html'), origin, base)).toBe('sandbox/x.html')
  expect(scopePath(u('/cursus/'), origin, base)).toBeNull()
  expect(scopePath(u('/aparte'), origin, base)).toBeNull()
  expect(scopePath(new URL('https://evil.example/aparte/'), origin, base)).toBeNull()
  expect(scopePath(u('/aparte/%E0%A4%A'), origin, base)).toBeNull()
})

test('navigations in scope get the app shell, except the OAuth callback and the sandbox pages', () => {
  expect(servesAppShell(u('/aparte/'), origin, base)).toBe(true)
  expect(servesAppShell(u('/aparte/index.html'), origin, base)).toBe(true)
  expect(servesAppShell(u('/aparte/some/deep/link?x=1'), origin, base)).toBe(true)
  expect(servesAppShell(u('/aparte/oauth-callback.html'), origin, base)).toBe(false)
  expect(servesAppShell(u('/aparte/oauth-callback.html?code=abc'), origin, base)).toBe(false)
  expect(servesAppShell(u('/aparte/sandbox/'), origin, base)).toBe(false)
  expect(servesAppShell(u('/aparte/sandbox/artifact.html'), origin, base)).toBe(false)
  // An encoded path cannot slip past the denylist.
  expect(servesAppShell(u('/aparte/%73andbox/artifact.html'), origin, base)).toBe(false)
  expect(servesAppShell(u('/cursus/'), origin, base)).toBe(false)
})

test('worker scripts are told apart from other destinations', () => {
  expect(isWorkerDestination('worker')).toBe(true)
  expect(isWorkerDestination('sharedworker')).toBe(true)
  expect(isWorkerDestination('script')).toBe(false)
  expect(isWorkerDestination('document')).toBe(false)
  expect(isWorkerDestination('')).toBe(false)
})

test('only the exact workbox-window message activates the waiting worker', () => {
  expect(isSkipWaiting({ type: 'SKIP_WAITING' })).toBe(true)
  for (const data of ['SKIP_WAITING', null, undefined, {}, { type: 'skip_waiting' }, [{ type: 'SKIP_WAITING' }]])
    expect(isSkipWaiting(data)).toBe(false)
})

test('messages are accepted from the app’s own windows only, never from sibling apps of the origin', () => {
  expect(fromOwnWindow({ type: 'window', url: 'https://maxgfr.github.io/aparte/#/chat' }, origin, base)).toBe(true)
  expect(fromOwnWindow({ type: 'window', url: 'https://maxgfr.github.io/cursus/' }, origin, base)).toBe(false)
  expect(fromOwnWindow({ type: 'window', url: 'https://maxgfr.github.io/' }, origin, base)).toBe(false)
  expect(fromOwnWindow({ type: 'worker', url: 'https://maxgfr.github.io/aparte/assets/w.js' }, origin, base)).toBe(
    false,
  )
  expect(fromOwnWindow({ type: 'window' }, origin, base)).toBe(false)
  expect(fromOwnWindow({ type: 'window', url: 'not a url' }, origin, base)).toBe(false)
  expect(fromOwnWindow(null, origin, base)).toBe(false)
})
