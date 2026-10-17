import { ChevronLeft, MoreHorizontal, SquarePen } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, Redirect, useLocation } from 'wouter'
import {
  useConversation,
  useKeyedProviders,
  useSession,
  useSessionState,
  useSetting,
  useStream,
  useThread,
} from '../../app/chat.tsx'
import { needsKey, useModelChoices } from '../../app/providers.tsx'
import { chatPath, paths } from '../../app/routes.ts'
import { useToast } from '../../app/toast.tsx'
import { useVault } from '../../app/vault.tsx'
import type { Effort } from '../../core/contracts/ai.ts'
import type { StreamState } from '../../core/contracts/chat.ts'
import { InvalidInputError, InvalidStateError } from '../../core/contracts/crypto.ts'
import type { Id, ModelRef, Part } from '../../core/contracts/workspace.ts'
import { useT } from '../../i18n/react.tsx'
import styles from '../../ui/chat/Chat.module.css'
import { Composer } from '../../ui/chat/Composer.tsx'
import { ConversationActions } from '../../ui/chat/ConversationList.tsx'
import { type MessageActions, MessageRow, StreamingAnswer } from '../../ui/chat/Messages.tsx'
import { visibleMessages, windowOf } from '../../ui/chat/view.ts'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'

/*
 * The chat screen: one conversation's active branch, the answer streaming into it, and the composer. `/chat` is a new
 * chat: nothing is stored until its first message, which creates the conversation with the model, effort and system
 * prompt chosen here.
 */

/** Distance from the bottom under which the thread keeps following a streaming answer. */
const STICK_PX = 160

function nearBottom(): boolean {
  const doc = document.documentElement
  return doc.scrollHeight - (scrollY + innerHeight) < STICK_PX
}

/** Follows the end of the thread while the reader is there; a reader who scrolled up is left alone. */
function useFollow(trigger: string) {
  const stick = useRef(true)
  useEffect(() => {
    const onScroll = () => {
      stick.current = nearBottom()
    }
    addEventListener('scroll', onScroll, { passive: true })
    return () => removeEventListener('scroll', onScroll)
  }, [])
  // Frames, not every delta: the scroll follows at most once per frame.
  const frame = useRef(0)
  const seen = useRef<string | null>(null)
  useLayoutEffect(() => {
    // Only a change of the thread's content moves the scroll, not any render.
    if (seen.current === trigger) return
    seen.current = trigger
    if (!stick.current) return
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => scrollTo({ top: document.documentElement.scrollHeight }))
  }, [trigger])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])
  return () => {
    stick.current = true
  }
}

/**
 * A stream's parts change at every delta; React renders them at most once per animation frame. A stream that starts
 * or ends shows at once, so its answer appears together with the message that started it.
 */
function useFrameThrottled(value: StreamState | null): StreamState | null {
  const [shown, setShown] = useState(value)
  const latest = useRef(value)
  latest.current = value
  const pending = useRef(0)
  useEffect(() => {
    if (value === null) {
      cancelAnimationFrame(pending.current)
      pending.current = 0
      setShown(value)
      return
    }
    if (pending.current !== 0) return
    pending.current = requestAnimationFrame(() => {
      pending.current = 0
      setShown(latest.current)
    })
  }, [value])
  useEffect(() => () => cancelAnimationFrame(pending.current), [])
  if (value === null || shown === null || shown.messageId !== value.messageId) return value
  return shown
}

export default function ChatScreen({ params }: { params?: { id?: string } }) {
  const t = useT()
  const state = useSessionState()
  const { status } = useVault()
  if (status.state === 'absent') return <Redirect to={paths.welcome} replace />
  if (state.status === 'failed') {
    return (
      <div role="alert">
        <EmptyState
          title={t('chat.sessionFailedTitle')}
          body={t('chat.sessionFailedBody')}
          action={
            <Button variant="primary" onClick={() => location.reload()}>
              {t('chat.retry')}
            </Button>
          }
        />
      </div>
    )
  }
  if (state.status !== 'open') {
    return (
      <p className={styles.loading} role="status">
        {t('chat.sessionOpening')}
      </p>
    )
  }
  const id = params?.id === undefined ? null : decodeURIComponent(params.id)
  return <ChatView key={id ?? 'new'} id={id} />
}

function ChatView({ id }: { id: Id | null }) {
  const t = useT()
  const toast = useToast()
  const [, navigate] = useLocation()
  const session = useSession()
  const conversation = useConversation(id)
  const thread = useThread(id)
  const rawStream = useStream(id)
  const stream = useFrameThrottled(rawStream)
  const keyed = useKeyedProviders()
  const choices = useModelChoices()
  const defaultModel = useSetting('defaultModel')
  const defaultEffort = useSetting('defaultEffort')
  const defaultSystem = useSetting('defaultSystem')
  const [menu, setMenu] = useState(false)
  const [earlier, setEarlier] = useState(0)

  // A new chat keeps its choices here until its first message creates the conversation.
  const [draft, setDraft] = useState<{ model: ModelRef | null; effort: Effort | null; system: string | null }>({
    model: null,
    effort: null,
    system: null,
  })
  const fallbackModel = defaultModel ?? choices[0]?.model.ref ?? null
  const modelRef = conversation?.model ?? (id === null ? (draft.model ?? fallbackModel) : null)
  const model = modelRef === null || session === null ? null : session.resolveModel(modelRef)
  const effortSource = conversation?.effort ?? (id === null ? draft.effort : null)
  const effort =
    model === null || session === null
      ? null
      : session.modules.request.pickEffort(
          { effort: effortSource },
          { defaultEffort: defaultEffort ?? null },
          model.capabilities,
        )
  const system = conversation?.system ?? draft.system ?? defaultSystem ?? ''
  const started = conversation?.startedAt !== undefined

  const path = thread.status === 'ready' ? thread.path : []
  // A regenerated answer streams as a sibling of the one on screen: the branch shows up to its parent meanwhile.
  const streamParent = rawStream?.parentId ?? null
  const visible = useMemo(() => {
    const all = visibleMessages(path)
    if (streamParent === null) return all
    const at = all.findIndex((m) => m.id === streamParent)
    return at < 0 ? all : all.slice(0, at + 1)
  }, [path, streamParent])
  const { shown, hidden } = windowOf(visible, earlier)
  const treeSize = thread.status === 'ready' ? thread.thread.all().length : 0
  let streamed = 0
  for (const part of stream?.parts ?? [])
    if (part.type === 'text' || part.type === 'reasoning') streamed += part.text.length
  const follow = useFollow(`${visible.length}|${stream?.parts.length ?? 0}|${streamed}`)
  const busy = rawStream !== null

  // Esc stops the answer from anywhere on the screen, unless a dialog is open (Esc closes it instead).
  useEffect(() => {
    if (id === null || rawStream === null || session === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open]')) return
      session.chat.stop(id)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [id, rawStream, session])

  const explain = useCallback(
    (error: unknown) => {
      if (error instanceof InvalidStateError && /lock/i.test(error.message)) toast(t('chat.sendFailedLocking'))
      else if (error instanceof InvalidStateError) toast(t('chat.sendFailedNoModel'))
      else if (error instanceof InvalidInputError) toast(t('chat.sendFailed'))
      else toast(t('chat.sendFailed'))
    },
    [toast, t],
  )

  const onSend = async (parts: readonly Part[]): Promise<boolean> => {
    if (session === null) return false
    if (modelRef === null || model === null) {
      toast(t('chat.sendFailedNoModel'))
      return false
    }
    const provider = session.workspace.providers.get(modelRef.provider)
    if (provider !== undefined && needsKey(provider) && keyed !== null && !keyed.has(provider.id)) {
      toast(t('chat.sendFailedNoKey', { provider: provider.label }))
      return false
    }
    let target = id
    let created = false
    if (target === null) {
      target = session.workspace.conversations.create({
        model: modelRef,
        effort: draft.effort,
        ...(draft.system === null ? {} : { system: draft.system }),
      })
      created = true
    }
    try {
      const turn = await session.chat.send(target, parts)
      if (created) navigate(chatPath(target), { replace: true })
      follow()
      turn.done.catch(() => undefined)
      return true
    } catch (error) {
      // Nothing was written for the turn: a chat created for it goes away again.
      if (created) session.workspace.conversations.trash(target)
      explain(error)
      return false
    }
  }

  // The tree object is stable while the conversation is open, so the actions (and every memoised row) are too.
  const tree = thread.status === 'ready' ? thread.thread : null
  const actions = useMemo<MessageActions>(() => {
    if (session === null || id === null || tree === null) return { busy: true }
    return {
      busy,
      onEdit: async (messageId, parts) => {
        try {
          await session.chat.edit(id, messageId, parts)
        } catch (error) {
          explain(error)
        }
      },
      onRegenerate: (messageId) => {
        session.chat.regenerate(id, messageId).catch(explain)
      },
      onBranch: (messageId) => {
        tree.setLeaf(tree.descend(messageId))
      },
    }
  }, [session, id, tree, busy, explain])

  const onModel = (ref: ModelRef) => {
    if (session === null) return
    if (id !== null) session.workspace.conversations.update(id, { model: ref })
    else setDraft((d) => ({ ...d, model: ref }))
    // The last model picked is where the next new chat starts.
    session.workspace.settings.set('defaultModel', ref)
  }
  const onEffort = (next: Effort) => {
    if (session === null) return
    if (id !== null) session.workspace.conversations.update(id, { effort: next })
    else setDraft((d) => ({ ...d, effort: next }))
  }
  const onSystem = async (text: string) => {
    if (session === null) return
    if (id === null) setDraft((d) => ({ ...d, system: text }))
    else if (!started) session.workspace.conversations.update(id, { system: text })
    else await session.chat.appendSystem(id, text)
  }

  if (
    id !== null &&
    (thread.status === 'missing' || (conversation !== undefined && conversation.deletedAt !== undefined))
  ) {
    return (
      <EmptyState
        title={t('chat.threadMissing')}
        body={t('chat.threadMissingBody')}
        action={
          <Link href={paths.chat} className={buttonClass({ variant: 'primary' })}>
            {t('chat.navNewChat')}
          </Link>
        }
      />
    )
  }

  const title = conversation?.title || t('chat.untitled')
  const empty = visible.length === 0 && stream === null
  const noModels = choices.length === 0

  return (
    <div className={styles.chat}>
      <header className={styles.chatHeader}>
        <Link href={paths.conversations} className={styles.headerBack}>
          <ChevronLeft size={20} strokeWidth={2} aria-hidden="true" />
          <span>{t('chat.backToChats')}</span>
        </Link>
        <h1 className={styles.chatTitle}>{title}</h1>
        <div className={styles.headerActions}>
          <Link href={paths.about} className={styles.privacyChip}>
            {t('chat.privacyLocal')}
          </Link>
          {conversation !== undefined && (
            <IconButton icon={MoreHorizontal} label={t('chat.more')} onClick={() => setMenu(true)} />
          )}
          <Link
            href={paths.chat}
            className={styles.headerIcon}
            aria-label={t('chat.navNewChat')}
            title={t('chat.navNewChat')}
          >
            <SquarePen size={20} strokeWidth={1.75} aria-hidden="true" />
          </Link>
        </div>
      </header>

      <div className={styles.thread}>
        {thread.status === 'loading' && id !== null && (
          <p className={styles.loading} role="status">
            {t('chat.threadLoading')}
          </p>
        )}
        {empty && thread.status !== 'loading' && (
          <div className={styles.empty}>
            <h2 className={styles.emptyTitle}>{noModels ? t('chat.noProviderTitle') : t('chat.emptyTitle')}</h2>
            <p className={styles.emptyBody}>{noModels ? t('chat.noProviderBody') : t('chat.emptyBody')}</p>
            {noModels && (
              <Link href={paths.providers} className={buttonClass({ variant: 'primary' })}>
                {t('chat.noProviderAction')}
              </Link>
            )}
          </div>
        )}
        {hidden > 0 && (
          <Button variant="plain" onClick={() => setEarlier((n) => n + 1)}>
            {t('chat.showEarlier', { count: hidden })}
          </Button>
        )}
        {thread.status === 'ready' &&
          shown.map((message) => (
            <MessageRow
              key={message.id}
              thread={thread.thread}
              message={message}
              actions={actions}
              treeSize={treeSize}
            />
          ))}
        {stream !== null && <StreamingAnswer stream={stream} />}
      </div>

      <div className={styles.composerDock}>
        <Composer
          modelRef={modelRef}
          model={model}
          onModel={onModel}
          effort={effort}
          onEffort={onEffort}
          system={system}
          systemFrozen={started}
          onSystem={onSystem}
          streaming={busy}
          queued={rawStream?.queued ?? 0}
          onSend={onSend}
          onStop={() => id !== null && session?.chat.stop(id)}
        />
      </div>

      {conversation !== undefined && (
        <ConversationActions
          conversation={conversation}
          open={menu}
          onClose={() => setMenu(false)}
          onDeleted={() => navigate(paths.conversations, { replace: true })}
        />
      )}
    </div>
  )
}
