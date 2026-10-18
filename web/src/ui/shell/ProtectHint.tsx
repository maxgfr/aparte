import { X } from 'lucide-react'
import { Link } from 'wouter'
import { writePref } from '../../app/prefs.ts'
import { paths } from '../../app/routes.ts'
import { usePref } from '../../app/usePref.ts'
import { useVault } from '../../app/vault.tsx'
import { useT } from '../../i18n/react.tsx'
import { buttonClass } from '../components/Button.tsx'
import { IconButton } from '../components/IconButton.tsx'
import { cx } from '../cx.ts'
import styles from './ProtectHint.module.css'

/**
 * Says, where a `device` vault is used, that no passphrase protects it, and leads to the setting that adds one. The
 * user can dismiss it for good on this device; the settings and About keep saying it.
 */
export function ProtectHint() {
  const t = useT()
  const { status } = useVault()
  const dismissed = usePref('protectHintDismissed')
  if (status.protection !== 'device' || dismissed) return null
  return (
    <aside className={styles.hint} aria-label={t('vault.protectionDevice')} data-testid="protect-hint">
      <p className={styles.text}>
        <span className={styles.title}>{t('vault.protectionDevice')}</span>
        <span className={styles.body}>{t('vault.hintBody')}</span>
      </p>
      <IconButton icon={X} label={t('vault.hintDismiss')} onClick={() => writePref('protectHintDismissed', true)} />
      <Link href={paths.protection} className={cx(buttonClass({ variant: 'secondary' }), styles.link)}>
        {t('vault.protectAction')}
      </Link>
    </aside>
  )
}
