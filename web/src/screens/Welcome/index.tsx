import { LockKeyhole } from 'lucide-react'
import { useId } from 'react'
import { Link } from 'wouter'
import { paths } from '../../app/routes.ts'
import { useT } from '../../i18n/react.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import styles from './Welcome.module.css'

/**
 * The start screen of the preview: what Aparté is, that this build is the empty shell, and the first step of the
 * real app shown but not yet available (the vault arrives in the next milestone).
 */
export default function Welcome() {
  const t = useT()
  const comingId = useId()
  return (
    <Screen title={t('shell.welcomeTitle')}>
      <div className={styles.intro}>
        <p className={styles.lead}>{t('shell.welcomeLead')}</p>
        <p className={styles.preview}>{t('shell.welcomePreview')}</p>
      </div>
      <div className={styles.actions}>
        <div className={styles.primary}>
          <Button
            variant="primary"
            size="large"
            icon={<LockKeyhole size={18} strokeWidth={2} aria-hidden="true" />}
            disabled
            aria-describedby={comingId}
          >
            {t('shell.welcomeCreateVault')}
          </Button>
          <span id={comingId} className={styles.badge}>
            {t('shell.welcomeComingNext')}
          </span>
        </div>
        <Link href={paths.about} className={buttonClass({ variant: 'plain' })}>
          {t('shell.welcomeLearnMore')}
        </Link>
      </div>
    </Screen>
  )
}
