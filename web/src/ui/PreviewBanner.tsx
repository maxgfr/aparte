import { FlaskConical } from 'lucide-react'
import { useT } from '../i18n/react.tsx'
import styles from './PreviewBanner.module.css'

/**
 * A standing note on every screen while the storage format is still allowed to change: whatever is kept now may
 * not open in a later build. It goes away with the release that freezes `aparte/1`.
 */
export function PreviewBanner() {
  const t = useT()
  return (
    <aside className={styles.wrap} aria-label={t('shell.previewLabel')}>
      <p className={styles.banner}>
        <FlaskConical className={styles.icon} size={16} strokeWidth={2} aria-hidden="true" />
        <span>{t('shell.preview')}</span>
      </p>
    </aside>
  )
}
