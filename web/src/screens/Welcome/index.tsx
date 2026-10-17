import { LockKeyhole } from 'lucide-react'
import { Link } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useVault } from '../../app/vault.tsx'
import { useT } from '../../i18n/react.tsx'
import { buttonClass } from '../../ui/components/Button.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import styles from './Welcome.module.css'

/**
 * The start screen of the preview: what Aparté is and, on a device without a vault, the first step (creating it).
 * With the vault open it says so and offers to lock it; the chat arrives in a later milestone.
 */
export default function Welcome() {
  const t = useT()
  const { status } = useVault()
  const absent = status.state === 'absent'
  return (
    <Screen title={t('shell.welcomeTitle')}>
      <div className={styles.intro}>
        <p className={styles.lead}>{t('shell.welcomeLead')}</p>
        <p className={styles.preview}>{t('shell.welcomePreview')}</p>
        {!absent && (
          <p className={styles.preview} role="status">
            {status.state === 'locking' ? t('vault.lockDeferred') : t('vault.homeUnlocked')}
          </p>
        )}
      </div>
      <div className={styles.actions}>
        {absent && (
          <Link href={paths.createVault} className={buttonClass({ variant: 'primary', size: 'large' })}>
            <LockKeyhole size={18} strokeWidth={2} aria-hidden="true" />
            {t('shell.welcomeCreateVault')}
          </Link>
        )}
        <Link href={paths.about} className={buttonClass({ variant: 'plain' })}>
          {t('shell.welcomeLearnMore')}
        </Link>
      </div>
    </Screen>
  )
}
