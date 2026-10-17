import { ScrollText } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../components/Button.tsx'
import { IconButton } from '../components/IconButton.tsx'
import { Sheet } from '../components/Sheet.tsx'
import styles from './Chat.module.css'

/**
 * The system prompt of a chat. Before the first message it is the conversation's own prompt and may be rewritten;
 * once the chat has started it is frozen (the provider reuses the start of the conversation), so a change becomes a
 * new instruction appended at the current point instead.
 */
export function SystemPromptButton({
  value,
  frozen,
  onSave,
}: {
  value: string
  frozen: boolean
  onSave: (text: string) => Promise<void> | void
}) {
  const t = useT()
  const id = useId()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setDraft(frozen ? '' : value)
  }, [open, frozen, value])
  const unchanged = frozen ? draft.trim() === '' : draft === value
  return (
    <>
      <IconButton icon={ScrollText} label={t('chat.systemTitle')} onClick={() => setOpen(true)} />
      <Sheet open={open} title={t('chat.systemTitle')} onClose={() => setOpen(false)}>
        <div className={styles.systemSheet}>
          {frozen && (
            <div className={styles.systemCurrent}>
              <p className={styles.caption}>{t('chat.systemTitle')}</p>
              <p className={styles.systemText}>{value === '' ? t('chat.systemEmpty') : value}</p>
            </div>
          )}
          <label htmlFor={id} className={styles.fieldLabel}>
            {t('chat.systemLabel')}
          </label>
          <textarea
            id={id}
            className={styles.textarea}
            rows={6}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-describedby={`${id}-hint`}
          />
          <p id={`${id}-hint`} className={styles.footnote}>
            {frozen ? t('chat.systemHintAfter') : t('chat.systemHintBefore')}
          </p>
          <div className={styles.sheetActions}>
            <Button
              variant="primary"
              loading={busy}
              disabled={unchanged}
              onClick={async () => {
                setBusy(true)
                try {
                  await onSave(frozen ? draft.trim() : draft)
                  setOpen(false)
                } finally {
                  setBusy(false)
                }
              }}
            >
              {frozen ? t('chat.systemApply') : t('chat.save')}
            </Button>
            <Button variant="plain" onClick={() => setOpen(false)}>
              {t('chat.cancel')}
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  )
}
