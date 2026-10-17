import type { LucideIcon } from 'lucide-react'
import type { ButtonHTMLAttributes } from 'react'
import { cx } from '../cx.ts'
import styles from './IconButton.module.css'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Accessible name, also shown as a tooltip. */
  label: string
  icon: LucideIcon
}

export function IconButton({ label, icon: Icon, className, ...rest }: IconButtonProps) {
  return (
    <button type="button" aria-label={label} title={label} {...rest} className={cx(styles.iconButton, className)}>
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
    </button>
  )
}
