import { useState } from 'react'
import { Redirect } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useVault } from '../../app/vault.tsx'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { nextPaint } from './busy.ts'
import { PassphraseChooser } from './PassphraseChooser.tsx'
import styles from './Protect.module.css'

/**
 * Protects the vault with a passphrase (reached from the settings, screens/Protection): a new Secret Key,
 * remembered on this device, and a recovery key. The Emergency Kit takes over the screen as soon as the passphrase
 * slot exists; from then on the vault locks, as any vault a passphrase protects.
 */
export default function Protect() {
  const t = useT()
  const { status, protect } = useVault()
  const [passphrase, setPassphrase] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  if (status.protection === 'passphrase' && !busy && !failed) return <Redirect to={paths.protection} replace />

  const submit = async () => {
    if (passphrase === null || busy) return
    setBusy(true)
    setFailed(false)
    await nextPaint()
    try {
      await protect({ passphrase })
    } catch {
      setFailed(true)
      setBusy(false)
    }
  }

  return (
    <Screen title={t('vault.protectTitle')} back={paths.protection}>
      <form
        className={styles.form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <p className={styles.lead}>{t('vault.protectLead')}</p>
        <PassphraseChooser label={t('vault.generatedLabel')} onChange={setPassphrase} disabled={busy} />
        {failed && (
          <p className={styles.error} role="alert">
            {t('vault.protectFailed')}
          </p>
        )}
        <div className={styles.actions}>
          <Button type="submit" variant="primary" size="large" loading={busy} disabled={passphrase === null}>
            {t('vault.protect')}
          </Button>
          <p className={styles.status} role="status">
            {busy ? t('vault.protecting') : ''}
          </p>
        </div>
      </form>
    </Screen>
  )
}
