import { BookOpen } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSession } from '../../app/chat.tsx'
import type { Id, KnowledgePassage, Message, Part, Thread } from '../../core/contracts/workspace.ts'
import { passagesOfParts, passagesOfPath } from '../../core/knowledge/citations.ts'
import { useT } from '../../i18n/react.tsx'
import { Sheet } from '../components/Sheet.tsx'
import { cx } from '../cx.ts'
import styles from './Knowledge.module.css'

/*
 * Knowledge in the thread: the passages a user message carried (a chip that opens them), the sources an answer cites
 * (numbered chips under it, each opening the passage it names), and the hook that validates an answer's citations
 * against the passages its branch gave the model. Passages are shown as text, never as markup.
 */

type KnowledgePart = Extract<Part, { readonly type: 'knowledge' }>

const EMPTY: ReadonlyMap<string, KnowledgePassage> = new Map()

/**
 * The passages given to the model on the branch up to `messageId`, by id. Messages whose knowledge or search results
 * were stored as blobs (`ref` parts) are read from them first; until then their passages are not known.
 */
export function useKnownPassages(thread: Thread, messageId: Id): ReadonlyMap<string, KnowledgePassage> {
  const session = useSession()
  const path = thread.path(messageId)
  const direct = useMemo(() => passagesOfPath(path), [path])
  const refs = useMemo(
    () =>
      path.flatMap((m) =>
        m.deletedAt !== undefined
          ? []
          : m.parts
              .filter(
                (p): p is Extract<Part, { readonly type: 'ref' }> =>
                  p.type === 'ref' && (p.partType === 'knowledge' || p.partType === 'tool-result'),
              )
              .map((p) => ({ role: m.role, blob: p.blob })),
      ),
    [path],
  )
  const [resolved, setResolved] = useState<{ from: readonly Message[]; passages: KnowledgePassage[] } | null>(null)
  useEffect(() => {
    if (refs.length === 0 || session === null) return
    let live = true
    void Promise.all(refs.map((r) => session.refPart(r.blob).catch(() => null))).then((parts) => {
      const passages = parts.flatMap((p, i) => (p === null ? [] : passagesOfParts(refs[i]?.role ?? 'user', [p])))
      if (live) setResolved({ from: path, passages })
    })
    return () => {
      live = false
    }
  }, [refs, session, path])
  return useMemo(() => {
    if (refs.length === 0) return direct.size === 0 ? EMPTY : direct
    const out = new Map(direct)
    if (resolved !== null && resolved.from === path)
      for (const p of resolved.passages) if (!out.has(p.id)) out.set(p.id, p)
    return out
  }, [direct, refs, resolved, path])
}

function where(t: ReturnType<typeof useT>, p: KnowledgePassage): string {
  return p.page === undefined
    ? t('knowledge.passageFrom', { document: p.document })
    : t('knowledge.passageFromPage', { document: p.document, page: p.page })
}

/** One passage, as the sheets show it: where it comes from, then its text. */
function PassageView({ passage }: { passage: KnowledgePassage }) {
  const t = useT()
  return (
    <div className={styles.passage}>
      <p className={styles.footnote}>
        {where(t, passage)}
        {passage.heading !== undefined && ` · ${passage.heading}`}
      </p>
      <p className={styles.passageText} data-passage-text="">
        {passage.text}
      </p>
    </div>
  )
}

/** The sources an answer cites, numbered as in its text; each opens the passage. */
export function KnowledgeSources({ sources }: { sources: readonly KnowledgePassage[] }) {
  const t = useT()
  const [open, setOpen] = useState<number | null>(null)
  if (sources.length === 0) return null
  const shown = open === null ? undefined : sources[open]
  return (
    <section className={styles.sources} aria-label={t('knowledge.sourcesTitle')} data-knowledge-sources="">
      <p className={styles.label}>{t('knowledge.sourcesTitle')}</p>
      <ol className={styles.sourceList}>
        {sources.map((s, i) => (
          <li key={s.id}>
            <button
              type="button"
              className={styles.chip}
              onClick={() => setOpen(i)}
              aria-label={t('knowledge.sourceLabel', { n: i + 1, document: s.document })}
              data-passage={s.id}
            >
              <span className={styles.chipNumber} aria-hidden="true">
                {i + 1}
              </span>
              <span className={styles.chipName} aria-hidden="true">
                {s.document}
                {s.page !== undefined && ` · ${t('knowledge.sourcePage', { page: s.page })}`}
              </span>
            </button>
          </li>
        ))}
      </ol>
      <Sheet
        open={shown !== undefined}
        title={t('knowledge.passageTitle', { n: (open ?? 0) + 1 })}
        onClose={() => setOpen(null)}
      >
        {shown !== undefined && <PassageView passage={shown} />}
      </Sheet>
    </section>
  )
}

/** The passages a user message was sent with: one chip that opens them all. */
export function ContextChip({ part }: { part: KnowledgePart }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const passages = part.passages
  if (passages.length === 0) return null
  return (
    <>
      <button
        type="button"
        className={cx(styles.chip, styles.contextChip)}
        onClick={() => setOpen(true)}
        data-knowledge-context=""
      >
        <BookOpen size={16} strokeWidth={1.75} aria-hidden="true" />
        <span>{t('knowledge.contextChip', { count: passages.length })}</span>
      </button>
      <Sheet open={open} title={t('knowledge.contextTitle')} onClose={() => setOpen(false)}>
        <ol className={styles.passages}>
          {passages.map((p) => (
            <li key={p.id}>
              <PassageView passage={p} />
            </li>
          ))}
        </ol>
      </Sheet>
    </>
  )
}
