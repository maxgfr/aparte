/*
 * The `fetch` every provider adapter calls (ProviderFetchModule in web/src/core/contracts/ai.ts): web/src/security/net.ts
 * `request()` with purpose `provider`, so each call is checked (HTTPS, or HTTP on the loopback only), sent without
 * cookies or a referrer, and shown in the transparency panel. The AI SDK packages are always given this function (or
 * a test's fake): none of them may fall back to the global `fetch`.
 */
import { request } from '../../security/net.ts'
import type { FetchLike } from '../contracts/ai.ts'

/** The AI SDK's `user-agent`, which no provider's CORS preflight allows, is dropped before the request leaves. */
const DROPPED = new Set(['user-agent'])

function withoutDropped(headers: HeadersInit | undefined): Headers {
  const out = new Headers(headers)
  for (const name of DROPPED) out.delete(name)
  return out
}

export const providerFetch: FetchLike = async (input, init) => {
  if (input instanceof Request) {
    const { url, method, headers, signal } = input
    const body = input.body === null ? undefined : await input.arrayBuffer()
    return request(url, {
      method,
      body,
      signal,
      ...init,
      headers: withoutDropped(init?.headers ?? headers),
      purpose: 'provider',
    })
  }
  return request(input, { ...init, headers: withoutDropped(init?.headers), purpose: 'provider' })
}
