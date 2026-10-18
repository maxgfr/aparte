/*
 * The OAuth popup's answer (callback.ts): taken on the flow's own channel only, with the flow's state only, once only.
 */
import { describe, expect, test } from 'bun:test'
import {
  awaitCallback,
  CallbackCancelledError,
  CallbackTimeoutError,
  CHANNEL_PREFIX,
  channelNameFor,
  parseCallback,
} from './callback.ts'
import { callbackMessage, channelHub } from './testkit.ts'

const STATE = 'S'.repeat(43)
const OTHER = 'O'.repeat(43)

describe('parseCallback', () => {
  test('takes a code with the flow state, and nothing else', () => {
    expect(parseCallback(callbackMessage({ state: STATE, code: 'abc' }), STATE)).toEqual({
      kind: 'code',
      code: 'abc',
      iss: null,
    })
    expect(parseCallback(callbackMessage({ state: STATE, code: 'abc', iss: 'https://as' }), STATE)).toEqual({
      kind: 'code',
      code: 'abc',
      iss: 'https://as',
    })
    expect(parseCallback(callbackMessage({ state: OTHER, code: 'abc' }), STATE)).toBeNull()
    expect(
      parseCallback({ ...(callbackMessage({ state: STATE, code: 'abc' }) as object), type: 'x' }, STATE),
    ).toBeNull()
    expect(parseCallback(callbackMessage({ state: STATE }), STATE)).toBeNull()
    expect(parseCallback(callbackMessage({ state: STATE, code: 'has space' }), STATE)).toBeNull()
    expect(parseCallback({ type: 'aparte-oauth-callback', state: STATE, code: 1 }, STATE)).toBeNull()
    expect(parseCallback('code=abc', STATE)).toBeNull()
    expect(parseCallback(null, STATE)).toBeNull()
  })

  test('an error answer is reduced to its OAuth code', () => {
    expect(parseCallback(callbackMessage({ state: STATE, error: 'access_denied' }), STATE)).toEqual({
      kind: 'error',
      error: 'access_denied',
    })
    expect(parseCallback(callbackMessage({ state: STATE, error: '<script>"x"' }), STATE)).toEqual({
      kind: 'error',
      error: 'invalid_request',
    })
  })

  test('channel names come from a state of the expected shape only', () => {
    expect(channelNameFor(STATE)).toBe(`${CHANNEL_PREFIX}${STATE}`)
    expect(() => channelNameFor('short')).toThrow(TypeError)
    expect(() => channelNameFor(`${'a'.repeat(42)}/`)).toThrow(TypeError)
  })
})

describe('awaitCallback', () => {
  test('a message on another channel never reaches the flow', async () => {
    const hub = channelHub()
    const waiting = awaitCallback({ open: hub.open, state: STATE, timeoutMs: 50 })
    hub.post(channelNameFor(OTHER), callbackMessage({ state: OTHER, code: 'abc' }))
    hub.post('aparte-oauth', callbackMessage({ state: STATE, code: 'abc' }))
    await expect(waiting).rejects.toBeInstanceOf(CallbackTimeoutError)
    expect(hub.listening(channelNameFor(STATE))).toBe(0)
  })

  test('a state mismatch is ignored; the right answer settles the flow', async () => {
    const hub = channelHub()
    const name = channelNameFor(STATE)
    const waiting = awaitCallback({ open: hub.open, state: STATE, timeoutMs: 1000 })
    hub.post(name, callbackMessage({ state: OTHER, code: 'forged' }))
    hub.post(name, { type: 'something-else' })
    hub.post(name, callbackMessage({ state: STATE, code: 'genuine' }))
    expect(await waiting).toEqual({ kind: 'code', code: 'genuine', iss: null })
  })

  test('a replayed answer is never read: the channel closes with the first', async () => {
    const hub = channelHub()
    const name = channelNameFor(STATE)
    const first = awaitCallback({ open: hub.open, state: STATE, timeoutMs: 1000 })
    hub.post(name, callbackMessage({ state: STATE, code: 'one' }))
    hub.post(name, callbackMessage({ state: STATE, code: 'two' }))
    expect(await first).toEqual({ kind: 'code', code: 'one', iss: null })
    expect(hub.listening(name)).toBe(0)
  })

  test('cancelling closes the channel', async () => {
    const hub = channelHub()
    const controller = new AbortController()
    const waiting = awaitCallback({ open: hub.open, state: STATE, timeoutMs: 1000, signal: controller.signal })
    controller.abort()
    await expect(waiting).rejects.toBeInstanceOf(CallbackCancelledError)
    expect(hub.listening(channelNameFor(STATE))).toBe(0)
  })
})
