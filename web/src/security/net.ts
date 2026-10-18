/**
 * The app's only door to the network. Every request states why it is made (its purpose), is refused unless it goes
 * over HTTPS or to a model server on this machine's loopback, never carries cookies, HTTP auth or a referrer, and is
 * recorded (origin and purpose, never the path or the body) in `networkLog`, which the transparency panel shows, so
 * the user can see exactly which hosts the app has talked to. `spec/network-allowlist.json` lists, per purpose, the
 * hosts the deployed app is expected to contact.
 */

/**
 * Why a request is made. `app` is the app's own origin (its files, its manifest); `tool` is a tool the user approved
 * (the built-in `fetch_url`, the pages Deep research reads); `skills` imports a skill from GitHub; `research` is a
 * Deep research search backend; the rest reach other hosts.
 */
export type NetPurpose = 'provider' | 'mcp' | 'tool' | 'sync' | 'download' | 'catalog' | 'skills' | 'research' | 'app'

export const NET_PURPOSES: readonly NetPurpose[] = [
  'provider',
  'mcp',
  'tool',
  'sync',
  'download',
  'catalog',
  'skills',
  'research',
  'app',
]

/** One origin contacted for one purpose. */
export interface NetEntry {
  readonly origin: string
  readonly purpose: NetPurpose
  /** Requests made, including refused-by-network and failed ones: the attempt is what reveals the host. */
  readonly count: number
  /** Epoch milliseconds of the first and the latest request. */
  readonly first: number
  readonly last: number
}

/** Hosts plain HTTP may reach: the loopback only, as the CSP's `connect-src` allows (`http://localhost:*`). */
const LOOPBACK = new Set(['localhost', '127.0.0.1'])

const entries = new Map<string, NetEntry>()
const listeners = new Set<() => void>()
/** Replaced on every change, so `snapshot()` is stable between changes (as `useSyncExternalStore` requires). */
let snap: readonly NetEntry[] = []

/** Origins contacted this session, in order of first contact. In memory only: the log is never persisted. */
export const networkLog = {
  subscribe(cb: () => void): () => void {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  },
  snapshot(): readonly NetEntry[] {
    return snap
  },
}

function record(origin: string, purpose: NetPurpose, now: number): void {
  const key = `${purpose} ${origin}`
  const prev = entries.get(key)
  entries.set(
    key,
    prev ? { ...prev, count: prev.count + 1, last: now } : { origin, purpose, count: 1, first: now, last: now },
  )
  snap = Object.freeze([...entries.values()])
  for (const cb of listeners) cb()
}

/** Forgets the log. For tests; the app keeps it for the whole session. */
export function resetNetworkLog(): void {
  entries.clear()
  snap = []
  for (const cb of listeners) cb()
}

/** The page's own URL, or null outside a document. */
function here(): string | null {
  return (globalThis as { location?: { href?: string } }).location?.href ?? null
}

/**
 * Parses and checks a request URL against the page it is made from (`page`, null outside a document); throws a
 * TypeError naming the reason. Relative URLs resolve against the page. Exported for tests.
 */
export function checkRequestURL(input: string | URL, purpose: NetPurpose, page: string | null): URL {
  if (!NET_PURPOSES.includes(purpose)) throw new TypeError(`Unknown network purpose: ${String(purpose)}`)
  let url: URL
  try {
    url = new URL(String(input), page ?? undefined)
  } catch {
    throw new TypeError(`Blocked request (unparsable URL): ${String(input)}`)
  }
  // Credentials in a URL end up in logs and history, and the request would authenticate the user somewhere.
  if (url.username || url.password) throw new TypeError(`Blocked request (credentials in the URL) to ${url.origin}`)
  if (url.protocol === 'http:') {
    if (!LOOPBACK.has(url.hostname))
      throw new TypeError(`Blocked request (plain HTTP off the loopback) to ${url.origin}`)
  } else if (url.protocol !== 'https:') {
    throw new TypeError(`Blocked request (scheme ${url.protocol} is not http(s)) to ${url.href.slice(0, 64)}`)
  }
  if (purpose === 'app') {
    const self = page === null ? null : new URL(page).origin
    if (url.origin !== self)
      throw new TypeError(`Blocked request (purpose 'app' is the app's own origin) to ${url.origin}`)
  }
  return url
}

/**
 * The only `fetch` in the app. Checks the URL, records the origin and purpose, then fetches without cookies or HTTP
 * auth (`credentials: 'omit'`, whatever the caller passed) and without a referrer. Rejects with a TypeError, as
 * `fetch` itself does, when the URL is refused. `transport` is the browser's own `fetch` a confined worker kept aside
 * before replacing the global one (web/src/security/workerNet.ts); everywhere else it is the global `fetch`.
 */
export async function request(
  input: string | URL,
  init: RequestInit & { purpose: NetPurpose },
  transport: typeof globalThis.fetch = globalThis.fetch,
): Promise<Response> {
  const { purpose, ...rest } = init
  const url = checkRequestURL(input, purpose, here())
  record(url.origin, purpose, Date.now())
  return transport.call(globalThis, url.href, { ...rest, credentials: 'omit', referrerPolicy: 'no-referrer' })
}
