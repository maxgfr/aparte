import { RefreshCw } from 'lucide-react'
import { type FormEvent, useEffect, useId, useState } from 'react'
import { Link, Redirect } from 'wouter'
import { useSessionState } from '../../app/chat.tsx'
import { paths } from '../../app/routes.ts'
import { type DestinationView, useSync } from '../../app/sync.tsx'
import { useToast } from '../../app/toast.tsx'
import { useVault } from '../../app/vault.tsx'
import type { Bytes } from '../../core/contracts/crypto.ts'
import type { AlarmKind, DestState, DestStatus, SyncAlarm } from '../../core/contracts/sync.ts'
import { formatBytes, formatDate, formatDuration, formatRelative } from '../../i18n/format.ts'
import type { Key } from '../../i18n/index.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { GitHubForm } from './GitHubForm.tsx'
import styles from './Sync.module.css'

/*
 * The sync screen: every destination with its state, its queue and what the store said last, the integrity alerts
 * (spec/FORMAT.md section 10.3), and the forms that add a destination. Credentials typed here go to the encrypted
 * local records only (app/sync.tsx); nothing on this screen is synced.
 */

const STATE: Record<DestState, Key> = {
  idle: 'sync.stateIdle',
  syncing: 'sync.stateSyncing',
  backoff: 'sync.stateBackoffSoon',
  'needs-auth': 'sync.stateNeedsAuth',
  'needs-permission': 'sync.stateNeedsPermission',
  error: 'sync.stateError',
  offline: 'sync.stateOffline',
}

const ALARM: Record<AlarmKind, Key> = {
  rollback: 'sync.alarmRollback',
  withheld: 'sync.alarmWithheld',
  unreturned: 'sync.alarmUnreturned',
  fork: 'sync.alarmFork',
  tampered: 'sync.alarmTampered',
}

const KIND: Record<DestinationView['kind'], Key> = {
  github: 'sync.kindGithub',
  s3: 'sync.kindS3',
  folder: 'sync.kindFolder',
}

/** GitHub recommends repositories below 1 GB. */
const SIZE_WARNING = 1024 ** 3
/** A token that expires within this is worth a warning. */
const EXPIRY_WARNING_MS = 7 * 24 * 3_600_000

type Tab = 'github' | 's3' | 'folder' | 'archive'

/** Saves `bytes` as a file through a temporary object URL, revoked at once. */
function download(bytes: Bytes, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(handle)
  }, [ms])
  return now
}

function Destination({ view, status }: { readonly view: DestinationView; readonly status: DestStatus | undefined }) {
  const t = useT()
  const locale = useLocale()
  const sync = useSync()
  const toast = useToast()
  const now = useNow()
  const state = status?.state ?? 'idle'
  const info = status?.info
  const expires = info?.credentialsExpireAt
  return (
    <li className={styles.dest} data-destination={view.kind}>
      <div className={styles.destHead}>
        <h3 className={styles.destName}>{view.label}</h3>
        <span className={styles.state} data-state={state} role="status">
          {state === 'backoff' && status?.nextTryAt !== undefined
            ? t('sync.stateBackoff', { time: formatRelative(locale, status.nextTryAt, now) })
            : t(STATE[state])}
        </span>
      </div>
      <p className={styles.detail}>
        {t(KIND[view.kind])}
        {' · '}
        {status?.lastOkAt !== undefined
          ? t('sync.lastSync', { time: formatRelative(locale, status.lastOkAt, now) })
          : t('sync.neverSynced')}
      </p>
      {status !== undefined && status.queued > 0 && (
        <p className={styles.detail}>
          {t('sync.queued', { count: status.queued })}
          {status.etaMs !== undefined && status.etaMs > 0 && (
            <>
              {' · '}
              {t('sync.eta', { duration: formatDuration(locale, status.etaMs) })}
            </>
          )}
        </p>
      )}
      {status?.error !== undefined && state !== 'idle' && (
        <p className={styles.detail}>{t('sync.lastError', { message: status.error.message })}</p>
      )}
      {info?.sizeBytes !== undefined && info.sizeBytes >= SIZE_WARNING && (
        <p className={styles.warning}>{t('sync.repoSize', { size: formatBytes(locale, info.sizeBytes) })}</p>
      )}
      {info?.isPublic === true && view.kind === 'github' && <p className={styles.warning}>{t('sync.repoPublic')}</p>}
      {expires !== undefined && expires - now < EXPIRY_WARNING_MS && (
        <p className={styles.warning}>
          {expires <= now ? t('sync.tokenExpired') : t('sync.tokenExpires', { date: formatDate(locale, expires) })}
        </p>
      )}
      {view.needsFolder && <p className={styles.detail}>{t('sync.folderAgainHint')}</p>}
      <div className={styles.row}>
        {view.needsFolder && (
          <Button variant="primary" onClick={() => void sync.reconnectFolder(view.id).catch(() => undefined)}>
            {t('sync.folderAgain')}
          </Button>
        )}
        {state === 'needs-permission' && view.kind === 'folder' && !view.needsFolder && (
          <Button onClick={() => void sync.reconnectFolder(view.id).catch(() => undefined)}>
            {t('sync.grantAccess')}
          </Button>
        )}
        <Button
          variant="plain"
          onClick={() =>
            void sync.remove(view.id).then(
              () => toast(t('sync.removed')),
              () => undefined,
            )
          }
        >
          {t('sync.remove')}
        </Button>
      </div>
    </li>
  )
}

function Alarm({ alarm }: { readonly alarm: SyncAlarm }) {
  const t = useT()
  const locale = useLocale()
  const sync = useSync()
  return (
    <li className={styles.alarm} data-alarm={alarm.kind}>
      <p>
        <strong>{t(ALARM[alarm.kind])}</strong>
      </p>
      <p>
        {formatDate(locale, alarm.at)} · {alarm.detail}
      </p>
      <Button variant="plain" onClick={() => void sync.dismissAlarm(alarm.id)}>
        {t('sync.dismiss')}
      </Button>
    </li>
  )
}

function S3Form() {
  const t = useT()
  const sync = useSync()
  const toast = useToast()
  const [endpoint, setEndpoint] = useState('')
  const [region, setRegion] = useState('auto')
  const [bucket, setBucket] = useState('')
  const [prefix, setPrefix] = useState('')
  const [accessKeyId, setAccessKeyId] = useState('')
  const [secretAccessKey, setSecretAccessKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rule = sync.corsRule(location.origin)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    let url: URL
    try {
      url = new URL(endpoint.trim())
    } catch {
      setError(t('sync.invalidUrl'))
      return
    }
    const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
      setError(t('sync.invalidUrl'))
      return
    }
    if ([region, bucket, accessKeyId, secretAccessKey].some((v) => v.trim() === '')) {
      setError(t('sync.required'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      await sync.connectS3({
        endpoint: url.origin + url.pathname.replace(/\/+$/, ''),
        region: region.trim(),
        bucket: bucket.trim(),
        ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
        accessKeyId: accessKeyId.trim(),
        secretAccessKey: secretAccessKey.trim(),
      })
      setSecretAccessKey('')
      toast(t('sync.connected', { name: bucket.trim() }))
    } catch (cause) {
      setError(t('sync.s3Problem', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className={styles.form} onSubmit={(e) => void submit(e)} noValidate>
      <p className={styles.muted}>{t('sync.s3Hint')}</p>
      <Field
        label={t('sync.s3Endpoint')}
        hint={t('sync.s3EndpointHint')}
        type="url"
        value={endpoint}
        onChange={(e) => setEndpoint(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <Field
        label={t('sync.s3Region')}
        value={region}
        onChange={(e) => setRegion(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <Field
        label={t('sync.s3Bucket')}
        value={bucket}
        onChange={(e) => setBucket(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <Field
        label={t('sync.s3Prefix')}
        value={prefix}
        onChange={(e) => setPrefix(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <Field
        label={t('sync.s3AccessKey')}
        value={accessKeyId}
        onChange={(e) => setAccessKeyId(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <Field
        label={t('sync.s3SecretKey')}
        hint={t('sync.credentialsHint')}
        type="password"
        value={secretAccessKey}
        onChange={(e) => setSecretAccessKey(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      {rule && (
        <section className={styles.section} aria-labelledby="s3-cors">
          <h3 id="s3-cors" className={styles.destName}>
            {t('sync.s3Cors')}
          </h3>
          <p className={styles.muted}>{t('sync.s3CorsLead')}</p>
          <pre className={styles.code}>{rule.json}</pre>
        </section>
      )}
      <Button type="submit" variant="primary" loading={busy}>
        {busy ? t('sync.checking') : t('sync.connect')}
      </Button>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </form>
  )
}

function ArchivePanel() {
  const t = useT()
  const sync = useSync()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()
  const exportNow = async () => {
    setBusy(true)
    setError(null)
    try {
      const { bytes, count } = await sync.exportArchive()
      download(bytes, 'vault.aparte.zip', 'application/zip')
      toast(t('sync.zipExported', { count }))
    } catch (cause) {
      setError(t('sync.zipFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setBusy(false)
    }
  }
  const importFile = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      await sync.importArchive(new Uint8Array(await file.arrayBuffer()))
      toast(t('sync.zipImported'))
    } catch (cause) {
      setError(t('sync.zipFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={styles.form}>
      <p className={styles.muted}>{t('sync.zipHint')}</p>
      <Button onClick={() => void exportNow()} loading={busy}>
        {t('sync.zipExport')}
      </Button>
      <label htmlFor={inputId} className={styles.muted}>
        {t('sync.zipImport')}
      </label>
      <input
        id={inputId}
        className={styles.file}
        type="file"
        accept=".zip,application/zip"
        disabled={busy}
        onChange={(e) => void importFile(e.target.files?.[0])}
      />
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function AddDestination() {
  const t = useT()
  const sync = useSync()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('github')
  const problem = (p: string): string => {
    const keys: Record<string, Key> = {
      token: 'sync.ghProblemToken',
      'not-found': 'sync.ghProblemNotFound',
      'no-access': 'sync.ghProblemNoAccess',
      'read-only': 'sync.ghProblemReadOnly',
      'rate-limited': 'sync.ghProblemRateLimited',
      network: 'sync.ghProblemNetwork',
    }
    return t(keys[p] ?? 'sync.ghProblemNetwork')
  }
  return (
    <section className={styles.section} aria-labelledby="sync-add">
      <h2 id="sync-add" className={styles.sectionTitle}>
        {t('sync.addTitle')}
      </h2>
      <Segmented
        label={t('sync.addTitle')}
        hideLabel
        value={tab}
        onChange={setTab}
        options={[
          { value: 'github', label: t('sync.tabGithub') },
          { value: 's3', label: t('sync.tabS3') },
          { value: 'folder', label: t('sync.tabFolder') },
          { value: 'archive', label: t('sync.kindZip') },
        ]}
      />
      {tab === 'github' && (
        <GitHubForm
          submitLabel={t('sync.connect')}
          onSubmit={async (input) => {
            const check = await sync.connectGitHub(input)
            if (!check.ok) return problem(check.problem)
            toast(t('sync.connected', { name: `${input.owner}/${input.repo}` }))
            return null
          }}
        />
      )}
      {tab === 's3' && <S3Form />}
      {tab === 'folder' && (
        <div className={styles.form}>
          <p className={styles.muted}>{sync.folderSupported ? t('sync.folderHint') : t('sync.folderUnsupported')}</p>
          {sync.folderSupported && (
            <Button onClick={() => void sync.connectFolder().catch(() => undefined)}>{t('sync.folderChoose')}</Button>
          )}
        </div>
      )}
      {tab === 'archive' && <ArchivePanel />}
    </section>
  )
}

/**
 * A `device` vault cannot sync: another device has no way to open it (spec/FORMAT.md section 17). The screen says so
 * and leads to the passphrase protection, and to joining the vault another device already syncs.
 */
function NeedsPassphrase() {
  const t = useT()
  return (
    <Screen title={t('sync.title')}>
      <section className={styles.section} aria-labelledby="sync-needs-passphrase" data-testid="sync-needs-passphrase">
        <h2 id="sync-needs-passphrase" className={styles.sectionTitle}>
          {t('sync.needsPassphraseTitle')}
        </h2>
        <p className={styles.lead}>{t('sync.needsPassphraseBody')}</p>
        <div className={styles.row}>
          <Link href={paths.protect} className={buttonClass({ variant: 'primary' })}>
            {t('vault.protectAction')}
          </Link>
          <Link href={paths.syncJoin} className={buttonClass({ variant: 'secondary' })}>
            {t('sync.welcomeJoin')}
          </Link>
        </div>
      </section>
    </Screen>
  )
}

export default function Sync() {
  const t = useT()
  const { status: vault } = useVault()
  const session = useSessionState()
  const sync = useSync()
  if (vault.state === 'absent') return <Redirect to={paths.welcome} replace />
  if (vault.protection === 'device') return <NeedsPassphrase />
  if (session.status !== 'open' || !sync.ready) {
    return (
      <Screen title={t('sync.title')}>
        <p className={styles.muted} role="status">
          {t('sync.opening')}
        </p>
      </Screen>
    )
  }
  const byId = new Map(sync.status.dests.map((d) => [d.id, d]))
  return (
    <Screen
      title={t('sync.title')}
      subtitle={t('sync.lead')}
      trailing={
        sync.destinations.length > 0 && (
          <Button onClick={() => sync.syncNow()} icon={<RefreshCw size={16} strokeWidth={2} aria-hidden="true" />}>
            {t('sync.syncNow')}
          </Button>
        )
      }
    >
      <div className={styles.stack}>
        {sync.status.alarms.length > 0 && (
          <section className={styles.section} aria-labelledby="sync-alarms">
            <h2 id="sync-alarms" className={styles.sectionTitle}>
              {t('sync.alarmsTitle')}
            </h2>
            <p className={styles.lead}>{t('sync.alarmsLead')}</p>
            <ul className={styles.list}>
              {sync.status.alarms.map((a) => (
                <Alarm key={a.id} alarm={a} />
              ))}
            </ul>
          </section>
        )}
        <section className={styles.section} aria-labelledby="sync-destinations">
          <h2 id="sync-destinations" className={styles.sectionTitle}>
            {t('sync.destinations')}
          </h2>
          {sync.destinations.length === 0 ? (
            <p className={styles.muted}>{t('sync.noDestination')}</p>
          ) : (
            <ul className={styles.list}>
              {sync.destinations.map((d) => (
                <Destination key={d.id} view={d} status={byId.get(d.id)} />
              ))}
            </ul>
          )}
        </section>
        <AddDestination />
      </div>
    </Screen>
  )
}
