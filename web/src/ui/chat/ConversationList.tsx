import { Archive, Download, MoreHorizontal, Pin, RotateCcw, SquarePen, Trash2 } from 'lucide-react'
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
import { ExportSheet } from '../transfer/ExportSheet.tsx'
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
  // The export sheet replaces this one; closing it closes both.
  const [exporting, setExporting] = useState(false)
  useEffect(() => {
    if (open) setTitle(conversation.title)
  }, [open, conversation.title])
  if (session === null) return null
  const ws = session.workspace
  const id = conversation.id
  const name = conversation.title || t('chat.untitled')
  return (
    <>
      <Sheet
        open={open && !exporting}
        title={t('chat.actionsFor', { title: name })}
        onClose={() => {
          if (!exporting) onClose()
        }}
      >
        <form
          className={styles.actionsSheet}
          onSubmit={(e) => {
            e.preventDefault()
            const next = title.trim()
            if (next !== conversation.title) ws.conversations.update(id, { title: next })
            onClose()
          }}
        >
          <Field
            label={t('chat.renameLabel')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
          />
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
              variant="plain"
              icon={<Download size={18} strokeWidth={1.75} aria-hidden="true" />}
              onClick={() => setExporting(true)}
            >
              {t('transfer.exportAction')}
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
      {exporting && (
        <ExportSheet
          conversation={conversation}
          open={open}
          onClose={() => {
            setExporting(false)
            onClose()
          }}
        />
      )}
    </>
  )
}

/** The actions of a conversation in the trash: restore it, or delete it for good. */
function TrashedActions({
  conversation,
  open,
  onClose,
}: {
  conversation: Conversation
  open: boolean
  onClose: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const session = useSession()
  const toast = useToast()
  const [purging, setPurging] = useState(false)
  if (session === null) return null
  const ws = session.workspace
  const id = conversation.id
  const name = conversation.title || t('chat.untitled')
  return (
    <Sheet open={open} title={t('chat.actionsFor', { title: name })} onClose={onClose}>
      <div className={styles.actionsSheet}>
        {conversation.deletedAt !== undefined && (
          <p className={styles.muted}>
            {t('chat.trashedAgo', { when: formatRelative(locale, conversation.deletedAt) })}
          </p>
        )}
        <div className={styles.sheetActions}>
          <Button
            variant="secondary"
            icon={<RotateCcw size={18} strokeWidth={1.75} aria-hidden="true" />}
            disabled={purging}
            onClick={() => {
              ws.conversations.restore(id)
              onClose()
              toast(t('chat.restored'))
            }}
          >
            {t('chat.restore')}
          </Button>
        </div>
        <p className={styles.muted}>{t('chat.purgeBody')}</p>
        <div className={styles.sheetActions}>
          <Button
            variant="danger"
            loading={purging}
            onClick={() => {
              setPurging(true)
              ws.conversations
                .purge(id)
                .then(
                  () => toast(t('chat.purged')),
                  // Restored meanwhile (on another device, through sync): it is no longer in the trash.
                  () => undefined,
                )
                .finally(() => {
                  setPurging(false)
                  onClose()
                })
            }}
          >
            {t('chat.purge')}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

/** Empties the trash, once confirmed: every conversation in it is deleted for good. */
function EmptyTrash({
  trashed,
  open,
  onClose,
}: {
  trashed: readonly Conversation[]
  open: boolean
  onClose: () => void
}) {
  const t = useT()
  const session = useSession()
  const toast = useToast()
  const [emptying, setEmptying] = useState(false)
  if (session === null) return null
  const ws = session.workspace
  return (
    <Sheet open={open} title={t('chat.emptyTrash')} onClose={onClose}>
      <div className={styles.actionsSheet}>
        <p className={styles.muted}>{t('chat.emptyTrashBody', { count: trashed.length })}</p>
        <div className={styles.sheetActions}>
          <Button
            variant="danger"
            loading={emptying}
            onClick={async () => {
              setEmptying(true)
              let purged = 0
              for (const c of trashed) {
                // One restored meanwhile (here or through sync) is no longer in the trash: it is kept.
                await ws.conversations.purge(c.id).then(
                  () => purged++,
                  () => undefined,
                )
              }
              setEmptying(false)
              onClose()
              if (purged > 0) toast(t('chat.emptiedTrash'))
            }}
          >
            {t('chat.emptyTrash')}
          </Button>
          <Button variant="plain" onClick={onClose}>
            {t('chat.cancel')}
          </Button>
        </div>
      </div>
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

/** The conversation list: search, new chat, sections by date, and each chat's actions; the archive and the trash. */
export function ConversationList({ activeId = null, compact = false }: { activeId?: Id | null; compact?: boolean }) {
  const t = useT()
  const locale = useLocale()
  const [query, setQuery] = useState('')
  const [view, setView] = useState<'active' | 'archived' | 'trash'>('active')
  const [deep, setDeep] = useState(false)
  const [menu, setMenu] = useState<Id | null>(null)
  const [emptying, setEmptying] = useState(false)
  const trash = view === 'trash'
  const list = useConversations(trash ? { trashed: true } : { archived: view === 'archived' })
  const streaming = useStreaming()
  const words = useMemo(() => queryWords(query), [query])
  // The search index leaves the trash out: there, only titles are searched.
  const search = useMessageSearch(list, query, deep && !trash)
  const show = (next: typeof view) => {
    setView(next)
    setMenu(null)
  }
  const shown = useMemo(
    () => list.filter((c) => matches(c.title || t('chat.untitled'), words) || search.result?.has(c.id) === true),
    [list, words, search.result, t],
  )
  const now = Date.now()
  // The trash is one section, the latest deleted first.
  const groups = trash
    ? shown.length === 0
      ? []
      : [
          {
            key: 'trash',
            title: t('chat.listShowTrash'),
            items: [...shown].sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)),
          },
        ]
    : groupConversations(shown, now).map((g) => ({ key: g.key, title: t(GROUP_KEYS[g.key]), items: g.items }))
  const menuFor = list.find((c) => c.id === menu)
  // A chat that left this list (restored, deleted or moved by sync) takes its open sheet with it, for good.
  useEffect(() => {
    if (menu !== null && menuFor === undefined) setMenu(null)
  }, [menu, menuFor])

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
      {words.length > 0 && !deep && !trash && (
        <Button variant="plain" onClick={() => setDeep(true)}>
          {t('chat.listSearchMessages')}
        </Button>
      )}
      {search.running && (
        <p className={styles.caption} role="status">
          {t('chat.listSearching')}
        </p>
      )}
      {trash && list.length > 0 && words.length === 0 && (
        <>
          <p className={styles.muted}>{t('chat.listTrashNote')}</p>
          <Button
            variant="plain"
            icon={<Trash2 size={18} strokeWidth={1.75} aria-hidden="true" />}
            onClick={() => setEmptying(true)}
          >
            {t('chat.emptyTrash')}
          </Button>
        </>
      )}
      {groups.length === 0 && (
        <p className={styles.muted} role="status">
          {words.length > 0
            ? t('chat.listNoMatch', { query })
            : view === 'archived'
              ? t('chat.listArchivedEmpty')
              : trash
                ? t('chat.listTrashEmpty')
                : t('chat.listEmptyBody')}
        </p>
      )}
      {groups.map((group) => (
        <section key={group.key} className={styles.listGroup} aria-label={group.title}>
          <h2 className={styles.listGroupTitle}>{group.title}</h2>
          <ul className={styles.listItems}>
            {group.items.map((conv) => {
              const title = conv.title || t('chat.untitled')
              const active = conv.id === activeId && !trash
              return (
                <li key={conv.id} className={cx(styles.listItem, active && styles.listItemActive)}>
                  {trash ? (
                    // A chat in the trash does not open: it is restored first.
                    <div className={styles.listLink}>
                      <span className={styles.listTitle}>{title}</span>
                      <span className={styles.listMeta}>
                        {t('chat.trashedAgo', { when: formatRelative(locale, conv.deletedAt ?? conv.updatedAt, now) })}
                      </span>
                    </div>
                  ) : (
                    <Link
                      href={chatPath(conv.id)}
                      className={styles.listLink}
                      aria-current={active ? 'page' : undefined}
                    >
                      <span className={styles.listTitle}>{title}</span>
                      <span className={styles.listMeta}>
                        {streaming.includes(conv.id)
                          ? t('chat.streamingNow')
                          : formatRelative(locale, conv.updatedAt, now)}
                      </span>
                    </Link>
                  )}
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
      {view === 'active' ? (
        <>
          <Button variant="plain" onClick={() => show('archived')}>
            {t('chat.listShowArchived')}
          </Button>
          <Button variant="plain" onClick={() => show('trash')}>
            {t('chat.listShowTrash')}
          </Button>
        </>
      ) : (
        <Button variant="plain" onClick={() => show('active')}>
          {t('chat.listShowActive')}
        </Button>
      )}
      {menuFor !== undefined &&
        (trash ? (
          // One sheet per chat, and a purge that ends late closes its own sheet only, never another chat's.
          <TrashedActions
            key={menuFor.id}
            conversation={menuFor}
            open={menu !== null}
            onClose={() => setMenu((m) => (m === menuFor.id ? null : m))}
          />
        ) : (
          <ConversationActions conversation={menuFor} open={menu !== null} onClose={() => setMenu(null)} />
        ))}
      {trash && <EmptyTrash trashed={list} open={emptying} onClose={() => setEmptying(false)} />}
    </div>
  )
}
