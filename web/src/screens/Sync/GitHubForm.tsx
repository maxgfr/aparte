import { type FormEvent, useState } from 'react'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import styles from './Sync.module.css'

export interface GitHubInput {
  readonly owner: string
  readonly repo: string
  readonly branch?: string
  readonly token: string
}

/**
 * Owner, repository, branch and token of a GitHub destination. `onSubmit` returns the problem to show, or null once
 * it is done; the token field is cleared then (it is kept only in the encrypted local record).
 */
export function GitHubForm({
  submitLabel,
  onSubmit,
}: {
  readonly submitLabel: string
  readonly onSubmit: (input: GitHubInput) => Promise<string | null>
}) {
  const t = useT()
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || owner.trim() === '' || repo.trim() === '' || token.trim() === '') {
      setMessage({ ok: false, text: t('sync.required') })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const problem = await onSubmit({
        owner: owner.trim(),
        repo: repo.trim(),
        ...(branch.trim() ? { branch: branch.trim() } : {}),
        token: token.trim(),
      })
      setMessage(problem === null ? null : { ok: false, text: problem })
      if (problem === null) setToken('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className={styles.form} onSubmit={(e) => void submit(e)} noValidate>
      <p className={styles.muted}>{t('sync.githubHint')}</p>
      <Field
        label={t('sync.ghOwner')}
        value={owner}
        onChange={(e) => setOwner(e.target.value)}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
      />
      <Field
        label={t('sync.ghRepo')}
        value={repo}
        onChange={(e) => setRepo(e.target.value)}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
      />
      <Field
        label={t('sync.ghBranch')}
        value={branch}
        onChange={(e) => setBranch(e.target.value)}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
      />
      <Field
        label={t('sync.ghToken')}
        hint={`${t('sync.ghTokenHint')} ${t('sync.credentialsHint')}`}
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <Button type="submit" variant="primary" loading={busy}>
        {busy ? t('sync.checking') : submitLabel}
      </Button>
      {message && (
        <p className={message.ok ? styles.status : styles.error} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
    </form>
  )
}
