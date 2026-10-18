/**
 * Which requests the service worker answers, as pure functions of URLs (tested in Bun).
 *
 * Limits, by design of the platform: the very first visit and a Shift+Reload bypass the worker entirely, so they
 * get GitHub Pages' own headers and only the `<meta>` Content-Security-Policy of index.html; sandboxed frames
 * (opaque origin) are never intercepted either, so the sandbox pages carry their policy in their own markup.
 */

/** Paths under the scope that navigate to the network, never to the app shell. */
const NETWORK_NAVIGATIONS: readonly RegExp[] = [/^oauth-callback\.html$/, /^sandbox\//]

/** The scope-relative path of `url`, percent-decoded; null outside the scope or when it does not decode. */
export function scopePath(url: URL, origin: string, base: string): string | null {
  if (url.origin !== origin || !url.pathname.startsWith(base)) return null
  try {
    return decodeURIComponent(url.pathname.slice(base.length))
  } catch {
    return null
  }
}

/**
 * True when a navigation to `url` gets the precached app shell (navigateFallback semantics): every path in scope
 * but the OAuth callback and the sandbox pages, which must come from the network as they are.
 */
export function servesAppShell(url: URL, origin: string, base: string): boolean {
  const path = scopePath(url, origin, base)
  return path !== null && !NETWORK_NAVIGATIONS.some((re) => re.test(path))
}

/** Worker script requests, whose Content-Security-Policy comes from their own response headers. */
export function isWorkerDestination(destination: RequestDestination): boolean {
  return destination === 'worker' || destination === 'sharedworker'
}

/** The message workbox-window's `messageSkipWaiting()` posts. */
export function isSkipWaiting(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'SKIP_WAITING'
}

/**
 * True when a message comes from one of Aparté's own windows: a window that is not a frame, on a page the worker
 * answers with the app shell. Any page of the shared origin can reach this worker
 * (`navigator.serviceWorker.getRegistration('/aparte/')`), so a sibling app could otherwise activate an update under
 * a page that is still streaming; and a sibling page can frame, or open, a page of the scope that is not the app (the
 * OAuth callback, a 404 under the scope) and post from there. The worker also requires the window to be one it
 * controls (src/sw.ts), which a sibling page that rewrote its own URL with `history.replaceState` is not.
 */
export function fromOwnWindow(
  source: { type?: string; frameType?: string; url?: string } | null,
  origin: string,
  base: string,
): boolean {
  if (source?.type !== 'window' || typeof source.url !== 'string') return false
  // An engine that does not report `frameType` is not refused on that ground: the shell check and the controlled
  // check still hold, and refusing would leave its users without updates.
  if (source.frameType === 'nested' || source.frameType === 'none') return false
  try {
    return servesAppShell(new URL(source.url), origin, base)
  } catch {
    return false
  }
}

/**
 * True when a message the page received from a service worker comes from the worker that controls it, registered
 * under the base: the page side of `fromOwnWindow`. A sibling site's worker can post to every window of the origin.
 */
export function fromAppWorker(
  source: { readonly scriptURL?: string } | null,
  controller: { readonly scriptURL: string } | null,
  base: string,
): boolean {
  if (source === null || controller === null || source !== controller) return false
  try {
    return new URL(controller.scriptURL).pathname.startsWith(base)
  } catch {
    return false
  }
}

/** The share target's action (`<base>share`, web manifest `share_target`), which only a POST reaches. */
export const SHARE_PATH = 'share'

/** True for the share target's POST: another app sharing to Aparté (pwa.config.ts `share_target`). */
export function isShareTarget(method: string, url: URL, origin: string, base: string): boolean {
  return method === 'POST' && scopePath(url, origin, base) === SHARE_PATH
}

/** A conversation id as notifications carry it: 26 base32 characters. */
const CONVERSATION_ID = /^[a-z2-7]{25}[aeimquy4]$/

/**
 * The conversation a notification opens, from its `data`; null for anything else. The data comes from this app's
 * own `showNotification`, but it is checked as untrusted all the same: it decides where a click navigates.
 */
export function notificationConversation(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null
  const id = (data as { conversation?: unknown }).conversation
  return typeof id === 'string' && CONVERSATION_ID.test(id) ? id : null
}
