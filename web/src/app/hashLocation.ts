import { useSyncExternalStore } from 'react'

/*
 * Hash routing with the query inside the hash (`#/about?tab=build`). GitHub Pages serves one file and has no SPA
 * rewrite, so the path lives in the hash. wouter's own hash hook writes the query to `location.search`, outside the
 * hash, where it outlives the screen that set it; this one keeps both together.
 */

/** The path and query a hash carries: `#/about?x=1` → `{ path: '/about', search: 'x=1' }`, `''` → `{ path: '/' }`. */
export function parseHash(hash: string): { path: string; search: string } {
  const body = hash.replace(/^#?\/?/, '')
  const q = body.indexOf('?')
  const rawPath = q === -1 ? body : body.slice(0, q)
  const search = q === -1 ? '' : body.slice(q + 1)
  // A trailing slash names the same screen ("#/about/" is "#/about"), so routes never need two patterns.
  const path = `/${rawPath.replace(/\/+$/, '')}`
  return { path, search }
}

/** The section a path belongs to: its first segment ("/about/build" → "/about", "/" → "/"). */
export function sectionOf(path: string): string {
  return `/${path.split('?')[0]?.split('/')[1] ?? ''}`
}

/** The hash an in-app target is written as: always rooted, so `about` and `/about` land on the same entry. */
export function hashFor(to: string): string {
  return `#${to.startsWith('/') ? to : `/${to}`}`
}

// The browser's back and forward (the phone's back gesture too) move between entries made with pushState: they fire
// popstate, not always hashchange, so the screen listens to both.
const subscribe = (cb: () => void) => {
  addEventListener('hashchange', cb)
  addEventListener('popstate', cb)
  return () => {
    removeEventListener('hashchange', cb)
    removeEventListener('popstate', cb)
  }
}

const currentPath = () => parseHash(location.hash).path
const currentSearch = () => parseHash(location.hash).search

/**
 * The in-app location this history entry was opened from (path and query), kept in the entry's state: pushing a
 * screen records where it came from, replacing it keeps that. Undefined for an entry opened from outside the app.
 */
export function cameFrom(): string | undefined {
  const from = (history.state as { from?: unknown } | null)?.from
  return typeof from === 'string' ? from : undefined
}

export function navigate(to: string, { replace = false }: { replace?: boolean; state?: unknown } = {}): void {
  const oldURL = location.href
  const url = new URL(oldURL)
  url.hash = hashFor(to)
  const here = `/${location.hash.replace(/^#?\/?/, '')}`
  const from = replace ? cameFrom() : here
  history[replace ? 'replaceState' : 'pushState'](from !== undefined ? { from } : null, '', url.href)
  dispatchEvent(new HashChangeEvent('hashchange', { oldURL, newURL: url.href }))
}

/**
 * Back to the screen this one was opened from when it was opened inside the app (a history pop, as the browser's back
 * does), else to `fallback`: a screen opened from a bookmark never sends Back out of the app.
 */
export function goBack(fallback: string): void {
  if (cameFrom() !== undefined) history.back()
  else navigate(fallback, { replace: true })
}

export function useHashLocation(): [string, typeof navigate] {
  return [useSyncExternalStore(subscribe, currentPath, () => '/'), navigate]
}
useHashLocation.hrefs = (href: string) => hashFor(href)

export function useHashSearch(): string {
  return useSyncExternalStore(subscribe, currentSearch, () => '')
}
