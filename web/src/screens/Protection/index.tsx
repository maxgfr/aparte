import { useId, useState } from 'react'
import { Link } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useSync } from '../../app/sync.tsx'
import { useToast } from '../../app/toast.tsx'
import { useVault } from '../../app/vault.tsx'
import { useT } from '../../i18n/react.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { errorCode, nextPaint } from '../Protect/busy.ts'
import styles from './Protection.module.css'

/*
 * Whether a passphrase protects the vault, what that changes, and the way to add it (screens/Protect) or to remove it.
 * A `device` vault opens with a key this device keeps (spec/FORMAT.md section 17): safe from a copy of the disk, not
 * from someone at this browser or another site of the origin, and it cannot sync. Removing the protection needs the
 * passphrase, and is refused while this device syncs, since sync needs the keyslots.
 */

/** The protection of the vault, as one row with its state. */
export function ProtectionStatus() {
  const t = useT()
  const { status } = useVault()
  const device = status.protection !== 'passphrase'
  return (
    <span className={styles.state} data-state={device ? 'device' : 'passphrase'} data-testid="protection-status">
      {t(device ? 'vault.protectionDevice' : 'vault.protectionPassphrase')}
    </span>
  )
}

function Unprotect() {
  const t = useT()
  const toast = useToast()
  const sync = useSync()
  const { unprotect } = useVault()
  const [passphrase, setPassphrase] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const headingId = useId()

  const submit = async () => {
    if (busy) return
    if (passphrase === '') {
      setError(t('vault.emptyPassphrase'))
      return
    }
    setBusy(true)
    setError(null)
    await nextPaint()
    try {
      await unprotect(passphrase)
      setPassphrase('')
      toast(t('vault.unprotected'))
    } catch (e) {
      const code = errorCode(e)
      setError(t(code === 'wrong-secret' ? 'vault.wrongPassphrase' : 'vault.unprotectFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.section} aria-labelledby={headingId}>
      <h2 id={headingId} className={styles.sectionTitle}>
        {t('vault.unprotectTitle')}
      </h2>
      <p className={styles.prose}>{t('vault.unprotectBody')}</p>
      {sync.destinations.length > 0 ? (
        <p className={styles.note}>{t('vault.unprotectSyncFirst')}</p>
      ) : (
        <form
          className={styles.form}
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Field
            label={t('vault.passphraseLabel')}
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            error={error ?? undefined}
            autoComplete="current-password"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            enterKeyHint="go"
            readOnly={busy}
          />
          <div className={styles.actions}>
            <Button type="submit" variant="danger" loading={busy}>
              {busy ? t('vault.unprotecting') : t('vault.unprotect')}
            </Button>
          </div>
        </form>
      )}
    </section>
  )
}

export default function Protection() {
  const t = useT()
  const { status } = useVault()
  const device = status.protection !== 'passphrase'
  return (
    <Screen title={t('vault.protectionTitle')} back={paths.more}>
      <div className={styles.stack}>
        <ListGroup title={t('vault.protectionTitle')} hideTitle>
          <ListRow wrap title={t('about.vaultProtection')} trailing={<ProtectionStatus />} />
        </ListGroup>
        {device ? (
          <>
            <div className={styles.prose}>
              <p>{t('vault.protectionDeviceBody')}</p>
              <p>{t('vault.protectionDeviceFix')}</p>
            </div>
            <div className={styles.actions}>
              <Link href={paths.protect} className={buttonClass({ variant: 'primary', size: 'large' })}>
                {t('vault.protectAction')}
              </Link>
              <Link href={paths.syncJoin} className={buttonClass({ variant: 'secondary' })}>
                {t('sync.welcomeJoin')}
              </Link>
            </div>
          </>
        ) : (
          <>
            <p className={styles.prose}>{t('vault.protectionPassphraseBody')}</p>
            <Unprotect />
          </>
        )}
      </div>
    </Screen>
  )
}
