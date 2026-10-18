import { expect, test } from 'bun:test'
import {
  fromAppWorker,
  fromOwnWindow,
  isShareTarget,
  isSkipWaiting,
  isWorkerDestination,
  notificationConversation,
  scopePath,
  servesAppShell,
} from './routes.ts'

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
  expect(
    fromOwnWindow(
      { type: 'window', frameType: 'top-level', url: 'https://maxgfr.github.io/aparte/#/chat' },
      origin,
      base,
    ),
  ).toBe(true)
  expect(fromOwnWindow({ type: 'window', url: 'https://maxgfr.github.io/cursus/' }, origin, base)).toBe(false)
  expect(fromOwnWindow({ type: 'window', url: 'https://maxgfr.github.io/' }, origin, base)).toBe(false)
  expect(fromOwnWindow({ type: 'worker', url: 'https://maxgfr.github.io/aparte/assets/w.js' }, origin, base)).toBe(
    false,
  )
  expect(fromOwnWindow({ type: 'window' }, origin, base)).toBe(false)
  expect(fromOwnWindow({ type: 'window', url: 'not a url' }, origin, base)).toBe(false)
  expect(fromOwnWindow(null, origin, base)).toBe(false)
})

test('a window under the scope that is not the app shell, or not top-level, is not one of the app’s windows', () => {
  // A sibling page can frame a page of the scope the worker does not answer with the app (the OAuth callback comes
  // from the network, without frame-ancestors) and post from that frame, or open a page that only exists as a 404.
  const top = (path: string) => ({ type: 'window', frameType: 'top-level', url: `${origin}${path}` })
  expect(fromOwnWindow({ ...top('/aparte/'), frameType: 'nested' }, origin, base)).toBe(false)
  expect(fromOwnWindow({ ...top('/aparte/'), frameType: 'auxiliary' }, origin, base)).toBe(true)
  // An engine without Client.frameType is judged on the page alone.
  expect(fromOwnWindow({ type: 'window', url: `${origin}/aparte/` }, origin, base)).toBe(true)
  expect(fromOwnWindow(top('/aparte/oauth-callback.html'), origin, base)).toBe(false)
  expect(fromOwnWindow(top('/aparte/sandbox/runner.html'), origin, base)).toBe(false)
  expect(fromOwnWindow(top('/aparte/#/chat/x'), origin, base)).toBe(true)
})

test('only a POST to <base>share is the share target', () => {
  expect(isShareTarget('POST', u('/aparte/share'), origin, base)).toBe(true)
  expect(isShareTarget('POST', u('/aparte/share?x=1'), origin, base)).toBe(true)
  expect(isShareTarget('GET', u('/aparte/share'), origin, base)).toBe(false)
  expect(isShareTarget('POST', u('/aparte/share/x'), origin, base)).toBe(false)
  expect(isShareTarget('POST', u('/cursus/share'), origin, base)).toBe(false)
  expect(isShareTarget('POST', new URL('https://evil.example/aparte/share'), origin, base)).toBe(false)
})

test('a notification opens a well-formed conversation id only', () => {
  expect(notificationConversation({ conversation: 'abcdefghijklmnopqrstuvwxya' })).toBe('abcdefghijklmnopqrstuvwxya')
  expect(notificationConversation({ conversation: 'abcdefghijklmnopqrstuvwxyb' })).toBeNull()
  expect(notificationConversation({ conversation: '../../evil' })).toBeNull()
  expect(notificationConversation({ conversation: 42 })).toBeNull()
  expect(notificationConversation(null)).toBeNull()
  expect(notificationConversation('abcdefghijklmnopqrstuvwxya')).toBeNull()
})

test('the page takes worker messages from the app’s own worker only, never from a sibling app’s', () => {
  // A sibling site's worker can list every window of the origin (`clients.matchAll({ includeUncontrolled: true })`)
  // and post to Aparté's: only the worker that controls this page, registered under the base, is heard.
  const own = { scriptURL: `${origin}/aparte/sw.js` }
  const sibling = { scriptURL: `${origin}/evil/sw.js` }
  expect(fromAppWorker(own, own, base)).toBe(true)
  expect(fromAppWorker(sibling, own, base)).toBe(false)
  expect(fromAppWorker({ ...own }, own, base)).toBe(false)
  expect(fromAppWorker(own, null, base)).toBe(false)
  expect(fromAppWorker(null, own, base)).toBe(false)
  // A broader worker (the origin's root site) controlling the page is not the app's.
  const root = { scriptURL: `${origin}/sw.js` }
  expect(fromAppWorker(root, root, base)).toBe(false)
})
