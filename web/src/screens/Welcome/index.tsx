import { SquarePen } from 'lucide-react'
import { Link } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useVault } from '../../app/vault.tsx'
import { useT } from '../../i18n/react.tsx'
import { buttonClass } from '../../ui/components/Button.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import styles from './Welcome.module.css'

/**
 * The start screen: what Aparté is, whether a passphrase protects the vault, and the way to a new chat and to the
 * model providers. A device with no vault never shows it empty: the vault is made before anything renders.
 */
export default function Welcome() {
  const t = useT()
  const { status } = useVault()
  const device = status.protection === 'device'
  return (
    <Screen title={t('shell.welcomeTitle')}>
      <div className={styles.intro}>
        <p className={styles.lead}>{t('shell.welcomeLead')}</p>
        <p className={styles.preview}>{t('shell.welcomePreview')}</p>
        <p className={styles.preview} role="status">
          {status.state === 'locking' ? t('vault.lockDeferred') : t(device ? 'vault.homeDevice' : 'vault.homeUnlocked')}
        </p>
      </div>
      <div className={styles.actions}>
        <Link href={paths.chat} className={buttonClass({ variant: 'primary', size: 'large' })}>
          <SquarePen size={18} strokeWidth={2} aria-hidden="true" />
          {t('chat.navNewChat')}
        </Link>
        <Link href={paths.providers} className={buttonClass({ variant: 'secondary' })}>
          {t('chat.navProviders')}
        </Link>
        {device && (
          <Link href={paths.protection} className={buttonClass({ variant: 'secondary' })}>
            {t('vault.protectAction')}
          </Link>
        )}
        <Link href={paths.about} className={buttonClass({ variant: 'plain' })}>
          {t('shell.welcomeLearnMore')}
        </Link>
      </div>
    </Screen>
  )
}
