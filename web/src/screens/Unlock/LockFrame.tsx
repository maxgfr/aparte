import type { ReactNode } from 'react'
import styles from './LockFrame.module.css'

/**
 * The closed room: the lock background, the mark, one serif title and the form below it. It replaces the whole app
 * shell while the vault is locked, so it is the page's only main landmark.
 */
export function LockFrame({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <main id="main" className={styles.room} tabIndex={-1}>
      <div className={styles.panel}>
        <img className={styles.mark} src={`${import.meta.env.BASE_URL}logo.svg`} alt="" width={56} height={56} />
        <h1 className={styles.title}>{title}</h1>
        {children}
      </div>
    </main>
  )
}
