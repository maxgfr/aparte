import { expect, test } from 'bun:test'
import { probeWorker, type WorkerContainer } from './probe.ts'

const OPTIONS: RegistrationOptions = { scope: '/aparte/', updateViaCache: 'none', type: 'classic' }

/** A container whose `register` settles as given, and the calls it received. */
function container(register: () => Promise<unknown>) {
  const calls: [unknown, RegistrationOptions | undefined][] = []
  const c: WorkerContainer = {
    register: (url, options) => {
      calls.push([url, options])
      return register()
    },
  }
  return { c, calls }
}

test('no service worker container: unavailable, nothing registered', async () => {
  expect(await probeWorker(undefined, '/aparte/sw.js', OPTIONS)).toBe(false)
})

test('registers the worker with the scope and HTTP cache opt-out it is given', async () => {
  const { c, calls } = container(async () => ({ scope: 'https://maxgfr.github.io/aparte/' }))
  expect(await probeWorker(c, '/aparte/sw.js', OPTIONS)).toBe(true)
  expect(calls).toEqual([['/aparte/sw.js', OPTIONS]])
})

test('register resolving without a registration (blocked): unavailable, no error', async () => {
  const { c } = container(async () => undefined)
  expect(await probeWorker(c, '/aparte/sw.js', OPTIONS)).toBe(false)
})

test('service workers disabled (SecurityError): unavailable, no error', async () => {
  const { c } = container(async () => {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  })
  expect(await probeWorker(c, '/aparte/sw.js', OPTIONS)).toBe(false)
})

test('Firefox aborting the registration on reload (AbortError) settles quietly', async () => {
  const { c } = container(async () => {
    throw new DOMException('The operation was aborted.', 'AbortError')
  })
  expect(await probeWorker(c, '/aparte/sw.js', OPTIONS)).toBe(false)
})

test('a real registration failure still rejects', async () => {
  const failure = new TypeError('Failed to register a ServiceWorker: A bad HTTP response code (404) was received.')
  const { c } = container(async () => {
    throw failure
  })
  await expect(probeWorker(c, '/aparte/sw.js', OPTIONS)).rejects.toBe(failure)
})
