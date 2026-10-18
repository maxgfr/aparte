import { useCallback, useSyncExternalStore } from 'react'
import { type PrefName, type PrefValue, readPref, subscribePrefs } from './prefs.ts'

/** One device preference (app/prefs.ts), re-read when it changes here or in another tab. */
export function usePref<N extends PrefName>(name: N): PrefValue<N> {
  const read = useCallback(() => readPref(name), [name])
  return useSyncExternalStore(subscribePrefs, read, read)
}
