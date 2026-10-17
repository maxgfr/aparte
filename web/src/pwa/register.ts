/**
 * The only place the service worker is registered (the scan gate holds every other file to that). vite-plugin-pwa's
 * injected registration is off (`injectRegister: false`): this one goes through the `aparte` Trusted Types policy,
 * opts out of the HTTP cache for the worker script, survives Firefox aborting the registration, and never reloads
 * the page into a new version while something holds the reload (src/pwa/updates.ts).
 */

import { scriptURL } from '../security/tt.ts'
import { probeWorker } from './probe.ts'
import { createUpdateMachine, type UpdateSnapshot, type Updates } from './updates.ts'

export type { UpdateSnapshot, Updates }

/** How often an open app asks for a new version, besides every return to the foreground. */
const UPDATE_INTERVAL_MS = 60 * 60 * 1000

const machine = createUpdateMachine()

/** The waiting update, the first offline install and whether a worker controls the page, for the update toast. */
export const updates: Updates = machine.updates

/**
 * Holds back any update reload until the returned function is called (idempotent). Taken around work a reload
 * would cut: a response still streaming, an encryption or a write in flight.
 */
export function holdReload(reason: string): () => void {
  return machine.holdReload(reason)
}

let started = false

/**
 * Registers `<base>sw.js` for the scope `<base>` and starts watching for updates. A no-op where service workers are
 * absent or blocked, and in dev unless `VITE_SW_DEV=1` (vite-plugin-pwa then serves a module worker of its own).
 * Never throws: the app runs without a worker, only less protected (no header policy) and not offline.
 */
export function registerServiceWorker(): void {
  if (started) return
  started = true
  if (import.meta.env.DEV && import.meta.env.VITE_SW_DEV !== '1') return
  if (!('serviceWorker' in navigator)) return
  start().catch((e: unknown) => {
    // The next load tries again; nothing the user could act on.
    console.warn('Service worker registration failed', e)
  })
}

async function start(): Promise<void> {
  const base = import.meta.env.BASE_URL
  const dev = import.meta.env.DEV
  // In dev, vite-plugin-pwa serves the worker from source as a module at `dev-sw.js?dev-sw`.
  const url = scriptURL(new URL(dev ? `${base}dev-sw.js?dev-sw` : `${base}sw.js`, location.href))
  // `updateViaCache: 'none'`: every update check fetches the worker script (and its imports) from the network, so
  // the integrity manifest it carries is the deployed one, never a stale HTTP-cached copy.
  const options: RegistrationOptions = { scope: base, updateViaCache: 'none', type: dev ? 'module' : 'classic' }
  // TypeScript's DOM library types the sink as `string | URL`; browsers with Trusted Types accept (and, under
  // `require-trusted-types-for 'script'`, require) a TrustedScriptURL.
  const container = {
    register: (u: string | TrustedScriptURL, o?: RegistrationOptions) =>
      navigator.serviceWorker.register(u as string, o),
  }
  if (!(await probeWorker(container, url, options))) return

  const { Workbox } = await import('workbox-window')
  // workbox-window types its TrustedScriptURL from @types/trusted-types, a twin of ours: the value passes through.
  const wb = new Workbox(url as string, options)
  wb.addEventListener('waiting', () => machine.events.waiting())
  wb.addEventListener('installed', (event) => {
    if (!event.isUpdate) machine.events.offlineReady()
  })
  wb.addEventListener('controlling', (event) => machine.events.controlling(event.isUpdate === true))
  machine.bind({
    skipWaiting: () => wb.messageSkipWaiting(),
    reload: () => location.reload(),
  })

  let registration: ServiceWorkerRegistration | undefined
  try {
    // The page has long loaded by the time this lazy module runs: register now, not on `load`.
    registration = await wb.register({ immediate: true })
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'SecurityError')) return
    throw e
  }
  if (!registration) return
  // Only this app's worker counts: on the shared origin a page can be controlled by a broader scope's worker.
  const controller = navigator.serviceWorker.controller
  if (controller && new URL(controller.scriptURL).pathname.startsWith(base)) machine.events.active()

  const check = () => {
    if (!navigator.onLine) return
    // A failed check is retried at the next interval or return to the foreground.
    wb.update().catch(() => undefined)
  }
  setInterval(check, UPDATE_INTERVAL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check()
  })
}
