import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import styles from './EmptyState.module.css'

export interface EmptyStateProps {
  title: string
  body?: string
  icon?: LucideIcon
  action?: ReactNode
  /** Heading level of the title inside its screen. */
  level?: 2 | 3
}

/** Teaches what belongs here and offers the next action. */
export function EmptyState({ title, body, icon: Icon, action, level = 2 }: EmptyStateProps) {
  const Heading = level === 2 ? 'h2' : 'h3'
  return (
    <section className={styles.empty}>
      {Icon && (
        <span className={styles.icon} aria-hidden="true">
          <Icon size={22} strokeWidth={1.75} />
        </span>
      )}
      <Heading className={styles.title}>{title}</Heading>
      {body && <p className={styles.body}>{body}</p>}
      {action && <div className={styles.action}>{action}</div>}
    </section>
  )
}
