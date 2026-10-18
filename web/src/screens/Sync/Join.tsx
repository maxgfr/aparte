import { useId, useState } from 'react'
import { Redirect } from 'wouter'
import { paths } from '../../app/routes.ts'
import { joinFromStore } from '../../app/sync.tsx'
import { useVault } from '../../app/vault.tsx'
import { AparteError } from '../../core/contracts/crypto.ts'
import { RemoteError } from '../../core/contracts/sync.ts'
import { useT } from '../../i18n/react.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { GitHubForm } from './GitHubForm.tsx'
import styles from './Sync.module.css'

/*
 * A device without a vault takes one from the store another device syncs to: it reads the keyslots there (the only
 * plaintext a store holds), holds the vault locked, and the lock screen then asks for the passphrase and the Secret
 * Key. The destination is kept in memory until that unlock, which stores it encrypted and syncs everything.
 */

type Source = 'github' | 'archive'

export default function Join() {
  const t = useT()
  const { vault, status } = useVault()
  const [source, setSource] = useState<Source>('github')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileId = useId()
  if (status.state !== 'absent') return <Redirect to={paths.welcome} replace />

  const explain = (cause: unknown): string => {
    if (cause instanceof RemoteError && cause.kind === 'not-found') return t('sync.joinNone')
    if (cause instanceof RemoteError && cause.kind === 'incompatible') return t('sync.joinOther')
    if (cause instanceof AparteError) return t('sync.joinOther')
    return t('sync.joinFailed', { message: cause instanceof Error ? cause.message : String(cause) })
  }

  const fromArchive = async (file: File | undefined) => {
    if (!file || busy) return
    setBusy(true)
    setError(null)
    try {
      await joinFromStore(vault, { kind: 'archive', bytes: new Uint8Array(await file.arrayBuffer()) })
    } catch (cause) {
      setError(explain(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen title={t('sync.joinTitle')} subtitle={t('sync.joinLead')} back={paths.welcome}>
      <div className={styles.stack}>
        <Segmented
          label={t('sync.joinTitle')}
          hideLabel
          value={source}
          onChange={(v) => {
            setSource(v)
            setError(null)
          }}
          options={[
            { value: 'github', label: t('sync.joinGithub') },
            { value: 'archive', label: t('sync.joinArchive') },
          ]}
        />
        {source === 'github' && (
          <GitHubForm
            submitLabel={t('sync.joinFind')}
            onSubmit={async (input) => {
              try {
                await joinFromStore(vault, { kind: 'github', config: input })
                return null
              } catch (cause) {
                return explain(cause)
              }
            }}
          />
        )}
        {source === 'archive' && (
          <div className={styles.form}>
            <label htmlFor={fileId} className={styles.muted}>
              {t('sync.joinArchivePick')}
            </label>
            <input
              id={fileId}
              className={styles.file}
              type="file"
              accept=".zip,application/zip"
              disabled={busy}
              onChange={(e) => void fromArchive(e.target.files?.[0])}
            />
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </div>
    </Screen>
  )
}
