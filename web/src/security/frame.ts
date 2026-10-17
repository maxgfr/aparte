/**
 * The app refuses to run inside a frame or in a window another page opened. A `<meta>` CSP cannot carry
 * `frame-ancestors`, and until the service worker adds its headers nothing stops another site from framing the app
 * (clickjacking: a hidden "Delete everything" under a decoy button) or from holding a handle on its window through
 * `window.opener`. A legitimate visit never needs either, so the page shows a static note instead of the app.
 */

/** Why the app will not run here, or null when it may. */
export type Isolation = 'framed' | 'opened' | null

/** The window fields the check reads, so tests pass a plain object. */
export interface WindowLike {
  readonly top: unknown
  readonly self: unknown
  readonly opener: unknown
}

/** Comparing window proxies is allowed across origins; reading anything else from a cross-origin parent is not. */
export function isolation(win: WindowLike): Isolation {
  if (win.top !== win.self) return 'framed'
  if (win.opener !== null && win.opener !== undefined) return 'opened'
  return null
}

/**
 * The note shown instead of the app. Static English: it renders before the app, and so before the i18n catalog,
 * has loaded, and it carries nothing a localisation could get wrong.
 */
export const REFUSAL = {
  title: 'Aparté opens in its own tab',
  framed: 'This page is shown inside another site, so it will not run here.',
  opened: 'This page was opened by another page, which could still control this tab, so it will not run here.',
  link: 'Open Aparté in a new tab',
} as const

/** The document parts the note is built with (textContent only: nothing here is parsed as HTML). */
export interface DocumentLike {
  readonly body: { replaceChildren(...nodes: unknown[]): void } | null
  createElement(tag: string): {
    textContent: string | null
    setAttribute(name: string, value: string): void
    append(...nodes: unknown[]): void
  }
}

/** Replaces the page with the note and a link that opens the app afresh, without an opener. */
export function showRefusal(reason: Exclude<Isolation, null>, doc: DocumentLike, href: string): void {
  const main = doc.createElement('main')
  const title = doc.createElement('h1')
  title.textContent = REFUSAL.title
  const text = doc.createElement('p')
  text.textContent = REFUSAL[reason]
  const link = doc.createElement('a')
  link.textContent = REFUSAL.link
  link.setAttribute('href', href)
  link.setAttribute('target', '_blank')
  link.setAttribute('rel', 'noopener noreferrer')
  main.append(title, text, link)
  doc.body?.replaceChildren(main)
}
