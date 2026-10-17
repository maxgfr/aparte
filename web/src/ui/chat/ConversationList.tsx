import { Archive, MoreHorizontal, Pin, SquarePen } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'wouter'
import { useConversations, useSession, useStreaming } from '../../app/chat.tsx'
import { chatPath, paths } from '../../app/routes.ts'
import { useToast } from '../../app/toast.tsx'
import type { Conversation, Id } from '../../core/contracts/workspace.ts'
import { formatRelative } from '../../i18n/format.ts'
import type { Key } from '../../i18n/index.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button, buttonClass } from '../components/Button.tsx'
import { Field } from '../components/Field.tsx'
import { IconButton } from '../components/IconButton.tsx'
import { Sheet } from '../components/Sheet.tsx'
import { cx } from '../cx.ts'
import styles from './Chat.module.css'
import { groupConversations, type ListGroupKey, matches, queryWords } from './view.ts'

const GROUP_KEYS: Readonly<Record<ListGroupKey, Extract<Key, `chat.group${string}`>>> = {
  pinned: 'chat.groupPinned',
  today: 'chat.groupToday',
  yesterday: 'chat.groupYesterday',
  week: 'chat.groupWeek',
  month: 'chat.groupMonth',
  older: 'chat.groupOlder',
}

/** The actions of one conversation: rename, pin, archive, delete (with Undo). */
export function ConversationActions({
  conversation,
  open,
  onClose,
  onDeleted,
}: {
  conversation: Conversation
  open: boolean
  onClose: () => void
  onDeleted?: () => void
}) {
  const t = useT()
  const session = useSession()
  const toast = useToast()
  const [title, setTitle] = useState(conversation.title)
  useEffect(() => {
    if (open) setTitle(conversation.title)
  }, [open, conversation.title])
  if (session === null) return null
  const ws = session.workspace
  const id = conversation.id
  const name = conversation.title || t('chat.untitled')
  return (
    <Sheet open={open} title={t('chat.actionsFor', { title: name })} onClose={onClose}>
      <form
        className={styles.actionsSheet}
        onSubmit={(e) => {
          e.preventDefault()
          const next = title.trim()
          if (next !== conversation.title) ws.conversations.update(id, { title: next })
          onClose()
        }}
      >
        <Field label={t('chat.renameLabel')} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        <Button type="submit" variant="secondary" disabled={title.trim() === conversation.title}>
          {t('chat.rename')}
        </Button>
        <div className={styles.sheetActions}>
          <Button
            variant="plain"
            icon={<Pin size={18} strokeWidth={1.75} aria-hidden="true" />}
            onClick={() => {
              ws.conversations.update(id, { pinned: !conversation.pinned })
              onClose()
            }}
          >
            {conversation.pinned ? t('chat.unpin') : t('chat.pin')}
          </Button>
          <Button
            variant="plain"
            icon={<Archive size={18} strokeWidth={1.75} aria-hidden="true" />}
            onClick={() => {
              const archived = !conversation.archived
              ws.conversations.update(id, { archived })
              onClose()
              if (archived) {
                toast(t('chat.archived'), [
                  { label: t('chat.undo'), onClick: () => ws.conversations.update(id, { archived: false }) },
                ])
              }
            }}
          >
            {conversation.archived ? t('chat.unarchive') : t('chat.archive')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              // Reversible: the trash keeps it until it is purged, so the delete acts at once and offers Undo.
              session.chat.stop(id)
              ws.conversations.trash(id)
              onClose()
              onDeleted?.()
              toast(t('chat.deleted'), [{ label: t('chat.undo'), onClick: () => ws.conversations.restore(id) }])
            }}
          >
            {t('chat.delete')}
          </Button>
        </div>
      </form>
    </Sheet>
  )
}

/**
 * Conversation ids whose titles or messages match the query, from the session's in-memory search index (built after
 * unlock, dropped on lock); re-run when the indexed content changes.
 */
function useMessageSearch(list: readonly Conversation[], query: string, enabled: boolean) {
  const session = useSession()
  const [result, setResult] = useState<{ query: string; ids: ReadonlySet<Id> } | null>(null)
  const [running, setRunning] = useState(false)
  useEffect(() => {
    if (!enabled || session === null) return
    if (queryWords(query).length === 0) return
    const index = session.search
    let live = true
    const run = () => {
      setRunning(true)
      index
        .ready()
        .then(() => index.search(query, { limit: Math.max(1, list.length), messagesPerHit: 1 }))
        .then(
          (hits) => {
            if (live) setResult({ query, ids: new Set(hits.map((h) => h.conversation)) })
          },
          // Locked meanwhile: the list closes with the session.
          () => undefined,
        )
        .finally(() => {
          if (live) setRunning(false)
        })
    }
    run()
    const off = index.subscribe(run)
    return () => {
      live = false
      off()
      setRunning(false)
    }
  }, [enabled, session, list, query])
  return { result: result !== null && result.query === query ? result.ids : null, running }
}

/** The conversation list: search, new chat, sections by date, and each chat's actions. */
export function ConversationList({ activeId = null, compact = false }: { activeId?: Id | null; compact?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState(false)
  const [deep, setDeep] = useState(false)
  const [menu, setMenu] = useState<Id | null>(null)
  const list = useConversations({ archived })
  const streaming = useStreaming()
  const words = useMemo(() => queryWords(query), [query])
  const search = useMessageSearch(list, query, deep)
  const shown = useMemo(
    () => list.filter((c) => matches(c.title || t('chat.untitled'), words) || search.result?.has(c.id) === true),
    [list, words, search.result, t],
  )
  const now = Date.now()
  const groups = groupConversations(shown, now)
  const menuFor = list.find((c) => c.id === menu)

  return (
    <div className={cx(styles.list, compact && styles.listCompact)}>
      <div className={styles.listTop}>
        <Link href={paths.chat} className={buttonClass({ variant: 'secondary', full: true })}>
          <SquarePen size={18} strokeWidth={1.75} aria-hidden="true" />
          {t('chat.navNewChat')}
        </Link>
        <Field
          label={t('chat.listSearch')}
          hideLabel
          type="search"
          placeholder={t('chat.listSearch')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            // A new query searches titles first; the messages only when asked again.
            setDeep(false)
          }}
          autoComplete="off"
        />
      </div>
      {words.length > 0 && !deep && (
        <Button variant="plain" onClick={() => setDeep(true)}>
          {t('chat.listSearchMessages')}
        </Button>
      )}
      {search.running && (
        <p className={styles.caption} role="status">
          {t('chat.listSearching')}
        </p>
      )}
      {groups.length === 0 && (
        <p className={styles.muted} role="status">
          {words.length > 0
            ? t('chat.listNoMatch', { query })
            : archived
              ? t('chat.listArchivedEmpty')
              : t('chat.listEmptyBody')}
        </p>
      )}
      {groups.map((group) => (
        <section key={group.key} className={styles.listGroup} aria-label={t(GROUP_KEYS[group.key])}>
          <h2 className={styles.listGroupTitle}>{t(GROUP_KEYS[group.key])}</h2>
          <ul className={styles.listItems}>
            {group.items.map((conv) => {
              const title = conv.title || t('chat.untitled')
              const active = conv.id === activeId
              return (
                <li key={conv.id} className={styles.listItem}>
                  <Link href={chatPath(conv.id)} className={styles.listLink} aria-current={active ? 'page' : undefined}>
                    <span className={styles.listTitle}>{title}</span>
                    <span className={styles.listMeta}>
                      {streaming.includes(conv.id)
                        ? t('chat.streamingNow')
                        : formatRelative(locale, conv.updatedAt, now)}
                    </span>
                  </Link>
                  <IconButton
                    icon={MoreHorizontal}
                    label={t('chat.actionsFor', { title })}
                    className={styles.listMore}
                    onClick={() => setMenu(conv.id)}
                  />
                </li>
              )
            })}
          </ul>
        </section>
      ))}
      <Button variant="plain" onClick={() => setArchived((v) => !v)}>
        {archived ? t('chat.listShowActive') : t('chat.listShowArchived')}
      </Button>
      {menuFor !== undefined && (
        <ConversationActions conversation={menuFor} open={menu !== null} onClose={() => setMenu(null)} />
      )}
    </div>
  )
}
