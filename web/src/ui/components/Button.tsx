import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cx } from '../cx.ts'
import styles from './Button.module.css'

export type ButtonVariant = 'primary' | 'secondary' | 'plain' | 'danger'

export interface ButtonStyle {
  variant?: ButtonVariant
  size?: 'regular' | 'large'
  full?: boolean
}

/** Class list of a button, for links that must look like one. */
export function buttonClass({ variant = 'secondary', size = 'regular', full = false }: ButtonStyle = {}): string {
  return cx(styles.button, styles[variant], size === 'large' && styles.large, full && styles.full)
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, ButtonStyle {
  loading?: boolean
  icon?: ReactNode
}

export function Button({
  variant,
  size,
  full,
  loading = false,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(buttonClass({ variant, size, full }), className)}
    >
      {loading ? <span className={styles.spinner} aria-hidden="true" /> : icon}
      {children}
    </button>
  )
}
