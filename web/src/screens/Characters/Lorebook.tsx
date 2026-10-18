import { Plus, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { useSession } from '../../app/chat.tsx'
import { paths } from '../../app/routes.ts'
import { useToast } from '../../app/toast.tsx'
import type { Lorebook, LoreEntry } from '../../core/contracts/extras.ts'
import type { Entity } from '../../core/contracts/workspace.ts'
import { useT } from '../../i18n/react.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { SwitchRow } from '../../ui/components/Switch.tsx'
import { useEntity } from '../../ui/roleplay/hooks.ts'
import styles from '../../ui/roleplay/Roleplay.module.css'
import { Screen } from '../../ui/shell/Screen.tsx'

/** One lorebook: its settings and entries, edited as a whole and saved together. */
export default function LorebookScreen({ params }: { params?: { id?: string } }) {
  const t = useT()
  const id = params?.id === undefined ? null : decodeURIComponent(params.id)
  const book = useEntity('lorebooks', id)
  if (book === undefined || book.deletedAt !== undefined) {
    return (
      <Screen title={t('roleplay.lorebookTitle')} back={paths.characters}>
        <EmptyState
          title={t('roleplay.lorebookMissing')}
          action={
            <Link href={paths.characters} className={buttonClass({ variant: 'primary' })}>
              {t('roleplay.lorebooksTitle')}
            </Link>
          }
        />
      </Screen>
    )
  }
  return <Editor key={book.id} book={book} />
}

interface EntryForm {
  triggers: string
  secondary: string
  content: string
  enabled: boolean
  constant: boolean
  caseSensitive: boolean
  wholeWord: boolean
  order: string
  comment: string
}

const words = (text: string): string[] =>
  text
    .split(',')
    .map((w) => w.trim())
    .filter((w) => w !== '')

const toForm = (e: LoreEntry): EntryForm => ({
  triggers: e.triggers.join(', '),
  secondary: (e.secondary ?? []).join(', '),
  content: e.content,
  enabled: e.enabled,
  constant: e.constant === true,
  caseSensitive: e.caseSensitive === true,
  wholeWord: e.wholeWord !== false,
  order: String(e.order),
  comment: e.comment ?? '',
})

function toEntry(f: EntryForm, index: number): LoreEntry {
  const secondary = words(f.secondary)
  const order = Number(f.order)
  return {
    triggers: words(f.triggers),
    content: f.content.trim(),
    enabled: f.enabled,
    order: Number.isFinite(order) ? Math.round(order) : index,
    ...(secondary.length > 0 ? { secondary } : {}),
    ...(f.constant ? { constant: true } : {}),
    ...(f.caseSensitive ? { caseSensitive: true } : {}),
    ...(f.wholeWord ? {} : { wholeWord: false }),
    ...(f.comment.trim() === '' ? {} : { comment: f.comment.trim() }),
  }
}

const positive = (value: string, fallback: number, max: number): number => {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n >= 1 ? Math.min(n, max) : fallback
}

function EntryEditor({
  index,
  entry,
  onChange,
  onRemove,
}: {
  index: number
  entry: EntryForm
  onChange: (entry: EntryForm) => void
  onRemove: () => void
}) {
  const t = useT()
  const id = useId()
  const set = <K extends keyof EntryForm>(key: K, value: EntryForm[K]) => onChange({ ...entry, [key]: value })
  const label = t('roleplay.entryLabel', { index: index + 1 })
  return (
    <li className={styles.card} aria-label={label}>
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{entry.comment.trim() === '' ? label : entry.comment}</h3>
        <IconButton icon={Trash2} label={t('roleplay.entryRemove', { index: index + 1 })} onClick={onRemove} />
      </div>
      <Field
        label={t('roleplay.entryTriggers')}
        hint={t('roleplay.entryTriggersHint')}
        value={entry.triggers}
        onChange={(e) => set('triggers', e.target.value)}
      />
      <Field
        label={t('roleplay.entrySecondary')}
        hint={t('roleplay.entrySecondaryHint')}
        value={entry.secondary}
        onChange={(e) => set('secondary', e.target.value)}
      />
      <div className={styles.field}>
        <label htmlFor={id} className={styles.label}>
          {t('roleplay.entryContent')}
        </label>
        <textarea
          id={id}
          className={styles.textarea}
          rows={4}
          value={entry.content}
          onChange={(e) => set('content', e.target.value)}
        />
      </div>
      <Field
        label={t('roleplay.entryComment')}
        value={entry.comment}
        onChange={(e) => set('comment', e.target.value)}
      />
      <Field
        label={t('roleplay.entryOrder')}
        type="number"
        inputMode="numeric"
        value={entry.order}
        onChange={(e) => set('order', e.target.value)}
      />
      <SwitchRow label={t('roleplay.entryEnabled')} checked={entry.enabled} onChange={(v) => set('enabled', v)} />
      <SwitchRow
        label={t('roleplay.entryConstant')}
        hint={t('roleplay.entryConstantHint')}
        checked={entry.constant}
        onChange={(v) => set('constant', v)}
      />
      <SwitchRow
        label={t('roleplay.entryCaseSensitive')}
        checked={entry.caseSensitive}
        onChange={(v) => set('caseSensitive', v)}
      />
      <SwitchRow label={t('roleplay.entryWholeWord')} checked={entry.wholeWord} onChange={(v) => set('wholeWord', v)} />
    </li>
  )
}

let entrySeq = 0

function Editor({ book }: { book: Entity<Lorebook> }) {
  const t = useT()
  const toast = useToast()
  const session = useSession()
  const [, navigate] = useLocation()
  const [name, setName] = useState(book.name)
  const [depth, setDepth] = useState(String(book.scanDepth))
  const [budget, setBudget] = useState(String(book.budget))
  const [entries, setEntries] = useState(() => book.entries.map((e) => ({ key: ++entrySeq, form: toForm(e) })))
  const titleId = useId()
  if (session === null) return null
  const collection = session.workspace.collection('lorebooks')

  const save = () => {
    collection.update(book.id, {
      name: name.trim() === '' ? book.name : name.trim(),
      scanDepth: positive(depth, book.scanDepth, 100),
      budget: positive(budget, book.budget, 100_000),
      entries: entries.map((e, i) => toEntry(e.form, i)).filter((e) => e.content !== ''),
    })
    toast(t('roleplay.lorebookSaved'))
  }

  return (
    <Screen title={book.name} back={paths.characters}>
      <form
        className={styles.stack}
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <div className={styles.form}>
          <Field
            label={t('roleplay.lorebookName')}
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
          />
          <Field
            label={t('roleplay.lorebookScanDepth')}
            hint={t('roleplay.lorebookScanDepthHint')}
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            value={depth}
            onChange={(e) => setDepth(e.target.value)}
          />
          <Field
            label={t('roleplay.lorebookBudget')}
            hint={t('roleplay.lorebookBudgetHint')}
            type="number"
            inputMode="numeric"
            min={1}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
        </div>
        <section className={styles.section} aria-labelledby={titleId}>
          <h2 id={titleId} className={styles.sectionTitle}>
            {t('roleplay.lorebookEntriesTitle')}
          </h2>
          {entries.length === 0 && <p className={styles.muted}>{t('roleplay.lorebookNoEntries')}</p>}
          <ul className={styles.list}>
            {entries.map((e, i) => (
              <EntryEditor
                key={e.key}
                index={i}
                entry={e.form}
                onChange={(form) => setEntries((list) => list.map((x) => (x.key === e.key ? { ...x, form } : x)))}
                onRemove={() => setEntries((list) => list.filter((x) => x.key !== e.key))}
              />
            ))}
          </ul>
          <div className={styles.row}>
            <Button
              icon={<Plus size={18} strokeWidth={1.75} aria-hidden="true" />}
              onClick={() =>
                setEntries((list) => [
                  ...list,
                  {
                    key: ++entrySeq,
                    form: toForm({ triggers: [], content: '', enabled: true, order: list.length }),
                  },
                ])
              }
            >
              {t('roleplay.entryAdd')}
            </Button>
          </div>
        </section>
        <div className={styles.row}>
          <Button type="submit" variant="primary">
            {t('roleplay.lorebookSave')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              collection.trash(book.id)
              toast(t('roleplay.lorebookDeleted'))
              navigate(paths.characters, { replace: true })
            }}
          >
            {t('roleplay.lorebookDelete')}
          </Button>
        </div>
      </form>
    </Screen>
  )
}
