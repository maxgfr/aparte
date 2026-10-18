import { Columns3 } from 'lucide-react'
import { useCallback, useState, useSyncExternalStore } from 'react'
import { useKeyedProviders, useResolvedParts, useSession } from '../../app/chat.tsx'
import { needsKey, sameModel, useModelChoices } from '../../app/providers.tsx'
import { useToast } from '../../app/toast.tsx'
import { type BeamState, type Candidate, MAX_BEAM } from '../../core/compare/beam.ts'
import type { Id, ModelRef } from '../../core/contracts/workspace.ts'
import { useT } from '../../i18n/react.tsx'
import chat from '../chat/Chat.module.css'
import { ModelPicker } from '../chat/ModelPicker.tsx'
import { reasoningOf, textOf } from '../chat/view.ts'
import { Button } from '../components/Button.tsx'
import { Sheet } from '../components/Sheet.tsx'
import { SwitchRow } from '../components/Switch.tsx'
import { cx } from '../cx.ts'
import { Markdown } from '../render/Sanitized.tsx'
import styles from './Compare.module.css'

/*
 * Beam in the chat: a composer control that chooses the models the next message goes to, and the panel that shows
 * their answers side by side until one is kept or they are merged (core/compare/beam.ts).
 */

const NO_MODELS: readonly ModelRef[] = []
/** The models Beam is on for, per session: kept outside the screens, which remount at every address. */
let selection: { readonly session: unknown; readonly models: readonly ModelRef[] } = {
  session: null,
  models: NO_MODELS,
}
const selectionListeners = new Set<() => void>()
const subscribeSelection = (fn: () => void) => {
  selectionListeners.add(fn)
  return () => {
    selectionListeners.delete(fn)
  }
}

/**
 * The models the next message of a chat goes to (Beam on with two or more), shared by the chat screens of a session
 * so a new chat keeps it when its first message gives it an address. A lock opens a new session and starts empty.
 */
export function useBeamSelection(): readonly [readonly ModelRef[], (models: readonly ModelRef[]) => void] {
  const session = useSession()
  const read = () => (selection.session === session ? selection.models : NO_MODELS)
  const models = useSyncExternalStore(subscribeSelection, read, read)
  const set = useCallback(
    (next: readonly ModelRef[]) => {
      selection = { session, models: next }
      for (const fn of [...selectionListeners]) fn()
    },
    [session],
  )
  return [models, set]
}

/** The composer chip: off, or the models the next message goes to (two to MAX_BEAM). */
export function BeamButton({
  models,
  onChange,
}: {
  models: readonly ModelRef[]
  onChange: (models: readonly ModelRef[]) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const choices = useModelChoices()
  const keyed = useKeyedProviders()
  const usable = choices.filter((c) => !(needsKey(c.provider) && keyed !== null && !keyed.has(c.provider.id)))
  const on = models.length >= 2
  return (
    <>
      <button
        type="button"
        className={cx(chat.modelChip, on && styles.chipOn)}
        aria-haspopup="dialog"
        aria-pressed={on}
        onClick={() => setOpen(true)}
      >
        <Columns3 size={16} strokeWidth={2} aria-hidden="true" />
        <span>{on ? t('compare.beamButtonOn', { count: models.length }) : t('compare.beamButton')}</span>
      </button>
      <Sheet open={open} title={t('compare.beamSheetTitle')} onClose={() => setOpen(false)}>
        <div className={styles.sheet}>
          <p className={chat.muted}>{t('compare.beamLead', { max: MAX_BEAM })}</p>
          {usable.length < 2 ? (
            <p className={chat.muted}>{t('compare.beamNoModels')}</p>
          ) : (
            <fieldset className={styles.fieldset}>
              <legend className={styles.legend}>{t('compare.beamModels')}</legend>
              {usable.map((c) => {
                const checked = models.some((m) => sameModel(m, c.model.ref))
                return (
                  <SwitchRow
                    key={`${c.provider.id}/${c.model.ref.id}`}
                    label={c.model.name}
                    hint={c.provider.label}
                    checked={checked}
                    disabled={!checked && models.length >= MAX_BEAM}
                    onChange={(next) =>
                      onChange(next ? [...models, c.model.ref] : models.filter((m) => !sameModel(m, c.model.ref)))
                    }
                  />
                )
              })}
              <p className={chat.muted}>{t('compare.beamPickAtMost', { max: MAX_BEAM })}</p>
            </fieldset>
          )}
          <div className={chat.sheetActions}>
            {models.length > 0 && (
              <Button variant="plain" onClick={() => onChange([])}>
                {t('compare.beamOff')}
              </Button>
            )}
            <Button variant="primary" onClick={() => setOpen(false)}>
              {t('chat.done')}
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  )
}

/** The name a candidate shows: the model's, or "Answer n" while the Arena keeps it blind. */
export function useCandidateLabel(blind: boolean): (candidate: Candidate, index: number) => string {
  const t = useT()
  const session = useSession()
  return (candidate, index) =>
    blind
      ? t('compare.beamAnswerNumber', { index: index + 1 })
      : t('compare.beamAnswerFrom', {
          model: session?.resolveModel(candidate.model)?.name ?? candidate.model.id,
        })
}

/** One answer of the comparison, streaming or committed. */
export function CandidateCard({
  candidate,
  label,
  actions,
}: {
  candidate: Candidate
  label: string
  actions?: React.ReactNode
}) {
  const t = useT()
  const parts = useResolvedParts(candidate.parts)
  const text = textOf(parts)
  const reasoning = reasoningOf(parts)
  const live = candidate.status === 'streaming'
  return (
    <article
      className={styles.card}
      aria-label={label}
      aria-busy={live || undefined}
      data-candidate=""
      data-status={candidate.status}
    >
      <h3 className={styles.cardTitle}>{label}</h3>
      {reasoning !== '' && (
        <details className={chat.reasoning}>
          <summary className={chat.reasoningSummary}>{live ? t('chat.thinking') : t('chat.reasoning')}</summary>
          <Markdown source={reasoning} live={live} className={chat.reasoningText} />
        </details>
      )}
      {text !== '' ? (
        <Markdown source={text} live={live} className={styles.cardText} data={{ 'data-candidate-content': '' }} />
      ) : (
        !live && <p className={chat.muted}>{t('compare.beamEmpty')}</p>
      )}
      {live && (
        <p className={chat.caption} role="status">
          {t('compare.beamStreaming')}
        </p>
      )}
      {candidate.status === 'stopped' && <p className={chat.caption}>{t('compare.beamStopped')}</p>}
      {candidate.status === 'error' && <p className={chat.warningText}>{t('compare.beamFailed')}</p>}
      {candidate.status === 'refused' && <p className={chat.warningText}>{t('compare.beamRefused')}</p>}
      {actions !== undefined && <div className={styles.cardActions}>{actions}</div>}
    </article>
  )
}

/** The comparison under the user message of a beam: one column per model, then keep or merge. */
export function BeamPanel({ conversationId, state }: { conversationId: Id; state: BeamState }) {
  const t = useT()
  const toast = useToast()
  const session = useSession()
  const label = useCandidateLabel(state.mode === 'arena')
  const [fuser, setFuser] = useState<ModelRef | null>(state.candidates[0]?.model ?? null)
  const [merging, setMerging] = useState(false)
  const engine = session?.beam ?? null
  if (engine === null) return null
  const withText = state.candidates.filter(
    (c) =>
      (c.status === 'done' || c.status === 'stopped') && c.parts.some((p) => p.type === 'text' || p.type === 'ref'),
  )
  const keep = async (messageId: Id) => {
    await engine.pick(conversationId, messageId)
    engine.close(conversationId)
    toast(t('compare.beamKept'))
  }
  const merge = async () => {
    if (fuser === null) return
    setMerging(true)
    try {
      await engine.fuse(conversationId, fuser)
    } catch {
      toast(t('compare.beamMergeNeedsTwo'))
    } finally {
      setMerging(false)
    }
  }
  return (
    <section className={styles.panel} aria-label={t('compare.beamRegion')}>
      <div className={styles.columns} data-count={state.candidates.length}>
        {state.candidates.map((c, i) => (
          <CandidateCard
            key={c.messageId}
            candidate={c}
            label={label(c, i)}
            actions={
              c.status !== 'streaming' && c.status !== 'error' && c.status !== 'refused' && !state.running ? (
                <Button variant="secondary" onClick={() => void keep(c.messageId)}>
                  {t('compare.beamKeep')}
                </Button>
              ) : undefined
            }
          />
        ))}
      </div>
      {state.fusion !== null && (
        <CandidateCard
          candidate={state.fusion}
          label={t('compare.beamMerged')}
          actions={
            state.fusion.status === 'done' && !state.running ? (
              <Button variant="secondary" onClick={() => void keep((state.fusion as Candidate).messageId)}>
                {t('compare.beamKeep')}
              </Button>
            ) : undefined
          }
        />
      )}
      {state.running ? (
        <div className={chat.sheetActions}>
          <Button variant="plain" onClick={() => engine.stop(conversationId)}>
            {t('compare.beamStop')}
          </Button>
        </div>
      ) : (
        <div className={styles.merge}>
          {state.mode === 'beam' && withText.length >= 2 && state.fusion === null && (
            <>
              <h3 className={styles.cardTitle}>{t('compare.beamMergeTitle')}</h3>
              <p className={chat.muted}>{t('compare.beamMergeLead')}</p>
              <div className={styles.mergeRow}>
                <ModelPicker value={fuser} onChange={setFuser} />
                <Button variant="primary" loading={merging} disabled={fuser === null} onClick={() => void merge()}>
                  {merging ? t('compare.beamMerging') : t('compare.beamMerge')}
                </Button>
              </div>
            </>
          )}
          <Button variant="plain" onClick={() => engine.close(conversationId)}>
            {t('compare.beamClose')}
          </Button>
        </div>
      )}
    </section>
  )
}
