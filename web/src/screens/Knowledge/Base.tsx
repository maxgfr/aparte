import { FileText, Pencil, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { Link, Redirect, useLocation } from 'wouter'
import { useKnowledgeBase, useProviders, useSession, useSessionState } from '../../app/chat.tsx'
import { EMBEDDING_MODELS, embeddingKind, LOCAL_EMBEDDER } from '../../app/knowledge.ts'
import { paths } from '../../app/routes.ts'
import { useToast } from '../../app/toast.tsx'
import { useVault } from '../../app/vault.tsx'
import { ExtractError } from '../../core/contracts/knowledge.ts'
import type { EmbedderRef, KnowledgeBase } from '../../core/contracts/workspace.ts'
import { ACCEPT } from '../../core/knowledge/extract.ts'
import { formatBytes } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Sheet } from '../../ui/components/Sheet.tsx'
import { addFiles, type IngestOutcome, stopIngest, useIngest } from '../../ui/knowledge/ingest.ts'
import styles from '../../ui/knowledge/Knowledge.module.css'
import { Screen } from '../../ui/shell/Screen.tsx'

/*
 * One knowledge base: its documents, adding more (read, cut into passages and indexed on this device, with the
 * progress of each file), the model that embeds its passages, renaming and deleting it.
 */

const sameEmbedder = (a: EmbedderRef | null, b: EmbedderRef | null): boolean =>
  a === null || b === null
    ? a === b
    : a.kind === b.kind &&
      a.model === b.model &&
      (a.kind === 'local' || (b.kind === 'provider' && a.provider === b.provider))

function useOutcomeMessage(): (outcome: IngestOutcome) => string {
  const t = useT()
  return useCallback(
    ({ job, result, error }: IngestOutcome) => {
      const name = job.name
      if (result !== undefined)
        return result.embedded ? t('knowledge.added', { name }) : t('knowledge.addedKeywords', { name })
      if (error instanceof DOMException && error.name === 'AbortError') return t('knowledge.stopped')
      if (error instanceof ExtractError) {
        switch (error.kind) {
          case 'unsupported':
            return t('knowledge.failedUnsupported', { name })
          case 'empty':
            return t('knowledge.failedEmpty', { name })
          case 'encrypted':
            return t('knowledge.failedEncrypted', { name })
          case 'too-large':
            return t('knowledge.failedTooLarge', { name })
          default:
            return t('knowledge.failedCorrupt', { name })
        }
      }
      return t('knowledge.failedOther', { name })
    },
    [t],
  )
}

/** The file being added and the ones waiting, with a Stop. */
function Progress({ base }: { base: KnowledgeBase }) {
  const t = useT()
  const ingest = useIngest()
  const current = ingest.current
  const queued = ingest.queued.filter((j) => j.base === base.id)
  if ((current === null || current.base !== base.id) && queued.length === 0) return null
  const p = current?.progress ?? null
  const line =
    current === null
      ? null
      : p?.stage === 'embedding'
        ? t('knowledge.progressEmbedding', { name: current.name, done: p.done ?? 0, total: p.total ?? 0 })
        : p?.stage === 'saving'
          ? t('knowledge.progressSaving', { name: current.name })
          : t('knowledge.progressExtracting', { name: current.name })
  return (
    <section className={styles.progress} aria-label={t('knowledge.progressLabel')} data-ingest="">
      {line !== null && (
        <p className={styles.footnote} role="status" aria-live="polite">
          {line}
        </p>
      )}
      {p?.stage === 'embedding' && p.total !== undefined && p.total > 0 ? (
        <progress className={styles.bar} max={p.total} value={p.done ?? 0} aria-label={line ?? ''} />
      ) : (
        <progress className={styles.bar} aria-label={line ?? t('knowledge.progressLabel')} />
      )}
      {queued.map((j) => (
        <p key={j.id} className={styles.muted}>
          {t('knowledge.progressQueued', { name: j.name })}
        </p>
      ))}
      <div className={styles.actions}>
        <Button variant="plain" onClick={stopIngest}>
          {t('knowledge.stop')}
        </Button>
      </div>
    </section>
  )
}

/** The embedding model choice: on this device, a provider that has an embeddings API, or keywords only. */
function EmbedderChoice({ base }: { base: KnowledgeBase }) {
  const t = useT()
  const session = useSession()
  const toast = useToast()
  const providers = useProviders()
  const name = useId()
  const [stale, setStale] = useState(false)
  const [busy, setBusy] = useState(false)
  const options = useMemo(() => {
    const out: { ref: EmbedderRef | null; label: string; hint: string }[] = [
      {
        ref: LOCAL_EMBEDDER,
        label: t('knowledge.embedderLocal', { model: LOCAL_EMBEDDER.model.split('/').pop() ?? '' }),
        hint: t('knowledge.embedderLocalHint'),
      },
    ]
    for (const p of providers) {
      const model = EMBEDDING_MODELS[p.kind]
      if (!embeddingKind(p.kind) || model === undefined) continue
      out.push({
        ref: { kind: 'provider', provider: p.id, model },
        label: t('knowledge.embedderProvider', { provider: p.label, model }),
        hint: t('knowledge.embedderProviderHint', { provider: p.label }),
      })
    }
    // A provider model chosen on another device, or since removed, still shows as the current choice.
    if (base.embedder !== null && !out.some((o) => sameEmbedder(o.ref, base.embedder))) {
      const ref = base.embedder
      const provider = ref.kind === 'provider' ? providers.find((p) => p.id === ref.provider) : undefined
      out.push({
        ref,
        label: t('knowledge.embedderProvider', { provider: provider?.label ?? ref.model, model: ref.model }),
        hint: t('knowledge.embedderProviderHint', { provider: provider?.label ?? ref.model }),
      })
    }
    out.push({ ref: null, label: t('knowledge.embedderNone'), hint: t('knowledge.embedderNoneHint') })
    return out
  }, [providers, base.embedder, t])

  useEffect(() => {
    if (session === null) return
    let live = true
    session.knowledge.needsReindex(base.id).then(
      (v) => live && setStale(v),
      () => live && setStale(false),
    )
    return () => {
      live = false
    }
  }, [session, base])

  if (session === null) return null
  return (
    <section className={styles.section}>
      <fieldset className={styles.choices}>
        <legend>{t('knowledge.embedderTitle')}</legend>
        {options.map((o) => (
          <label
            key={
              o.ref === null
                ? 'none'
                : `${o.ref.kind}:${o.ref.kind === 'provider' ? o.ref.provider : ''}:${o.ref.model}`
            }
            className={styles.choice}
          >
            <input
              type="radio"
              name={name}
              checked={sameEmbedder(o.ref, base.embedder)}
              onChange={() => session.workspace.knowledge.update(base.id, { embedder: o.ref })}
            />
            <span className={styles.choiceText}>
              <span className={styles.choiceLabel}>{o.label}</span>
              <span className={styles.choiceHint}>{o.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <p className={styles.footnote}>{t('knowledge.embedderHint')}</p>
      {stale && (
        <div className={styles.section}>
          <p className={styles.warning}>{t('knowledge.reindexNeeded')}</p>
          <div className={styles.actions}>
            <Button
              loading={busy}
              onClick={async () => {
                setBusy(true)
                try {
                  const count = await session.knowledge.reindex(base.id)
                  toast(t('knowledge.reindexDone', { count }))
                  setStale(await session.knowledge.needsReindex(base.id))
                } catch {
                  toast(t('knowledge.reindexFailed'))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {t('knowledge.reindex')}
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

export default function KnowledgeBaseScreen({ params }: { params?: { id?: string } }) {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const { status, vault } = useVault()
  const state = useSessionState()
  const session = useSession()
  const id = params?.id === undefined ? null : decodeURIComponent(params.id)
  const base = useKnowledgeBase(id)
  const [, navigate] = useLocation()
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [deleting, setDeleting] = useState(false)
  const inputId = useId()
  const describe = useOutcomeMessage()

  if (status.state === 'absent') return <Redirect to={paths.welcome} replace />
  if (state.status !== 'open' || session === null) {
    return (
      <Screen title={t('knowledge.title')} back={paths.knowledge}>
        <p className={styles.muted} role="status">
          {t('chat.sessionOpening')}
        </p>
      </Screen>
    )
  }
  if (base === undefined || base.purgedAt !== undefined || base.deletedAt !== undefined) {
    return (
      <Screen title={t('knowledge.title')} back={paths.knowledge}>
        <EmptyState
          title={t('knowledge.missing')}
          action={
            <Link href={paths.knowledge} className={buttonClass({ variant: 'primary' })}>
              {t('knowledge.missingBack')}
            </Link>
          }
        />
      </Screen>
    )
  }
  const ws = session.workspace
  const onFiles = (files: FileList | null) => {
    if (files === null || files.length === 0) return
    addFiles(
      {
        knowledge: session.knowledge,
        holdLock: (reason) => vault.holdLock(reason),
        onDone: (outcome) => toast(describe(outcome)),
      },
      base.id,
      [...files],
    )
  }
  return (
    <Screen
      title={base.name || t('chat.untitled')}
      back={paths.knowledge}
      trailing={
        <div className={styles.actions}>
          <IconButton
            icon={Pencil}
            label={t('knowledge.rename')}
            onClick={() => {
              setDraft(base.name)
              setRenaming(true)
            }}
          />
          <IconButton icon={Trash2} label={t('knowledge.delete')} onClick={() => setDeleting(true)} />
        </div>
      }
    >
      <div className={styles.stack}>
        <ListGroup
          title={t('knowledge.documentsTitle')}
          footer={base.documents.length === 0 ? t('knowledge.documentsEmpty') : undefined}
        >
          {base.documents.map((d) => (
            <ListRow
              key={d.blob}
              leading={<FileText size={20} strokeWidth={1.75} />}
              title={d.name}
              subtitle={t('knowledge.documentMeta', {
                size: formatBytes(locale, d.size ?? 0),
                count: d.chunks ?? 0,
              })}
              wrap
              trailing={
                <Button
                  variant="plain"
                  aria-label={t('knowledge.removeLabel', { name: d.name })}
                  onClick={() => {
                    ws.knowledge.removeDocument(base.id, d.blob)
                    toast(t('knowledge.removed', { name: d.name }), [
                      { label: t('knowledge.undo'), onClick: () => ws.knowledge.addDocument(base.id, d) },
                    ])
                  }}
                >
                  {t('knowledge.remove')}
                </Button>
              }
            />
          ))}
        </ListGroup>

        <section className={styles.section}>
          <div className={styles.actions}>
            <input
              id={inputId}
              className={styles.fileInput}
              type="file"
              multiple
              accept={ACCEPT}
              onChange={(e) => {
                onFiles(e.target.files)
                e.target.value = ''
              }}
            />
            <label htmlFor={inputId} className={buttonClass({ variant: 'primary' })}>
              {t('knowledge.add')}
            </label>
          </div>
          <p className={styles.footnote}>{t('knowledge.addHint')}</p>
          <Progress base={base} />
        </section>

        <EmbedderChoice base={base} />
      </div>

      <Sheet open={renaming} title={t('knowledge.renameTitle')} onClose={() => setRenaming(false)}>
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault()
            if (draft.trim() === '') return
            ws.knowledge.update(base.id, { name: draft.trim() })
            setRenaming(false)
          }}
        >
          <Field
            label={t('knowledge.newName')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoComplete="off"
          />
          <div className={styles.actions}>
            <Button type="submit" variant="primary" disabled={draft.trim() === ''}>
              {t('knowledge.save')}
            </Button>
            <Button variant="plain" onClick={() => setRenaming(false)}>
              {t('knowledge.cancel')}
            </Button>
          </div>
        </form>
      </Sheet>

      <Sheet open={deleting} title={t('knowledge.deleteTitle', { name: base.name })} onClose={() => setDeleting(false)}>
        <div className={styles.form}>
          <p className={styles.footnote}>{t('knowledge.deleteBody')}</p>
          <div className={styles.actions}>
            <Button
              variant="danger"
              onClick={() => {
                const name = base.name
                ws.knowledge.trash(base.id)
                setDeleting(false)
                navigate(paths.knowledge, { replace: true })
                toast(t('knowledge.deleted', { name }), [
                  { label: t('knowledge.undo'), onClick: () => ws.knowledge.restore(base.id) },
                ])
              }}
            >
              {t('knowledge.deleteConfirm')}
            </Button>
            <Button variant="plain" onClick={() => setDeleting(false)}>
              {t('knowledge.cancel')}
            </Button>
          </div>
        </div>
      </Sheet>
    </Screen>
  )
}
