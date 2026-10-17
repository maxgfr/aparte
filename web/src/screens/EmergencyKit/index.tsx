import { Printer } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { navigate } from '../../app/hashLocation.ts'
import { paths } from '../../app/routes.ts'
import { useVault } from '../../app/vault.tsx'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import styles from './EmergencyKit.module.css'

/**
 * The Emergency Kit, shown once after the vault is created (Secret Key and recovery key) or after a recovery that
 * paired the new passphrase with a new Secret Key, and again, renewed, at the next unlock when it was never confirmed. It prints on its own (the print stylesheet keeps the kit and a
 * line to write the passphrase by hand), and the app goes on only once the user says the kit is kept.
 */
export default function EmergencyKit() {
  const t = useT()
  const { kit, dismissKit } = useVault()
  const [kept, setKept] = useState(false)
  const keptId = useId()
  const headingId = useId()
  const main = useRef<HTMLElement>(null)

  useEffect(() => {
    main.current?.focus({ preventScroll: true })
  }, [])

  if (kit === null) return null

  const done = () => {
    dismissKit()
    navigate(paths.welcome, { replace: true })
  }

  return (
    <main id="main" ref={main} className={styles.page} tabIndex={-1}>
      <div className={styles.screen}>
        <header className={styles.header}>
          <h1 className={styles.title}>{t('vault.kitTitle')}</h1>
          <p className={styles.lead}>
            {t(
              kit.origin === 'create'
                ? 'vault.kitLead'
                : kit.origin === 'renew'
                  ? 'vault.kitRenewedLead'
                  : 'vault.kitRecoveredLead',
            )}
          </p>
        </header>

        <section className={styles.kit} aria-labelledby={headingId}>
          <h2 id={headingId} className={styles.kitTitle}>
            {t('vault.kitPrintTitle')}
          </h2>
          <dl className={styles.entries}>
            <div className={styles.entry}>
              <dt className={styles.term}>{t('vault.kitVault')}</dt>
              <dd className={styles.value}>{kit.vaultId}</dd>
            </div>
            {kit.secretKey !== null && (
              <div className={styles.entry}>
                <dt className={styles.term}>{t('vault.kitSecretKey')}</dt>
                <dd className={styles.value} data-key="secret-key">
                  {kit.secretKey}
                </dd>
                <dd className={styles.hint}>{t('vault.kitSecretKeyHint')}</dd>
              </div>
            )}
            {kit.recoveryKey !== null && (
              <div className={styles.entry}>
                <dt className={styles.term}>{t('vault.kitRecoveryKey')}</dt>
                <dd className={styles.value} data-key="recovery-key">
                  {kit.recoveryKey}
                </dd>
                <dd className={styles.hint}>{t('vault.kitRecoveryKeyHint')}</dd>
              </div>
            )}
            <div className={styles.entry} data-print-only="">
              <dt className={styles.term}>{t('vault.kitPassphraseLine')}</dt>
              <dd className={styles.blank} />
            </div>
          </dl>
        </section>

        <div className={styles.actions} data-no-print="">
          <Button icon={<Printer size={18} strokeWidth={1.75} aria-hidden="true" />} onClick={() => window.print()}>
            {t('vault.kitPrint')}
          </Button>
          <label className={styles.confirm} htmlFor={keptId}>
            <input id={keptId} type="checkbox" checked={kept} onChange={(e) => setKept(e.target.checked)} />
            <span>{t('vault.kitConfirm')}</span>
          </label>
          <Button variant="primary" size="large" disabled={!kept} onClick={done}>
            {t('vault.kitContinue')}
          </Button>
        </div>
      </div>
    </main>
  )
}
