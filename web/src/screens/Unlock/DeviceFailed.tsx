import { useId, useState } from 'react'
import { navigate } from '../../app/hashLocation.ts'
import { paths } from '../../app/routes.ts'
import { useVault } from '../../app/vault.tsx'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import styles from './LockFrame.module.css'
import { LockFrame } from './LockFrame.tsx'

/**
 * A `device` vault whose device slot no longer opens (its key is missing or damaged, spec/FORMAT.md section 17): no
 * passphrase protects it, so nothing else opens it on this device. The recovery key does, when the vault has a
 * recovery slot; otherwise the way forward is a new, empty vault, which deletes what the old one held once the user
 * says they understand.
 */
export default function DeviceFailed() {
  const t = useT()
  const { status, reset } = useVault()
  const [understood, setUnderstood] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const confirmId = useId()
  const recoverable = status.slots.some((s) => s.kind === 'recovery')

  const startOver = async () => {
    if (!understood || busy) return
    setBusy(true)
    setFailed(false)
    try {
      await reset()
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  return (
    <LockFrame title={t('common.appName')}>
      <p className={styles.lead} role="alert">
        {t('vault.deviceFailedLead')}
      </p>
      <div className={styles.form}>
        <label className={styles.remember} htmlFor={confirmId}>
          <input
            id={confirmId}
            type="checkbox"
            checked={understood}
            onChange={(e) => setUnderstood(e.target.checked)}
            disabled={busy}
          />
          {t('vault.deviceFailedConfirm')}
        </label>
        <Button variant="danger" size="large" full loading={busy} disabled={!understood} onClick={startOver}>
          {t('vault.deviceFailedReset')}
        </Button>
        {failed && (
          <p className={styles.error} role="alert">
            {t('vault.deviceFailedResetFailed')}
          </p>
        )}
      </div>
      {recoverable && (
        <div className={styles.links}>
          <Button variant="plain" onClick={() => navigate(paths.recover)} disabled={busy}>
            {t('vault.forgot')}
          </Button>
        </div>
      )}
    </LockFrame>
  )
}
