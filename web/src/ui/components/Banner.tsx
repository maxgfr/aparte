import type { ReactNode } from 'react'
import styles from './Banner.module.css'

export interface BannerProps {
  title: string
  body: string
  action?: ReactNode
}

/** Blocking alert pinned to the top of every screen: data is at risk until it goes away. */
export function Banner({ title, body, action }: BannerProps) {
  return (
    <div className={styles.banner} role="alert">
      <p className={styles.text}>
        <strong className={styles.title}>{title}</strong>
        {body}
      </p>
      {action}
    </div>
  )
}
