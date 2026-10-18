/**
 * Aparté's service worker (built by vite-plugin-pwa's injectManifest into `<base>sw.js`).
 *
 * It precaches the build with Workbox and serves it offline, but it trusts nothing it reads back from
 * CacheStorage: every precached response is checked against the SRI digest the build injected into this script
 * (see src/pwa/precache.ts for the threat, the shared `maxgfr.github.io` origin). It adds the security headers
 * GitHub Pages cannot send (a header Content-Security-Policy with `frame-ancestors`, COOP, CORP, Permissions-Policy)
 * to every navigation it answers, and a worker policy to worker scripts. It caches nothing at runtime: API traffic
 * (providers, MCP, sync) is never seen by the cache. The limits of what a worker can enforce (first visit,
 * Shift+Reload, sandboxed frames) are listed in src/pwa/routes.ts.
 *
 * It is also the share target (web manifest `share_target`): a share another app POSTs to `<base>share` is sealed at
 * once to this device's inbox public key (src/core/inbox, spec/FORMAT.md section 16) and stored only as ciphertext,
 * whether or not the vault is unlocked; the page opens it after unlock. And it opens the conversation a "your answer
 * is ready" notification names when the user clicks it.
 */

import { setCacheNameDetails } from 'workbox-core'
import type { WorkboxPlugin } from 'workbox-core/types.js'
import { cleanupOutdatedCaches, PrecacheController } from 'workbox-precaching'
import { cryptoRng } from './core/crypto/rng.ts'
import { type ReceiveOutcome, receiveShare } from './core/inbox/receive.ts'
import { openInboxStore } from './core/inbox/store.ts'
import {
  type PrecacheEntry,
  precachedResponse,
  readVerified,
  unavailableResponse,
  type VerifiedStore,
  verifiableEntries,
  verifyCached,
} from './pwa/precache.ts'
import {
  fromOwnWindow,
  isShareTarget,
  isSkipWaiting,
  isWorkerDestination,
  notificationConversation,
  servesAppShell,
} from './pwa/routes.ts'
import { securityHeaders, workerHeaders } from './security/policy.ts'

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<string | PrecacheEntry> }

/** The scope this worker was registered for (`/aparte/` on GitHub Pages), which is also the app's base path. */
const scope = new URL(self.registration.scope)
const base = scope.pathname
const origin = self.location.origin

// Cache names read `aparte-precache-v2-<scope>`: obviously this app's, and distinct per scope on the shared origin.
setCacheNameDetails({ prefix: 'aparte' })

/**
 * During install, Workbox keeps an entry that is already cached under its revisioned key instead of downloading it
 * again. A sibling app can plant such a key ahead of an update, so a cached copy is only kept when it matches its
 * digest; otherwise Workbox fetches it with `integrity` and the install fails (the old worker stays) on a mismatch.
 */
const verifyOnInstall: WorkboxPlugin = {
  cachedResponseWillBeUsed: async ({ request, cachedResponse }) => {
    if (!cachedResponse) return null
    const integrity = controller.getIntegrityForCacheKey(request.url)
    return integrity ? verifyCached(cachedResponse, integrity) : null
  },
}

const controller = new PrecacheController({ plugins: [verifyOnInstall], fallbackToNetwork: false })
controller.precache(verifiableEntries(self.__WB_MANIFEST))
cleanupOutdatedCaches()

const store: VerifiedStore = {
  open: () => self.caches.open(controller.strategy.cacheName),
  // The worker's own requests for this build's files: same origin, digest-pinned, never seen by the page's
  // networkLog (src/security/net.ts covers the page; this script runs outside it).
  download: (url, init) => fetch(url, init),
}

/** The headers every navigation answered here carries; computed once, they depend on the scope only. */
const documentHeaders = securityHeaders({ origin, base })
const scriptHeaders = workerHeaders({ origin, base })

async function servePrecached(cacheKey: string, pathname: string, extra: Record<string, string>): Promise<Response> {
  const integrity = controller.getIntegrityForCacheKey(cacheKey)
  const verified = integrity ? await readVerified(store, cacheKey, integrity) : null
  return verified ? precachedResponse(verified.bytes, pathname, extra) : unavailableResponse(extra)
}

/** A worker script from the network (not precached): the body as served, with the worker policy added. */
async function networkWorker(request: Request): Promise<Response> {
  const response = await fetch(request)
  if (!response.ok || response.type !== 'basic') return response
  const headers = new Headers(response.headers)
  for (const [name, value] of Object.entries(scriptHeaders)) headers.set(name, value)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/** The channel on which open pages hear that a share arrived (src/app/inbox.tsx). */
const INBOX_CHANNEL = 'aparte-inbox'

/**
 * Seals a share into the inbox and sends the page to the screen that offers it. The form data stays in this worker's
 * memory only; whatever the outcome, nothing of it is written in clear.
 */
async function acceptShare(request: Request): Promise<Response> {
  let outcome: ReceiveOutcome = 'invalid'
  let store: Awaited<ReturnType<typeof openInboxStore>> = null
  try {
    const form = await request.formData()
    store = await openInboxStore({ create: false })
    outcome = await receiveShare({ store, form, rng: cryptoRng(), now: Date.now() })
  } catch {
    outcome = 'invalid'
  } finally {
    store?.close()
  }
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(INBOX_CHANNEL)
    channel.postMessage({ type: 'share', outcome })
    channel.close()
  }
  // 303: the browser follows with a GET of the app shell, which then shows the share screen.
  return Response.redirect(new URL(`./#/share?received=${outcome}`, scope).href, 303)
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)
  if (isShareTarget(request.method, url, origin, base)) {
    event.respondWith(acceptShare(request))
    return
  }
  if (request.method !== 'GET') return
  if (url.origin !== origin || !url.pathname.startsWith(base)) return

  if (request.mode === 'navigate') {
    if (!servesAppShell(url, origin, base)) return
    const shell = controller.getCacheKeyForURL(new URL('index.html', scope).href)
    if (!shell) return
    // A fresh 200 built from the verified bytes: never the cached response object, whose headers are not covered
    // by the digest (and whose `redirected` flag would break navigations).
    event.respondWith(servePrecached(shell, '/index.html', documentHeaders))
    return
  }

  const worker = isWorkerDestination(request.destination)
  const cacheKey = controller.getCacheKeyForURL(request.url)
  if (cacheKey) event.respondWith(servePrecached(cacheKey, url.pathname, worker ? scriptHeaders : {}))
  else if (worker) event.respondWith(networkWorker(request))
  // Anything else goes to the network untouched and uncached.
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Navigations are answered from the precache, so a preload request would only be wasted (and warned about).
      if ('navigationPreload' in self.registration) await self.registration.navigationPreload.disable()
      // Take the pages opened before the first install, so their lazy chunks are verified too. An update only
      // activates once every old page is gone or one of them asked for it (SKIP_WAITING), then reloads.
      await self.clients.claim()
    })(),
  )
})

/** The windows this worker controls: never a sibling page, whatever URL it gave itself with `replaceState`. */
async function controlledWindow(id: string): Promise<WindowClient | undefined> {
  return (await self.clients.matchAll({ type: 'window' })).find((client) => client.id === id)
}

self.addEventListener('message', (event) => {
  if (!isSkipWaiting(event.data)) return
  const source = event.source as { id?: string; type?: string; frameType?: string; url?: string } | null
  if (!fromOwnWindow(source, origin, base) || typeof source?.id !== 'string') return
  const id = source.id
  event.waitUntil(
    (async () => {
      if ((await controlledWindow(id)) !== undefined) await self.skipWaiting()
    })(),
  )
})

/**
 * A click on an "answer ready" notification (src/app/notify.ts) brings the app back on that conversation: an open
 * window of the app is focused and told which one, otherwise a new window opens on it.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const conversation = notificationConversation(event.notification.data)
  const target = new URL(conversation === null ? './' : `./#/chat/${conversation}`, scope).href
  event.waitUntil(
    (async () => {
      // Controlled windows only: an uncontrolled one under the scope may be a sibling page that rewrote its URL.
      const windows = await self.clients.matchAll({ type: 'window' })
      const own = windows.find((client) => fromOwnWindow(client, origin, base))
      if (own === undefined) {
        await self.clients.openWindow(target)
        return
      }
      await own.focus()
      if (conversation !== null) own.postMessage({ type: 'open-conversation', conversation })
    })(),
  )
})
