import { ChevronLeft, ChevronRight, Pencil, RefreshCw } from 'lucide-react'
import { memo, useEffect, useId, useState } from 'react'
import { useResolvedParts, useSession } from '../../app/chat.tsx'
import type { ModelDescriptor } from '../../core/contracts/ai.ts'
import type { StreamState, ToolCallState } from '../../core/contracts/chat.ts'
import type { ApprovalDecision } from '../../core/contracts/tools.ts'
import type { Id, Message, Part, Thread } from '../../core/contracts/workspace.ts'
import { formatNumber, formatUsd } from '../../i18n/format.ts'
import type { Key } from '../../i18n/index.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button } from '../components/Button.tsx'
import { IconButton } from '../components/IconButton.tsx'
import { CopyButton, Markdown } from '../render/Sanitized.tsx'
import styles from './Chat.module.css'
import { useEffortLabel } from './ModelPicker.tsx'
import { isWebSearchCall, SourcesList, ToolCallCard, WebSearchNote } from './Tools.tsx'
import { costOf, type ImagePart, imagesOf, reasoningOf, textOf } from './view.ts'

/** Marks the element that holds a message's rendered text, apart from its reasoning, notes and controls. */
const CONTENT = { 'data-message-content': '' } as const

/** What a message row can do; absent handlers hide their buttons. */
export interface MessageActions {
  readonly onEdit?: (messageId: Id, parts: readonly Part[]) => Promise<void>
  readonly onRegenerate?: (messageId: Id) => void
  readonly onBranch?: (messageId: Id) => void
  /** Answers the approval a tool call of the current round waits for. */
  readonly onApprove?: (callId: string, decision: ApprovalDecision) => void
  /** A stream runs in this conversation: regenerating and editing wait for it. */
  readonly busy: boolean
}

type CallPart = Extract<Part, { readonly type: 'tool-call' }>
type ResultPart = Extract<Part, { readonly type: 'tool-result' }>
type SourcePart = Extract<Part, { readonly type: 'source' }>

const NO_PARTS: readonly Part[] = []

/**
 * The tool work of an answer, in part order: the provider's web searches, then each call with its result (from the
 * `tool` message that answers it) or its live state, then the sources.
 */
function ToolWork({
  parts,
  results,
  live,
  streaming,
  onApprove,
}: {
  parts: readonly Part[]
  results: readonly Part[]
  live?: readonly ToolCallState[]
  streaming: boolean
  onApprove?: (callId: string, decision: ApprovalDecision) => void
}) {
  const searches = parts.filter(isWebSearchCall)
  const calls = parts.filter((p): p is CallPart => p.type === 'tool-call')
  const sources = parts.filter((p): p is SourcePart => p.type === 'source')
  if (searches.length === 0 && calls.length === 0 && sources.length === 0) return null
  const byId = new Map<string, ResultPart>()
  for (const r of results) if (r.type === 'tool-result' && !byId.has(r.callId)) byId.set(r.callId, r)
  const answered = new Set(
    parts.flatMap((p) => {
      const b = p.type === 'provider' ? (p.block as { type?: unknown; tool_use_id?: unknown } | null) : null
      return b?.type === 'web_search_tool_result' && typeof b.tool_use_id === 'string' ? [b.tool_use_id] : []
    }),
  )
  return (
    <div className={styles.toolWork}>
      {searches.map((p, i) => {
        const id = (p as { block: { id?: unknown } }).block.id
        return (
          <WebSearchNote
            key={typeof id === 'string' ? id : `s${i}`}
            block={(p as { block: unknown }).block}
            live={streaming && !(typeof id === 'string' && answered.has(id))}
          />
        )
      })}
      {calls.map((call) => (
        <ToolCallCard
          key={call.callId}
          call={call}
          result={byId.get(call.callId)}
          live={live?.find((c) => c.callId === call.callId)}
          onApprove={onApprove}
        />
      ))}
      {sources.length > 0 && <SourcesList sources={sources} />}
    </div>
  )
}

/** A stored photo, decrypted into an object URL for as long as the vault stays unlocked. */
function AttachedImage({ part }: { part: ImagePart }) {
  const t = useT()
  const session = useSession()
  const [url, setUrl] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    if (session === null) return
    let live = true
    session.blobUrl(part.blob, part.mediaType).then(
      (u) => live && setUrl(u),
      () => live && setUrl(null),
    )
    return () => {
      live = false
    }
  }, [session, part.blob, part.mediaType])
  const alt = part.name ?? t('chat.photo')
  if (url === null) return <span className={styles.imageMissing}>{t('chat.photoMissing')}</span>
  return (
    <img
      className={styles.image}
      src={url ?? undefined}
      alt={alt}
      width={part.width}
      height={part.height}
      loading="lazy"
      decoding="async"
    />
  )
}

/** `< 2/3 >` between the versions of a message (its siblings in the tree). */
export function BranchNav({
  thread,
  message,
  onBranch,
}: {
  thread: Thread
  message: Message
  onBranch?: (id: Id) => void
}) {
  const t = useT()
  const { messages, index } = thread.siblings(message.id)
  const visible = messages.filter((m) => m.deletedAt === undefined || m.id === message.id)
  const at = visible.findIndex((m) => m.id === message.id)
  if (visible.length < 2 || onBranch === undefined || at < 0 || index < 0) return null
  const go = (to: number) => {
    const target = visible[to]
    if (target !== undefined) onBranch(target.id)
  }
  return (
    <span className={styles.branch}>
      <IconButton icon={ChevronLeft} label={t('chat.branchPrevious')} disabled={at === 0} onClick={() => go(at - 1)} />
      <span className={styles.branchCount} aria-hidden="true">
        {at + 1}/{visible.length}
      </span>
      <span className="sr-only">{t('chat.branchPosition', { index: at + 1, count: visible.length })}</span>
      <IconButton
        icon={ChevronRight}
        label={t('chat.branchNext')}
        disabled={at === visible.length - 1}
        onClick={() => go(at + 1)}
      />
    </span>
  )
}

function UserMessage({ thread, message, actions }: { thread: Thread; message: Message; actions: MessageActions }) {
  const t = useT()
  const id = useId()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const parts = useResolvedParts(message.parts)
  const text = textOf(parts)
  const images = imagesOf(parts)
  return (
    <article
      className={styles.userRow}
      aria-label={t('chat.you')}
      data-message=""
      data-role="user"
      data-status={message.status}
    >
      {editing ? (
        <div className={styles.editor}>
          <label htmlFor={id} className="sr-only">
            {t('chat.editLabel')}
          </label>
          <textarea
            id={id}
            className={styles.textarea}
            rows={Math.min(10, Math.max(3, draft.split('\n').length))}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-describedby={`${id}-hint`}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditing(false)
            }}
          />
          <p id={`${id}-hint`} className={styles.footnote}>
            {t('chat.editHint')}
          </p>
          <div className={styles.sheetActions}>
            <Button
              variant="primary"
              loading={busy}
              disabled={draft.trim() === '' || draft.trim() === text}
              onClick={async () => {
                if (actions.onEdit === undefined) return
                setBusy(true)
                try {
                  // Photos stay with the new version; only the text changes.
                  const parts: Part[] = [...images, { type: 'text', text: draft.trim() }]
                  await actions.onEdit(message.id, parts)
                  setEditing(false)
                } finally {
                  setBusy(false)
                }
              }}
            >
              {t('chat.editSend')}
            </Button>
            <Button variant="plain" onClick={() => setEditing(false)}>
              {t('chat.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.bubble}>
          {images.length > 0 && (
            <div className={styles.images}>
              {images.map((part) => (
                <AttachedImage key={part.blob} part={part} />
              ))}
            </div>
          )}
          {text !== '' && (
            <p className={styles.userText} data-message-content="">
              {text}
            </p>
          )}
        </div>
      )}
      {!editing && (
        <div className={styles.actions}>
          <BranchNav thread={thread} message={message} onBranch={actions.onBranch} />
          {actions.onEdit !== undefined && (
            <IconButton
              icon={Pencil}
              label={t('chat.edit')}
              disabled={actions.busy}
              onClick={() => {
                setDraft(text)
                setEditing(true)
              }}
            />
          )}
          {text !== '' && <CopyButton text={text} label={t('chat.copy')} />}
        </div>
      )}
    </article>
  )
}

const ERROR_KEYS: Readonly<Record<string, Extract<Key, `chat.error${string}`>>> = {
  auth: 'chat.errorAuth',
  'auth-or-network': 'chat.errorAuthOrNetwork',
  'rate-limit': 'chat.errorRateLimit',
  overloaded: 'chat.errorOverloaded',
  'context-length': 'chat.errorContext',
  'invalid-request': 'chat.errorInvalid',
  'not-found': 'chat.errorNotFound',
  server: 'chat.errorServer',
  truncated: 'chat.errorTruncated',
}

/** Why an answer is incomplete or missing, in words; null for a complete one. */
function AnswerNote({ message }: { message: Message }) {
  const t = useT()
  if (message.status === 'refused') {
    const category = message.refusal?.category
    return (
      <div className={styles.note} role="note">
        <p>{category ? t('chat.refusedCategory', { category }) : t('chat.refused')}</p>
        {message.refusal?.explanation && <p className={styles.footnote}>{message.refusal.explanation}</p>}
      </div>
    )
  }
  if (message.status === 'error') {
    const key = ERROR_KEYS[message.error?.code ?? ''] ?? 'chat.errorUnknown'
    return (
      <div className={styles.errorNote} role="note">
        <p>{t(key)}</p>
        {message.error?.message && (
          <p className={styles.footnote}>{t('chat.errorDetail', { message: message.error.message })}</p>
        )}
      </div>
    )
  }
  if (message.status === 'stopped') return <p className={styles.caption}>{t('chat.stopped')}</p>
  if (message.stop === 'length') return <p className={styles.caption}>{t('chat.truncatedLength')}</p>
  if (message.stop === 'content-filter') return <p className={styles.caption}>{t('chat.contentFilter')}</p>
  return null
}

function UsageLine({ message, model }: { message: Message; model: ModelDescriptor | null }) {
  const t = useT()
  const locale = useLocale()
  const effortLabel = useEffortLabel()
  const [open, setOpen] = useState(false)
  const usage = message.usage
  const cost = costOf(usage, model?.capabilities.cost ?? null)
  const name = model?.name ?? message.model?.id ?? t('chat.modelUnknown')
  const n = (v: number | undefined) => formatNumber(locale, v ?? 0, 0)
  const details: string[] = []
  if (usage !== undefined) {
    details.push(t('chat.usageTokens', { input: n(usage.input), output: n(usage.output) }))
    if ((usage.cacheRead ?? 0) > 0) details.push(t('chat.usageCached', { count: n(usage.cacheRead) }))
    if ((usage.reasoning ?? 0) > 0) details.push(t('chat.usageReasoning', { count: n(usage.reasoning) }))
  }
  if (cost !== null) details.push(t('chat.usageCost', { cost: formatUsd(locale, cost) }))
  if (message.effort !== undefined) details.push(t('chat.effortUsed', { effort: effortLabel(message.effort) }))
  return (
    <p className={styles.usage}>
      <span className={styles.modelId}>{name}</span>
      {details.length > 0 && (
        <>
          {open && <span> · {details.join(' · ')}</span>}
          <button type="button" className={styles.linkButton} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? t('chat.usageHide') : t('chat.usageDetails')}
          </button>
        </>
      )}
    </p>
  )
}

function Reasoning({ text, live, hidden }: { text: string; live: boolean; hidden: boolean }) {
  const t = useT()
  if (text === '' && !hidden) return null
  return (
    <details className={styles.reasoning}>
      <summary className={styles.reasoningSummary}>{live ? t('chat.thinking') : t('chat.reasoning')}</summary>
      {text === '' ? (
        <p className={styles.footnote}>{t('chat.reasoningHidden')}</p>
      ) : (
        <Markdown source={text} live={live} className={styles.reasoningText} />
      )}
    </details>
  )
}

function AssistantMessage({
  thread,
  message,
  actions,
  live,
}: {
  thread: Thread
  message: Message
  actions: MessageActions
  live?: readonly ToolCallState[]
}) {
  const t = useT()
  const session = useSession()
  const model = message.model === null ? null : (session?.resolveModel(message.model) ?? null)
  const parts = useResolvedParts(message.parts)
  const hasCalls = message.parts.some((p) => p.type === 'tool-call')
  const toolMessage = hasCalls ? thread.children(message.id).find((m) => m.role === 'tool') : undefined
  const results = useResolvedParts(toolMessage?.parts ?? NO_PARTS)
  const text = textOf(parts)
  const reasoning = reasoningOf(parts)
  const hadReasoning = parts.some((p) => p.type === 'reasoning')
  return (
    <article
      className={styles.answerRow}
      aria-label={model?.name ?? message.model?.id ?? t('chat.modelUnknown')}
      data-message=""
      data-role="assistant"
      data-status={message.status}
    >
      <Reasoning text={reasoning} live={false} hidden={hadReasoning && reasoning === ''} />
      {text !== '' && <Markdown source={text} className={styles.answerContent} data={CONTENT} />}
      <ToolWork parts={parts} results={results} live={live} streaming={false} onApprove={actions.onApprove} />
      <AnswerNote message={message} />
      <div className={styles.answerFooter}>
        <UsageLine message={message} model={model} />
        <div className={styles.actions}>
          <BranchNav thread={thread} message={message} onBranch={actions.onBranch} />
          {text !== '' && <CopyButton text={text} label={t('chat.copy')} />}
          {actions.onRegenerate !== undefined && (
            <IconButton
              icon={RefreshCw}
              label={t('chat.regenerate')}
              disabled={actions.busy}
              onClick={() => actions.onRegenerate?.(message.id)}
            />
          )}
        </div>
      </div>
    </article>
  )
}

function SystemNotice({ message }: { message: Message }) {
  const t = useT()
  const text = textOf(useResolvedParts(message.parts))
  return (
    <details className={styles.systemNotice} data-message="" data-role="system" data-status={message.status}>
      <summary>{t('chat.systemNotice')}</summary>
      <p className={styles.systemText} data-message-content="">
        {text === '' ? t('chat.systemEmpty') : text}
      </p>
    </details>
  )
}

/**
 * One committed message of the thread. Memoised: a committed message never changes, so it renders again only when
 * the tree grows (`treeSize`, for its `< 2/3 >` count) or the available actions change.
 */
export const MessageRow = memo(function MessageRow({
  thread,
  message,
  actions,
  live,
}: {
  thread: Thread
  message: Message
  actions: MessageActions
  treeSize: number
  /** The live state of this answer's tool calls while their round runs. */
  live?: readonly ToolCallState[]
}) {
  if (message.role === 'user') return <UserMessage thread={thread} message={message} actions={actions} />
  if (message.role === 'assistant')
    return <AssistantMessage thread={thread} message={message} actions={actions} live={live} />
  if (message.role === 'system') return <SystemNotice message={message} />
  // A `tool` message holds the results of the answer before it, which shows them in its tool cards.
  return null
})

/** The answer streaming in memory: text as it arrives, no typewriter effect, a polite status line. */
export function StreamingAnswer({ stream }: { stream: StreamState }) {
  const t = useT()
  const session = useSession()
  const model = session?.resolveModel(stream.model) ?? null
  const text = textOf(stream.parts)
  const reasoning = reasoningOf(stream.parts)
  const thinking = text === ''
  return (
    <article
      className={styles.answerRow}
      aria-busy="true"
      aria-label={model?.name ?? stream.model.id}
      data-message=""
      data-role="assistant"
      data-status="streaming"
    >
      <Reasoning text={reasoning} live={thinking} hidden={false} />
      {text !== '' && <Markdown source={text} live className={styles.answerContent} data={CONTENT} />}
      <ToolWork parts={stream.parts} results={NO_PARTS} streaming />
      <p className={styles.caption} role="status" aria-live="polite">
        {thinking ? t('chat.thinking') : t('chat.writing')}
      </p>
    </article>
  )
}
