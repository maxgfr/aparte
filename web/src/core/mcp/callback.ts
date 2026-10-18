/*
 * The answer of the OAuth popup. The authorization server sends the popup back to `oauth-callback.html`
 * (web/public), which posts `{type, state, code, iss, error}` on the BroadcastChannel `aparte-oauth-<state>` and
 * closes. This module is the receiving end, pure but for the injected channel.
 *
 * Invariants:
 * - The channel is named after the flow's random state, so only a page that knows the state can talk to it, and a
 *   message on any other channel never reaches the flow.
 * - A message is taken only when it is exactly the callback's shape and carries the flow's state; anything else is
 *   ignored, and the flow keeps waiting.
 * - The first message taken settles the flow and closes the channel: a replayed or second answer is never read.
 * - The code is never logged; an `error` is reduced to its OAuth code (RFC 6749 section 4.1.2.1).
 */

export const CHANNEL_PREFIX = 'aparte-oauth-'
export const CALLBACK_TYPE = 'aparte-oauth-callback'

/** base64url of 32 bytes, as oauth.ts `startFlow` makes them (and as the callback page checks). */
const STATE = /^[A-Za-z0-9_-]{43}$/
const CODE = /^[\x21-\x7e]{1,4096}$/
const ERROR = /^[\x20-\x21\x23-\x5b\x5d-\x7e]{1,128}$/

export function channelNameFor(state: string): string {
  if (!STATE.test(state)) throw new TypeError('Not a flow state')
  return `${CHANNEL_PREFIX}${state}`
}

export type CallbackOutcome =
  | { readonly kind: 'code'; readonly code: string; readonly iss: string | null }
  | { readonly kind: 'error'; readonly error: string }

/** The outcome a message carries for the flow of `state`, or null when it is not a valid answer of that flow. */
export function parseCallback(data: unknown, state: string): CallbackOutcome | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const m = data as Record<string, unknown>
  if (m.type !== CALLBACK_TYPE || typeof m.state !== 'string' || m.state !== state) return null
  const opt = (v: unknown): string | null | undefined =>
    v === null || v === undefined ? null : typeof v === 'string' ? v : undefined
  const code = opt(m.code)
  const iss = opt(m.iss)
  const error = opt(m.error)
  if (code === undefined || iss === undefined || error === undefined) return null
  if (error !== null) return ERROR.test(error) ? { kind: 'error', error } : { kind: 'error', error: 'invalid_request' }
  if (code === null || !CODE.test(code)) return null
  if (iss !== null && iss.length > 2048) return null
  return { kind: 'code', code, iss }
}

/** The part of a BroadcastChannel this module uses. */
export interface CallbackChannel {
  onmessage: ((event: { readonly data: unknown }) => void) | null
  close(): void
}

export class CallbackTimeoutError extends Error {
  override readonly name = 'CallbackTimeoutError'
}

export class CallbackCancelledError extends Error {
  override readonly name = 'CallbackCancelledError'
}

/**
 * Listens on the flow's channel until a valid answer arrives, the timeout passes or `signal` aborts; the channel is
 * closed in every case. Open it before the popup opens, so the answer cannot arrive first.
 */
export function awaitCallback(input: {
  readonly open: (name: string) => CallbackChannel
  readonly state: string
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}): Promise<CallbackOutcome> {
  const channel = input.open(channelNameFor(input.state))
  return new Promise<CallbackOutcome>((resolve, reject) => {
    let done = false
    const finish = (settle: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      input.signal?.removeEventListener('abort', onAbort)
      channel.onmessage = null
      try {
        channel.close()
      } catch {
        // Closing a channel twice is harmless.
      }
      settle()
    }
    const onAbort = () => finish(() => reject(new CallbackCancelledError('The sign-in was cancelled')))
    const timer = setTimeout(
      () => finish(() => reject(new CallbackTimeoutError('The sign-in took too long'))),
      input.timeoutMs,
    )
    if (input.signal?.aborted) {
      onAbort()
      return
    }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    channel.onmessage = (event) => {
      const outcome = parseCallback(event.data, input.state)
      if (outcome !== null) finish(() => resolve(outcome))
    }
  })
}
