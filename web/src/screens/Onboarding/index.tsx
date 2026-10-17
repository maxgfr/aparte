import { useState } from 'react'
import { Redirect } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useVault } from '../../app/vault.tsx'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { nextPaint } from './busy.ts'
import styles from './Onboarding.module.css'
import { PassphraseChooser } from './PassphraseChooser.tsx'

/**
 * First run: choose a passphrase and create the vault (a new Secret Key, remembered on this device, and a recovery
 * key). The Emergency Kit takes over the screen as soon as the vault exists.
 */
export default function Onboarding() {
  const t = useT()
  const { status, create } = useVault()
  const [passphrase, setPassphrase] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  if (status.state !== 'absent' && !busy) return <Redirect to={paths.welcome} replace />

  const submit = async () => {
    if (passphrase === null || busy) return
    setBusy(true)
    setFailed(false)
    await nextPaint()
    try {
      await create({ passphrase })
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  return (
    <Screen title={t('vault.createTitle')} back={paths.welcome}>
      <form
        className={styles.form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <p className={styles.lead}>{t('vault.createLead')}</p>
        <PassphraseChooser label={t('vault.generatedLabel')} onChange={setPassphrase} disabled={busy} />
        {failed && (
          <p className={styles.error} role="alert">
            {t('vault.createFailed')}
          </p>
        )}
        <div className={styles.actions}>
          <Button type="submit" variant="primary" size="large" loading={busy} disabled={passphrase === null}>
            {t('vault.create')}
          </Button>
          <p className={styles.status} role="status">
            {busy ? t('vault.creating') : ''}
          </p>
        </div>
      </form>
    </Screen>
  )
}
