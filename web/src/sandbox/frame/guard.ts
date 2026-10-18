/*
 * What every sandbox page checks before it does anything: that it runs in a sandboxed frame (an opaque origin, so
 * nothing of the app's origin is reachable) of a page of the app. Opened as a top-level page, framed without the
 * `sandbox` attribute, or framed by another site, it shows a static note and never listens for messages.
 *
 * The app's origin is baked in at build time (build/sandbox.ts): results are posted to that origin only, and messages
 * are taken from the frame's parent only when they come from it.
 */

declare const __APARTE_APP_ORIGIN__: string

/** The origin of the app these pages belong to. */
export const APP_ORIGIN: string = __APARTE_APP_ORIGIN__

/** Why the page will not run, or null when it may: it must be framed, with an opaque origin. */
export function refusal(win: {
  readonly origin: string
  readonly top: unknown
  readonly self: unknown
}): string | null {
  if (win.origin !== 'null') return 'This page runs only inside the sandbox frame of Aparté.'
  if (win.top === win.self) return 'This page runs only inside Aparté.'
  return null
}

/** Replaces the page with the note (text only). */
export function showRefusal(text: string): void {
  const p = document.createElement('p')
  p.textContent = text
  document.body.replaceChildren(p)
}
