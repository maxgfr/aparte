import * as z from 'zod'
import { isolation, showRefusal } from './frame.ts'
import { createPolicies } from './tt.ts'

/** The outcome of the first call; later calls return it unchanged. */
let ready: boolean | undefined

/**
 * Puts the browser-side defences in place before any other module of the app is evaluated. Returns false, after
 * replacing the page with a static note, when the app must not run here (framed, or opened by another page).
 * Idempotent.
 *
 * - Zod is switched to jitless mode: its JIT compiles schemas with `new Function`, which the CSP forbids; under
 *   jitless it never even probes for it (a probe would still raise a CSP violation report).
 * - The `aparte` Trusted Types policy is created, so later script URL sinks (workers, the service worker) have it.
 */
export function initSecurity(): boolean {
  if (ready !== undefined) return ready
  const reason = isolation(window)
  if (reason) {
    // The link opens the app's start page, not this URL: the page around the frame chose it, fragment included.
    const start = new URL(
      typeof import.meta.env.BASE_URL === 'string' ? import.meta.env.BASE_URL : '/',
      location.origin,
    )
    showRefusal(reason, document, start.href)
    ready = false
    return ready
  }
  z.config({ jitless: true })
  createPolicies()
  ready = true
  return ready
}
