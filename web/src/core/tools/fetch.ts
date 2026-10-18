/*
 * The `fetch` of the tools that reach the network (the built-in `fetch_url`): web/src/security/net.ts `request()` with
 * purpose `tool`, so each call is checked, sent without cookies or a referrer, and shown in the transparency panel.
 * It runs only after the user approved the call (contracts/tools.ts).
 */
import { request } from '../../security/net.ts'
import type { FetchLike } from '../contracts/ai.ts'

export const toolFetch: FetchLike = (input, init) => {
  const url = input instanceof Request ? input.url : input
  return request(url, { ...init, purpose: 'tool' })
}
