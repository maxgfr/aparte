import type { ReactNode } from 'react'
import { cx } from '../cx.ts'
import styles from './Keycap.module.css'

/**
 * A keyboard hint, hidden from assistive tech (the control carries aria-keyshortcuts) and shown only
 * where a keyboard is likely. `inline` spaces it after the label it follows.
 */
export function Keycap({ children, inline = true }: { children: ReactNode; inline?: boolean }) {
  return (
    <span className={cx(styles.keycap, inline && styles.inline)} aria-hidden="true">
      <kbd className={styles.key}>{children}</kbd>
    </span>
  )
}
