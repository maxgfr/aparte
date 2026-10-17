import { useId } from 'react'
import styles from './Segmented.module.css'

export interface SegmentedProps<V extends string> {
  label: string
  /** `lang`: an option named in another language than the UI (a language's own name). */
  options: readonly { value: V; label: string; lang?: string }[]
  value: V
  onChange: (value: V) => void
  /** Keep the legend for assistive tech only (e.g. tabs whose options speak for themselves). */
  hideLabel?: boolean
}

/** Segmented control built on native radios: arrow keys move the selection. */
export function Segmented<V extends string>({ label, options, value, onChange, hideLabel = false }: SegmentedProps<V>) {
  const name = useId()
  return (
    <fieldset className={styles.segmented}>
      <legend className={hideLabel ? 'sr-only' : styles.legend}>{label}</legend>
      <div className={styles.track}>
        {options.map((o) => {
          const id = `${name}-${o.value}`
          return (
            <span key={o.value} className={styles.option}>
              <input
                id={id}
                className={styles.input}
                type="radio"
                name={name}
                value={o.value}
                checked={o.value === value}
                onChange={() => onChange(o.value)}
              />
              <label htmlFor={id} className={styles.label} lang={o.lang}>
                {o.label}
              </label>
            </span>
          )
        })}
      </div>
    </fieldset>
  )
}
