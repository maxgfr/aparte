import { ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { goBack, hashFor } from '../../app/hashLocation.ts'
import { useT } from '../../i18n/react.tsx'
import styles from './Screen.module.css'

export interface ScreenProps {
  title: string
  /** Shown below the title for context. */
  subtitle?: string
  trailing?: ReactNode
  /**
   * Route of the logical parent screen: shows a back link. It returns to the screen this one was opened from (a
   * history pop, as the browser's back does), or to this parent when opened directly.
   */
  back?: string
  children?: ReactNode
}

/** Standard screen: large title, optional context line and trailing control, content capped near 720px. */
export function Screen({ title, subtitle, trailing, back, children }: ScreenProps) {
  const t = useT()
  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        {back !== undefined && (
          <div className={styles.bar}>
            <a
              href={hashFor(back)}
              className={styles.back}
              onClick={(e) => {
                if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
                e.preventDefault()
                goBack(back)
              }}
            >
              <ChevronLeft size={20} strokeWidth={2} aria-hidden="true" />
              {t('common.back')}
            </a>
          </div>
        )}
        {/* The trailing control sits on the title's first line; the title wraps beside it, never under it. */}
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{title}</h1>
          {trailing && <div className={styles.trailing}>{trailing}</div>}
        </div>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </header>
      <div className={styles.body}>{children}</div>
    </div>
  )
}
