import { X } from 'lucide-react'
import { type ReactNode, type RefObject, useEffect, useId, useRef } from 'react'
import { useT } from '../../i18n/react.tsx'
import { cx } from '../cx.ts'
import { IconButton } from './IconButton.tsx'
import styles from './Sheet.module.css'

export interface SheetProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  /** Element focused on open. Defaults to the first field in the body, else the first control. */
  initialFocus?: RefObject<HTMLElement | null>
  /**
   * The whole screen on phones and a full-height panel on the right from 600px, its body a column that scrolls its
   * own parts (a chat thread above its composer). The body brings its own header and close button; `title` only
   * names the sheet.
   */
  fill?: boolean
  /** With `fill`: the whole screen at every width, never a side panel. */
  fullscreen?: boolean
}

const FIELD = 'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])'
const CONTROL = 'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

/** Native modal <dialog>: bottom sheet on phones, centred panel elsewhere (see `fill`). Escape closes it. */
export function Sheet({ open, title, onClose, children, initialFocus, fill = false, fullscreen = false }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const id = useId()
  const t = useT()

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      d.showModal()
      // showModal() focuses the first focusable (Close); move to the field so the phone keyboard opens.
      const body = bodyRef.current
      const target =
        initialFocus?.current ??
        body?.querySelector<HTMLElement>(FIELD) ??
        body?.querySelector<HTMLElement>(CONTROL) ??
        null
      target?.focus()
    } else if (!open && d.open) d.close()
  }, [open, initialFocus])

  return (
    <dialog
      ref={ref}
      className={cx(styles.sheet, fill && styles.fill, fill && fullscreen && styles.fullscreen)}
      aria-labelledby={id}
      onClose={onClose}
    >
      {fill ? (
        <h2 id={id} className="sr-only">
          {title}
        </h2>
      ) : (
        <div className={styles.header}>
          <h2 id={id} className={styles.title}>
            {title}
          </h2>
          <IconButton icon={X} label={t('common.close')} onClick={onClose} />
        </div>
      )}
      <div ref={bodyRef} className={styles.body}>
        {children}
      </div>
    </dialog>
  )
}
