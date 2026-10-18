import { useId } from 'react'
import styles from './Switch.module.css'

/** An on/off setting: the whole row toggles, its hint saying what the current choice does. */
export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  disabled = false,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (checked: boolean) => void
  /** Shown but not changeable (a setting fixed for now); the hint should say why. */
  disabled?: boolean
}) {
  const labelId = useId()
  const hintId = useId()
  return (
    <label className={styles.row} data-disabled={disabled || undefined}>
      <span className={styles.text}>
        <span id={labelId} className={styles.label}>
          {label}
        </span>
        {hint && (
          <span id={hintId} className={styles.hint}>
            {hint}
          </span>
        )}
      </span>
      <input
        type="checkbox"
        role="switch"
        className={styles.switch}
        checked={checked}
        disabled={disabled}
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={hint ? hintId : undefined}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  )
}
