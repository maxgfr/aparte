import { useEffect, useId, useState } from 'react'
import { navigate } from '../../app/hashLocation.ts'
import { paths } from '../../app/routes.ts'
import { useVault } from '../../app/vault.tsx'
import type { Key } from '../../i18n/index.ts'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { errorCode, nextPaint } from '../Onboarding/busy.ts'
import styles from './LockFrame.module.css'
import { LockFrame } from './LockFrame.tsx'

type Problem = { readonly field: 'passphrase' | 'secretKey'; readonly message: Extract<Key, `vault.${string}`> }

/**
 * The lock screen: the passphrase, and the Secret Key only when this device does not remember it (or can no longer
 * read its copy, which the first attempt finds out). A wrong entry says which field to check and keeps the text so a
 * typo can be fixed in place.
 */
export default function Unlock() {
  const t = useT()
  const { vault, status, lastLock, unlock } = useVault()
  const needsSecretKey = !status.secretKeyOnDevice
  const [passphrase, setPassphrase] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [problem, setProblem] = useState<Problem | null>(null)
  const [busy, setBusy] = useState(false)
  const passphraseId = useId()
  const secretKeyId = useId()

  const focus = (field: Problem['field']) => {
    const el = document.getElementById(field === 'passphrase' ? passphraseId : secretKeyId)
    if (el instanceof HTMLInputElement) {
      el.focus()
      el.select()
    }
  }

  // The lock screen replaces whatever had focus: the passphrase field takes it, ready to type.
  useEffect(() => {
    document.getElementById(passphraseId)?.focus()
  }, [passphraseId])

  const fail = (p: Problem) => {
    setProblem(p)
    setBusy(false)
    requestAnimationFrame(() => focus(p.field))
  }

  const submit = async () => {
    if (busy) return
    if (passphrase === '') return fail({ field: 'passphrase', message: 'vault.emptyPassphrase' })
    setBusy(true)
    setProblem(null)
    await nextPaint()
    try {
      await unlock(needsSecretKey ? { kind: 'passphrase', passphrase, secretKey } : { kind: 'passphrase', passphrase })
    } catch (e) {
      const code = errorCode(e)
      if (code === 'invalid-input' && !needsSecretKey && !vault.status().secretKeyOnDevice) {
        // The stored copy of the Secret Key did not unwrap: the field appears, and says why.
        fail({ field: 'secretKey', message: 'vault.secretKeyLost' })
      } else if (code === 'wrong-secret') {
        fail({ field: 'passphrase', message: needsSecretKey ? 'vault.wrongWithSecretKey' : 'vault.wrongPassphrase' })
      } else if (code === 'invalid-input' && needsSecretKey) {
        fail({ field: 'secretKey', message: 'vault.badSecretKey' })
      } else if (code === 'invalid-input') {
        fail({ field: 'passphrase', message: 'vault.emptyPassphrase' })
      } else {
        fail({ field: 'passphrase', message: 'vault.unlockFailed' })
      }
    }
  }

  return (
    <LockFrame title={t('common.appName')}>
      <p className={styles.lead}>{t('vault.unlockLead')}</p>
      {lastLock === 'idle' && (
        <p className={styles.notice} role="status">
          {t('vault.lockedIdle')}
        </p>
      )}
      <form
        className={styles.form}
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <Field
          id={passphraseId}
          label={t('vault.passphraseLabel')}
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          error={problem?.field === 'passphrase' ? t(problem.message) : undefined}
          autoComplete="current-password"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          enterKeyHint={needsSecretKey ? 'next' : 'go'}
          readOnly={busy}
        />
        {needsSecretKey && (
          <Field
            id={secretKeyId}
            label={t('vault.secretKeyLabel')}
            hint={t('vault.secretKeyHint')}
            value={secretKey}
            onChange={(e) => setSecretKey(e.target.value)}
            error={problem?.field === 'secretKey' ? t(problem.message) : undefined}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="characters"
            autoCorrect="off"
            enterKeyHint="go"
            readOnly={busy}
          />
        )}
        <Button type="submit" variant="primary" size="large" full loading={busy}>
          {busy ? t('vault.unlocking') : t('vault.unlock')}
        </Button>
      </form>
      <div className={styles.links}>
        <Button variant="plain" onClick={() => navigate(paths.recover)} disabled={busy}>
          {t('vault.forgot')}
        </Button>
      </div>
    </LockFrame>
  )
}
