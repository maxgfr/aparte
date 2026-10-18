import { useEffect, useId, useState } from 'react'
import { goBack } from '../../app/hashLocation.ts'
import { paths } from '../../app/routes.ts'
import { useToast } from '../../app/toast.tsx'
import { useVault } from '../../app/vault.tsx'
import type { Key } from '../../i18n/index.ts'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { errorCode, nextPaint } from '../Protect/busy.ts'
import { PassphraseChooser } from '../Protect/PassphraseChooser.tsx'
import frame from '../Unlock/LockFrame.module.css'
import { LockFrame } from '../Unlock/LockFrame.tsx'

/**
 * Unlocks with the recovery key from the Emergency Kit and sets a new passphrase in the same step (the vault adds a
 * passphrase slot, then removes the previous ones from this device). When this device does not remember the Secret Key, the vault
 * pairs the new passphrase with a new one and the Emergency Kit screen follows.
 */
export default function Recovery() {
  const t = useT()
  const toast = useToast()
  const { recover } = useVault()
  const [recoveryKey, setRecoveryKey] = useState('')
  const [next, setNext] = useState<string | null>(null)
  const [problem, setProblem] = useState<Extract<Key, `vault.${string}`> | null>(null)
  const [busy, setBusy] = useState(false)
  const keyId = useId()

  useEffect(() => {
    document.getElementById(keyId)?.focus()
  }, [keyId])

  const fail = (message: Extract<Key, `vault.${string}`>) => {
    setProblem(message)
    setBusy(false)
    requestAnimationFrame(() => {
      const el = document.getElementById(keyId)
      if (el instanceof HTMLInputElement) el.focus()
    })
  }

  const submit = async () => {
    if (busy || next === null) return
    if (recoveryKey.trim() === '') return fail('vault.emptyRecoveryKey')
    setBusy(true)
    setProblem(null)
    await nextPaint()
    try {
      await recover({ recoveryKey, next })
      toast(t('vault.recovered'))
    } catch (e) {
      const code = errorCode(e)
      fail(
        code === 'wrong-secret'
          ? 'vault.wrongRecoveryKey'
          : code === 'invalid-input'
            ? 'vault.badRecoveryKey'
            : 'vault.recoverFailed',
      )
    }
  }

  return (
    <LockFrame title={t('vault.recoverTitle')}>
      <p className={frame.lead}>{t('vault.recoverLead')}</p>
      <form
        className={frame.form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Field
          id={keyId}
          label={t('vault.recoveryKeyLabel')}
          hint={t('vault.recoveryKeyHint')}
          value={recoveryKey}
          onChange={(e) => setRecoveryKey(e.target.value)}
          error={problem ? t(problem) : undefined}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="characters"
          autoCorrect="off"
          readOnly={busy}
        />
        <PassphraseChooser label={t('vault.newPassphraseLabel')} onChange={setNext} disabled={busy} />
        <Button type="submit" variant="primary" size="large" full loading={busy} disabled={next === null}>
          {t('vault.recover')}
        </Button>
        <p className={frame.notice} role="status">
          {busy ? t('vault.recovering') : ''}
        </p>
      </form>
      <div className={frame.links}>
        <Button variant="plain" onClick={() => goBack(paths.welcome)} disabled={busy}>
          {t('vault.backToUnlock')}
        </Button>
      </div>
    </LockFrame>
  )
}
