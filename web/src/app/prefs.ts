/*
 * Device-local interface preferences: the only module that touches localStorage. What it may hold is listed in
 * PREFS below and is never sensitive (a theme, a layout choice): no secret, no key, no conversation, no provider or
 * account detail. Anything that matters goes into the encrypted vault instead. Every read is validated, so a value
 * written by an older build or edited by hand falls back to the default rather than reaching the UI.
 */

export type Theme = 'system' | 'light' | 'dark'

interface PrefSpec<T> {
  readonly key: string
  readonly fallback: T
  readonly parse: (raw: string) => T | undefined
}

const THEMES: readonly Theme[] = ['system', 'light', 'dark']

/** Every preference this device may keep, with its type. */
interface Prefs {
  theme: Theme
}

export type PrefName = keyof Prefs

const PREFS: { readonly [N in PrefName]: PrefSpec<Prefs[N]> } = {
  theme: { key: 'aparte:theme', fallback: 'system', parse: (raw) => THEMES.find((t) => t === raw) },
}

/** The subset of Storage used here, so tests pass an in-memory one. */
export type PrefStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** localStorage when the page may use it; null in a private window that throws, under tests, or without a DOM. */
function defaultStorage(): PrefStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

const listeners = new Set<() => void>()

function notify(): void {
  for (const cb of listeners) cb()
}

/** Reads a preference; the default when unset, unreadable or invalid. */
export function readPref<N extends PrefName>(name: N, storage: PrefStorage | null = defaultStorage()): Prefs[N] {
  const spec = PREFS[name]
  try {
    const raw = storage?.getItem(spec.key)
    if (raw === null || raw === undefined) return spec.fallback
    return spec.parse(raw) ?? spec.fallback
  } catch {
    return spec.fallback
  }
}

/**
 * Stores a preference; the default is stored as its absence, so a device that never changed a setting keeps nothing.
 * A storage that refuses the write (quota, private mode) leaves the choice in force for this page only.
 */
export function writePref<N extends PrefName>(
  name: N,
  value: Prefs[N],
  storage: PrefStorage | null = defaultStorage(),
): void {
  const spec = PREFS[name]
  try {
    if (value === spec.fallback) storage?.removeItem(spec.key)
    else storage?.setItem(spec.key, String(value))
  } catch {
    // Kept in memory by the caller's state; nothing else to do.
  }
  notify()
}

/** Calls `cb` when a preference changes here or in another tab of the app. */
export function subscribePrefs(cb: () => void): () => void {
  listeners.add(cb)
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || Object.values(PREFS).some((p) => p.key === e.key)) cb()
  }
  if (typeof addEventListener === 'function') addEventListener('storage', onStorage)
  return () => {
    listeners.delete(cb)
    if (typeof removeEventListener === 'function') removeEventListener('storage', onStorage)
  }
}

/** Tab-scoped flags kept in sessionStorage. Like the preferences above, never anything sensitive. */
const SESSION_FLAGS = { chunkReload: 'aparte:chunk-reload' } as const

export type SessionFlag = keyof typeof SESSION_FLAGS

function defaultSessionStorage(): PrefStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/** Whether the flag is set in this tab; null when the storage cannot be read. */
export function readSessionFlag(
  name: SessionFlag,
  storage: PrefStorage | null = defaultSessionStorage(),
): boolean | null {
  try {
    return storage ? storage.getItem(SESSION_FLAGS[name]) !== null : null
  } catch {
    return null
  }
}

/** Sets or clears the flag; false when the storage refused the write. */
export function writeSessionFlag(
  name: SessionFlag,
  on: boolean,
  storage: PrefStorage | null = defaultSessionStorage(),
): boolean {
  try {
    if (!storage) return false
    if (on) storage.setItem(SESSION_FLAGS[name], '1')
    else storage.removeItem(SESSION_FLAGS[name])
    return true
  } catch {
    return false
  }
}
