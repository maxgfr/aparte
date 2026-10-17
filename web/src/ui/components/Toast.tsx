import styles from './Toast.module.css'

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface ToastProps {
  message: string
  actions?: readonly ToastAction[]
}

/** Polite status message pinned above the tab bar and the keyboard. */
export function Toast({ message, actions = [] }: ToastProps) {
  return (
    <div className={styles.region}>
      <div className={styles.toast} role="status">
        <p className={styles.message}>{message}</p>
        {actions.length > 0 && (
          <div className={styles.actions}>
            {actions.map((a) => (
              <button key={a.label} type="button" className={styles.action} onClick={a.onClick}>
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
