import { type NetPurpose, request } from './net.ts'

/**
 * The network of a model worker. Libraries running in a worker (WebLLM, transformers.js, ONNX Runtime) call the global
 * `fetch` themselves; `confineFetch` replaces it, before any of them is imported, with one that admits only the URLs
 * `route` names a purpose for and sends those through `request()` (web/src/security/net.ts), so the rules of the page
 * hold in the worker too: https or the loopback only, no credentials, no referrer. Any other URL is refused with a
 * TypeError, as a blocked fetch is, without touching the network; `route` may instead answer it locally (a 404 for
 * a file the pinned repository does not have). `XMLHttpRequest`, `WebSocket` and `EventSource` are removed, so a
 * library cannot go around it (a module worker has no usable `importScripts`).
 */
export type Route =
  /** Fetched through `request()`; with `sha256`, the body must hash to it (hex) or the fetch rejects. */
  { readonly purpose: NetPurpose; readonly sha256?: string } | { readonly respond: () => Response } | null

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The confined `fetch`, also returned so the worker's own code can call it by name. */
export type ConfinedFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export function confineFetch(route: (url: URL) => Route, scope: Record<string, unknown> = globalThis): ConfinedFetch {
  const native = scope.fetch as typeof globalThis.fetch
  const confined = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = input instanceof Request ? input.url : String(input)
    let url: URL
    try {
      url = new URL(raw, (scope.location as { href?: string } | undefined)?.href)
    } catch {
      throw new TypeError(`Blocked request (unparsable URL) from a worker: ${raw.slice(0, 64)}`)
    }
    const decision = route(url)
    if (decision === null) throw new TypeError(`Blocked request from a worker to ${url.origin}`)
    if ('respond' in decision) return decision.respond()
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const response = await request(
      url,
      {
        method: init?.method ?? 'GET',
        ...(init?.headers === undefined ? {} : { headers: init.headers }),
        ...(signal ? { signal } : {}),
        ...(init?.mode === undefined ? {} : { mode: init.mode }),
        ...(init?.integrity === undefined ? {} : { integrity: init.integrity }),
        cache: init?.cache ?? 'default',
        purpose: decision.purpose,
      },
      native,
    )
    if (decision.sha256 === undefined || !response.ok) return response
    const bytes = await response.arrayBuffer()
    if ((await sha256Hex(bytes)) !== decision.sha256) {
      throw new TypeError(`Blocked response (it does not match its pinned digest) from ${url.origin}`)
    }
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
  scope.fetch = confined
  for (const name of ['XMLHttpRequest', 'WebSocket', 'EventSource']) {
    if (name in scope) scope[name] = undefined
  }
  return confined
}
