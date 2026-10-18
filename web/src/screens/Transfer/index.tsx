import { useEffect, useId, useState } from 'react'
import { Link } from 'wouter'
import { useConversations, useSession } from '../../app/chat.tsx'
import { paths } from '../../app/routes.ts'
import { useSync } from '../../app/sync.tsx'
import { useToast } from '../../app/toast.tsx'
import { useVault } from '../../app/vault.tsx'
import { cryptoRng } from '../../core/crypto/rng.ts'
import type { ImportSource, ParsedImport } from '../../core/transfer/index.ts'
import type { Key } from '../../i18n/index.ts'
import { useT } from '../../i18n/react.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { saveFile, today } from '../../ui/transfer/download.ts'
import styles from '../../ui/transfer/Transfer.module.css'

/*
 * Import and export. The backup is the sync archive (core/sync/providers/zip.ts) under an `.aparte` name: the store as
 * it is, encrypted, keyslots and photos included, so it carries the vault whole and another device joins from it
 * (screens/Sync/Join.tsx); a vault no passphrase protects has no keyslot, so its backup waits for the protection.
 * Imports read another app's export (core/transfer) and write it as conversations; nothing of the file is stored but
 * the conversations it holds, encrypted like any other.
 *
 * Opened with an `.aparte` file (the manifest's file_handlers, `?launch`), the screen offers to merge it.
 */

const SOURCE_KEYS: Readonly<Record<ImportSource, Extract<Key, `transfer.source${string}`>>> = {
  chatgpt: 'transfer.sourceChatgpt',
  claude: 'transfer.sourceClaude',
  openwebui: 'transfer.sourceOpenwebui',
  aparte: 'transfer.sourceAparte',
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** What the launch queue hands a page opened with a file (the File Handling API). */
interface LaunchQueue {
  setConsumer(consumer: (params: { readonly files: readonly { getFile(): Promise<File> }[] }) => void): void
}

/** The file this page was opened with, once the browser hands it over; null when none. */
function useLaunchedFile(): [File | null, () => void] {
  const [file, setFile] = useState<File | null>(null)
  useEffect(() => {
    const queue = (globalThis as { launchQueue?: LaunchQueue }).launchQueue
    if (queue === undefined) return
    let live = true
    queue.setConsumer((params) => {
      const handle = params.files[0]
      if (handle === undefined) return
      handle.getFile().then(
        (f) => live && setFile(f),
        () => undefined,
      )
    })
    return () => {
      live = false
    }
  }, [])
  return [file, () => setFile(null)]
}

/**
 * A `device` vault has no keyslot another device could open (spec/FORMAT.md section 17): its backup would open
 * nowhere else, so the section leads to the passphrase protection instead.
 */
function BackupNeedsPassphrase() {
  const t = useT()
  const id = useId()
  return (
    <section className={styles.section} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className={styles.sectionTitle}>
        {t('transfer.backupTitle')}
      </h2>
      <p className={styles.lead}>{t('transfer.backupNeedsPassphrase')}</p>
      <Link href={paths.protect} className={buttonClass({ variant: 'primary' })}>
        {t('vault.protectAction')}
      </Link>
    </section>
  )
}

function Backup() {
  const t = useT()
  const sync = useSync()
  const toast = useToast()
  const inputId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [launched, dismiss] = useLaunchedFile()

  const exportNow = async () => {
    setBusy(true)
    setError(null)
    try {
      const { bytes, count } = await sync.exportArchive()
      saveFile(bytes, `aparte-backup-${today()}.aparte`, 'application/octet-stream')
      toast(t('transfer.backupExported', { count }))
    } catch (cause) {
      setError(t('transfer.backupFailed', { message: message(cause) }))
    } finally {
      setBusy(false)
    }
  }
  const merge = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      await sync.importArchive(new Uint8Array(await file.arrayBuffer()))
      toast(t('transfer.backupImported'))
      dismiss()
    } catch (cause) {
      setError(t('transfer.backupFailed', { message: message(cause) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.section} aria-labelledby={`${inputId}-title`}>
      <h2 id={`${inputId}-title`} className={styles.sectionTitle}>
        {t('transfer.backupTitle')}
      </h2>
      <p className={styles.lead}>{t('transfer.backupLead')}</p>
      {launched !== null && (
        <div className={styles.notice} role="status">
          <p className={styles.optionTitle}>{t('transfer.launchTitle')}</p>
          <p className={styles.muted}>{t('transfer.launchBody', { name: launched.name })}</p>
          <div className={styles.row}>
            <Button variant="primary" loading={busy} onClick={() => void merge(launched)}>
              {t('transfer.launchImport')}
            </Button>
            <Button variant="plain" onClick={dismiss}>
              {t('transfer.launchDismiss')}
            </Button>
          </div>
        </div>
      )}
      <Button variant="primary" loading={busy} onClick={() => void exportNow()}>
        {busy ? t('transfer.backupExporting') : t('transfer.backupExport')}
      </Button>
      <div className={styles.pick}>
        <label htmlFor={inputId} className={styles.label}>
          {t('transfer.backupImportLabel')}
        </label>
        <input
          id={inputId}
          className={styles.file}
          type="file"
          accept=".aparte,.zip,application/zip"
          disabled={busy}
          onChange={(e) => {
            void merge(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>
      <p className={styles.muted}>{t('transfer.backupNewDevice')}</p>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function ImportFromApp() {
  const t = useT()
  const session = useSession()
  const toast = useToast()
  const inputId = useId()
  const [parsed, setParsed] = useState<{ value: ParsedImport; count: number } | null>(null)
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'reading' }
    | { kind: 'importing'; done: number; total: number }
    | { kind: 'done'; count: number; failed: number }
  >({ kind: 'idle' })
  const [error, setError] = useState<string | null>(null)

  const read = async (file: File | undefined) => {
    if (!file) return
    setParsed(null)
    setError(null)
    setState({ kind: 'reading' })
    try {
      const transfer = await import('../../core/transfer/index.ts')
      const value = await transfer.parseImport(new Uint8Array(await file.arrayBuffer()))
      const count = transfer.importCount(value)
      if (count === 0) setError(t('transfer.importNone'))
      else setParsed({ value, count })
    } catch {
      setError(t('transfer.importUnknown'))
    } finally {
      setState({ kind: 'idle' })
    }
  }

  const run = async () => {
    if (session === null || parsed === null) return
    setError(null)
    setState({ kind: 'importing', done: 0, total: parsed.count })
    try {
      const transfer = await import('../../core/transfer/index.ts')
      const result = await transfer.applyImport(
        { workspace: session.workspace, blobs: session.blobs, rng: cryptoRng() },
        parsed.value,
        (done, total) => setState({ kind: 'importing', done, total }),
      )
      setParsed(null)
      setState({ kind: 'done', count: result.conversations.length, failed: result.failed })
      toast(t('transfer.importDone', { count: result.conversations.length }))
    } catch (cause) {
      setState({ kind: 'idle' })
      setError(t('transfer.importFailed', { message: message(cause) }))
    }
  }

  const busy = state.kind === 'reading' || state.kind === 'importing'
  return (
    <section className={styles.section} aria-labelledby={`${inputId}-title`}>
      <h2 id={`${inputId}-title`} className={styles.sectionTitle}>
        {t('transfer.importTitle')}
      </h2>
      <p className={styles.lead}>{t('transfer.importLead')}</p>
      <div className={styles.pick}>
        <label htmlFor={inputId} className={styles.label}>
          {t('transfer.importPick')}
        </label>
        <input
          id={inputId}
          className={styles.file}
          type="file"
          accept=".json,.zip,application/json,application/zip"
          disabled={busy}
          onChange={(e) => {
            void read(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>
      <div role="status" aria-live="polite" className={styles.pick}>
        {state.kind === 'reading' && <p className={styles.muted}>{t('transfer.importReading')}</p>}
        {state.kind === 'importing' && (
          <p className={styles.muted}>{t('transfer.importProgress', { done: state.done, total: state.total })}</p>
        )}
        {parsed !== null && (
          <p className={styles.muted}>
            {t('transfer.importFound', { count: parsed.count, source: t(SOURCE_KEYS[parsed.value.source]) })}
          </p>
        )}
        {state.kind === 'done' && (
          <>
            <p className={styles.muted}>{t('transfer.importDone', { count: state.count })}</p>
            {state.failed > 0 && (
              <p className={styles.muted}>{t('transfer.importSomeFailed', { count: state.failed })}</p>
            )}
            <p className={styles.muted}>{t('transfer.importModelNote')}</p>
          </>
        )}
      </div>
      {parsed !== null && (
        <Button variant="primary" loading={busy} onClick={() => void run()}>
          {t('transfer.importButton')}
        </Button>
      )}
      {state.kind === 'done' && (
        <Link href={paths.conversations} className={buttonClass({ variant: 'secondary' })}>
          {t('transfer.openChats')}
        </Link>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function ExportAll() {
  const t = useT()
  const session = useSession()
  const toast = useToast()
  const id = useId()
  const active = useConversations()
  const archived = useConversations({ archived: true })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ids = [...active, ...archived].map((c) => c.id)

  const run = async () => {
    if (session === null) return
    setBusy(true)
    setError(null)
    try {
      const transfer = await import('../../core/transfer/index.ts')
      const doc = await transfer.exportConversations(
        { workspace: session.workspace, blobs: session.blobs, clock: { now: () => Date.now() } },
        ids,
      )
      const name = `aparte-conversations-${today()}.aparte.json`
      saveFile(JSON.stringify(doc), name, 'application/json')
      toast(t('transfer.exported', { name }))
    } catch (cause) {
      setError(t('transfer.exportFailed', { message: message(cause) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.section} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className={styles.sectionTitle}>
        {t('transfer.exportAllTitle')}
      </h2>
      <p className={styles.lead}>{t('transfer.exportAllLead')}</p>
      {ids.length === 0 ? (
        <p className={styles.muted}>{t('transfer.exportAllEmpty')}</p>
      ) : (
        <Button loading={busy} onClick={() => void run()}>
          {t('transfer.exportAllButton')}
        </Button>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

export default function TransferScreen() {
  const t = useT()
  const session = useSession()
  const { status } = useVault()
  return (
    <Screen title={t('transfer.title')} subtitle={t('transfer.lead')} back={paths.more}>
      {session === null ? (
        <p className={styles.muted} role="status">
          {t('chat.sessionOpening')}
        </p>
      ) : (
        <div className={styles.stack}>
          {status.protection === 'passphrase' ? <Backup /> : <BackupNeedsPassphrase />}
          <ImportFromApp />
          <ExportAll />
        </div>
      )}
    </Screen>
  )
}
