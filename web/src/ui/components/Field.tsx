import { type InputHTMLAttributes, useId } from 'react'
import { cx } from '../cx.ts'
import styles from './Field.module.css'

export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string
  hint?: string
  error?: string
  hideLabel?: boolean
}

/** Labelled text input; 16px minimum so iOS never zooms. Pass `enterKeyHint` for the return key. */
export function Field({ label, hint, error, hideLabel = false, id: given, className, ...rest }: FieldProps) {
  const auto = useId()
  const id = given ?? auto
  const hintId = hint ? `${id}-hint` : undefined
  const errorId = error ? `${id}-error` : undefined
  return (
    <div className={cx(styles.field, className)}>
      <label htmlFor={id} className={cx(styles.label, hideLabel && 'sr-only')}>
        {label}
      </label>
      <input
        id={id}
        className={styles.input}
        aria-invalid={error ? true : undefined}
        aria-describedby={cx(hintId, errorId) || undefined}
        {...rest}
      />
      {hint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
