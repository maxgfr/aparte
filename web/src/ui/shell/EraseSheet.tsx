import { type FormEvent, useId, useState } from 'react'
import { useVault } from '../../app/vault.tsx'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../components/Button.tsx'
import { Field } from '../components/Field.tsx'
import { Sheet } from '../components/Sheet.tsx'
import styles from './EraseSheet.module.css'

/**
 * Erasing everything Aparté keeps on this device (app/vault.tsx `erase`), from the lock screen for a user who lost the
 * passphrase and the recovery key (`lost`), or from the settings. It says plainly what goes and what stays, and goes
 * ahead only once the user types the confirmation word of their language and presses the destructive button.
 */
export function EraseSheet({
  open,
  onClose,
  lost = false,
}: {
  readonly open: boolean
  readonly onClose: () => void
  readonly lost?: boolean
}) {
  const t = useT()
  const { erase } = useVault()
  const [typed, setTyped] = useState('')
  const [models, setModels] = useState(false)
  const [busy, setBusy] = useState(false)
  const modelsId = useId()
  const word = t('vault.eraseWord')
  const confirmed = typed.trim().toLocaleLowerCase() === word.toLocaleLowerCase()

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!confirmed || busy) return
    setBusy(true)
    void erase({ models }).finally(() => setBusy(false))
  }

  const close = () => {
    setTyped('')
    setModels(false)
    onClose()
  }

  return (
    <Sheet open={open} title={t('vault.eraseTitle')} onClose={close}>
      <form className={styles.form} noValidate onSubmit={submit} data-testid="erase-sheet">
        <div className={styles.prose}>
          {lost && <p className={styles.lead}>{t('vault.eraseLostLead')}</p>}
          <p>{t('vault.eraseWhat')}</p>
          <p>{t('vault.eraseSynced')}</p>
        </div>
        <label className={styles.option} htmlFor={modelsId}>
          <input
            id={modelsId}
            type="checkbox"
            checked={models}
            onChange={(e) => setModels(e.target.checked)}
            disabled={busy}
          />
          {t('vault.eraseModels')}
        </label>
        <Field
          label={t('vault.eraseConfirmLabel', { word })}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          enterKeyHint="done"
          readOnly={busy}
        />
        <Button type="submit" variant="danger" size="large" loading={busy} disabled={!confirmed}>
          {t('vault.eraseAction')}
        </Button>
      </form>
    </Sheet>
  )
}
