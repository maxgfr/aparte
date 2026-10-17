import { useEffect, useState, useSyncExternalStore } from 'react'
import { useT } from '../i18n/react.tsx'
import { updates } from '../pwa/register.ts'
import { Toast } from './components/Toast.tsx'

// Primitive selectors: useSyncExternalStore compares snapshots by identity, so each reads one boolean.
const needRefresh = () => updates.snapshot().needRefresh
const offlineReady = () => updates.snapshot().offlineReady
const never = () => false

/** How long the one-time "works offline" note stays. */
const OFFLINE_NOTE_MS = 5000

/**
 * The service worker's news, as one polite toast. A waiting version is offered, never forced: the reload happens only
 * when the user asks, and `apply()` itself waits for any reply still streaming (see `holdReload`), which the toast
 * says while it waits. "Later" hides the offer until the next version arrives.
 */
export function UpdateToast() {
  const t = useT()
  const refresh = useSyncExternalStore(updates.subscribe, needRefresh, never)
  const offline = useSyncExternalStore(updates.subscribe, offlineReady, never)
  const [dismissed, setDismissed] = useState(false)
  const [applying, setApplying] = useState(false)
  const [offlineShown, setOfflineShown] = useState(false)

  // A new waiting version re-opens an offer that was put off.
  useEffect(() => {
    if (refresh) setDismissed(false)
  }, [refresh])

  useEffect(() => {
    if (!offline) return
    setOfflineShown(true)
    const timer = setTimeout(() => setOfflineShown(false), OFFLINE_NOTE_MS)
    return () => clearTimeout(timer)
  }, [offline])

  if (refresh && !dismissed) {
    if (applying) return <Toast message={t('shell.updateWaiting')} />
    return (
      <Toast
        message={t('shell.updateReady')}
        actions={[
          {
            label: t('shell.updateApply'),
            onClick: () => {
              setApplying(true)
              updates.apply().catch(() => setApplying(false))
            },
          },
          { label: t('common.later'), onClick: () => setDismissed(true) },
        ]}
      />
    )
  }
  if (offlineShown) return <Toast message={t('shell.offlineReady')} />
  return null
}
