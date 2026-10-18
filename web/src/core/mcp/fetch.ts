/*
 * The `fetch` of the MCP client and of its OAuth requests: web/src/security/net.ts `request()` with purpose `mcp`, so
 * each call is checked (HTTPS, or HTTP on the loopback only), sent without cookies or a referrer, and shown in the
 * transparency panel. The MCP library is always given this function: it never falls back to the global `fetch`.
 *
 * Invariants:
 * - The AI SDK's `user-agent` is dropped (a server's CORS preflight would have to allow it, and it says nothing the
 *   server needs).
 * - A response body is read up to a cap: MAX_RESPONSE_BYTES for a plain response, MAX_STREAM_BYTES for an event
 *   stream (which may carry many messages). Past the cap the body errors, so an oversized answer fails instead of
 *   filling the memory.
 * - Redirects are refused unless the caller asks otherwise (the MCP transports ask for `error` themselves).
 * - The `WWW-Authenticate` header of a 401, when the server exposes it, is handed to `onUnauthorized` (it may name
 *   the protected resource metadata of RFC 9728).
 */
import type { FetchLike } from '../contracts/ai.ts'

export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
export const MAX_STREAM_BYTES = 16 * 1024 * 1024

const DROPPED = ['user-agent']

/** A body that errors once more than `cap` bytes went through. */
function capped(body: ReadableStream<Uint8Array>, cap: number): ReadableStream<Uint8Array> {
  let seen = 0
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength
        if (seen > cap) controller.error(new RangeError(`The MCP response is larger than ${cap} bytes`))
        else controller.enqueue(chunk)
      },
    }),
  )
}

/** A response that cannot carry a body (`new Response` refuses one for these statuses). */
const NULL_BODY = new Set([101, 103, 204, 205, 304])

/** Caps the body of `response` (see the invariants); a declared length over the cap fails at once. */
export function capResponse(response: Response): Response {
  if (response.body === null || NULL_BODY.has(response.status) || response.type === 'opaque') return response
  const stream = (response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')
  const cap = stream ? MAX_STREAM_BYTES : MAX_RESPONSE_BYTES
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > cap) {
    void response.body.cancel().catch(() => undefined)
    throw new RangeError(`The MCP response is larger than ${cap} bytes`)
  }
  return new Response(capped(response.body, cap), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

export interface McpFetchOptions {
  /** web/src/security/net.ts `request` (tests pass a fake). */
  readonly request: (input: string | URL, init: RequestInit & { purpose: 'mcp' }) => Promise<Response>
  /** Called with the `WWW-Authenticate` header of a 401 (null when the server does not expose it). */
  readonly onUnauthorized?: (header: string | null) => void
}

export function createMcpFetch(options: McpFetchOptions): FetchLike {
  return async (input, init) => {
    let url: string
    let rest: RequestInit = init ?? {}
    if (input instanceof Request) {
      url = input.url
      const body = input.body === null ? undefined : await input.arrayBuffer()
      rest = { method: input.method, headers: input.headers, body, signal: input.signal, ...init }
    } else {
      url = String(input)
    }
    const headers = new Headers(rest.headers)
    for (const name of DROPPED) headers.delete(name)
    const response = await options.request(url, {
      ...rest,
      headers,
      redirect: rest.redirect ?? 'error',
      purpose: 'mcp',
    })
    if (response.status === 401) options.onUnauthorized?.(response.headers.get('www-authenticate'))
    return capResponse(response)
  }
}
