import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { readPref, subscribePrefs, type Theme, writePref } from './prefs.ts'

export type { Theme }

/**
 * Forces light or dark on <html>, or leaves the system preference in charge (tokens.css follows
 * `prefers-color-scheme` unless `data-theme` is set, and sets `color-scheme` to match).
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
}

const current = () => readPref('theme')

/** The theme chosen on this device (shared by every tab of the app), applied to the document, and its setter. */
export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(subscribePrefs, current, () => 'system' as const)
  useEffect(() => applyTheme(theme), [theme])
  const set = useCallback((next: Theme) => writePref('theme', next), [])
  return [theme, set]
}
