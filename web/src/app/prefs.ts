/*
 * Device-local interface preferences: the only module that touches localStorage. What it may hold is listed in
 * PREFS below and is never sensitive (a theme, an interface language, a layout choice, the fact that an Emergency Kit still waits to be
 * confirmed, a hint the user dismissed): no secret, no key, no conversation, no provider or account detail. Anything that matters goes into the encrypted vault instead. Every read is validated, so a value
 * written by an older build or edited by hand falls back to the default rather than reaching the UI.
 */

import { type BaseLocale, LOCALES } from '../i18n/index.ts'

export type Theme = 'system' | 'light' | 'dark'

/** The interface language picked on this device, or `system` to follow the device languages. */
export type LocalePref = 'system' | BaseLocale

interface PrefSpec<T> {
  readonly key: string
  readonly fallback: T
  readonly parse: (raw: string) => T | undefined
}

const THEMES: readonly Theme[] = ['system', 'light', 'dark']

/**
 * An Emergency Kit shown but not yet confirmed, as `create:<base32 vaultId>:<kit proof>` or `recover:<base32
 * vaultId>`, or '' for none. It outlives the page (a closed tab, a crash, a phone reclaiming the app), so the next
 * unlock shows a new kit instead of losing it. Any page of a shared origin can write localStorage, so the value is a
 * request, not a decision: a renewal (which retires the recovery key of the kit) happens only for a proof the vault
 * itself made (core/contracts/vault.ts `CreatedVault.kitProof`), and `recover:` only shows the user the Secret Key
 * of the vault they just unlocked.
 */
export type KitPending = '' | `create:${string}:${string}` | `recover:${string}`

const KIT_PENDING = /^(?:create:[a-z2-7]{26}:[A-Za-z0-9_-]{59}|recover:[a-z2-7]{26})$/

/** Where dictation runs on this device (core/contracts/media.ts `DictationEngine`). */
export type Dictation = 'local' | 'api' | 'browser'
/** Where answers are read aloud on this device (core/contracts/media.ts `ReadAloudEngine`). */
export type ReadAloud = 'device' | 'api'

const DICTATIONS: readonly Dictation[] = ['local', 'api', 'browser']
const READ_ALOUDS: readonly ReadAloud[] = ['device', 'api']

/** Backend ids, comma-separated: lowercase words only, never free text. */
const RESEARCH_SOURCES = /^[a-z]{2,24}(?:,[a-z]{2,24}){0,31}$/

const flag = (raw: string): boolean | undefined => (raw === '1' ? true : raw === '0' ? false : undefined)

/** Every preference this device may keep, with its type. */
interface Prefs {
  theme: Theme
  locale: LocalePref
  kitPending: KitPending
  /**
   * The dictation engine. `browser` (Chrome's Web Speech API, which sends the audio to Google) is set by the app only
   * after the user confirmed a warning that says so; as any page of a shared origin could write it too, the microphone
   * also asks once per page before it listens through it (src/app/consent.ts).
   */
  dictation: Dictation
  /** Dictation records while the microphone button is held, rather than between two presses. */
  pushToTalk: boolean
  readAloud: ReadAloud
  /** A notification says an answer is ready when the app is in the background. */
  notifyAnswers: boolean
  /**
   * The Deep research backends the user turned on (core/contracts/research.ts ids, comma-separated, sorted); '' for
   * the default set. Which public search services this device sends queries to, never a query itself.
   */
  researchSources: string
  /** The user dismissed the hint that no passphrase protects the vault (ui/shell/ProtectHint.tsx). */
  protectHintDismissed: boolean
}

export type PrefName = keyof Prefs

/** The type of one preference. */
export type PrefValue<N extends PrefName> = Prefs[N]

const PREFS: { readonly [N in PrefName]: PrefSpec<Prefs[N]> } = {
  theme: { key: 'aparte:theme', fallback: 'system', parse: (raw) => THEMES.find((t) => t === raw) },
  locale: { key: 'aparte:locale', fallback: 'system', parse: (raw) => LOCALES.find((l) => l === raw) },
  kitPending: {
    key: 'aparte:kit-pending',
    fallback: '',
    parse: (raw) => (KIT_PENDING.test(raw) ? (raw as KitPending) : undefined),
  },
  dictation: { key: 'aparte:dictation', fallback: 'local', parse: (raw) => DICTATIONS.find((d) => d === raw) },
  pushToTalk: { key: 'aparte:push-to-talk', fallback: false, parse: flag },
  readAloud: { key: 'aparte:read-aloud', fallback: 'device', parse: (raw) => READ_ALOUDS.find((r) => r === raw) },
  notifyAnswers: { key: 'aparte:notify-answers', fallback: false, parse: flag },
  researchSources: {
    key: 'aparte:research-sources',
    fallback: '',
    parse: (raw) => (RESEARCH_SOURCES.test(raw) ? raw : undefined),
  },
  protectHintDismissed: { key: 'aparte:protect-hint-dismissed', fallback: false, parse: flag },
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
    else storage?.setItem(spec.key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value))
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

/** The part of Storage that clearing needs: the keys it holds, to find Aparté's own. */
export type ClearableStorage = Pick<Storage, 'key' | 'removeItem' | 'length'>

/** localStorage or sessionStorage when the page may use it, else null. */
function webArea(which: 'local' | 'session'): ClearableStorage | null {
  try {
    if (which === 'local') return typeof localStorage === 'undefined' ? null : localStorage
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

/** Every key this app writes is under this namespace, in localStorage and sessionStorage alike. */
const NAMESPACE = 'aparte:'

/**
 * Removes every preference and session flag of Aparté (the keys under `aparte:`), for a device being erased. Other
 * keys stay: the origin is shared, and another site's are not Aparté's to delete.
 */
export function clearPrefs(areas: readonly (ClearableStorage | null)[] = [webArea('local'), webArea('session')]): void {
  for (const area of areas) {
    if (area === null) continue
    try {
      const mine: string[] = []
      for (let i = 0; i < area.length; i++) {
        const key = area.key(i)
        if (key?.startsWith(NAMESPACE)) mine.push(key)
      }
      for (const key of mine) area.removeItem(key)
    } catch {
      // A storage that refuses to be read holds nothing this page could clear.
    }
  }
  notify()
}
