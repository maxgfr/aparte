import { Plus, Trash2 } from 'lucide-react'
import { useId, useState } from 'react'
import { useLocation } from 'wouter'
import { useSession } from '../../app/chat.tsx'
import { characterPath, lorebookPath, paths } from '../../app/routes.ts'
import { useToast } from '../../app/toast.tsx'
import type { RegexRule } from '../../core/contracts/extras.ts'
import type { Entity } from '../../core/contracts/workspace.ts'
import { readCard } from '../../core/roleplay/cards.ts'
import { applyRules, ruleProblem } from '../../core/roleplay/regex.ts'
import { keyAfter } from '../../core/workspace/order.ts'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { SwitchRow } from '../../ui/components/Switch.tsx'
import { Avatar } from '../../ui/roleplay/Avatar.tsx'
import { useCollection } from '../../ui/roleplay/hooks.ts'
import styles from '../../ui/roleplay/Roleplay.module.css'
import { Screen } from '../../ui/shell/Screen.tsx'

/*
 * Characters and the roleplay tools: character cards (imported from a PNG or JSON card, read on this device), the
 * lorebooks, the quick replies and the regex rules. Everything is stored in the encrypted workspace and synced.
 */

export default function CharactersScreen() {
  const t = useT()
  const session = useSession()
  return (
    <Screen title={t('roleplay.title')} subtitle={t('roleplay.subtitle')} back={paths.more}>
      {session === null ? (
        <p className={styles.muted} role="status">
          {t('common.loading')}
        </p>
      ) : (
        <div className={styles.stack}>
          <Characters />
          <Lorebooks />
          <QuickReplies />
          <RegexRules />
        </div>
      )}
    </Screen>
  )
}

function firstLine(text: string | undefined): string | undefined {
  const line = text?.split('\n').find((l) => l.trim() !== '')
  return line === undefined ? undefined : line.length > 120 ? `${line.slice(0, 119)}…` : line
}

function Characters() {
  const t = useT()
  const toast = useToast()
  const session = useSession()
  const [, navigate] = useLocation()
  const personas = useCollection('personas')
  const inputId = useId()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (session === null) return null
  const ws = session.workspace

  const importFile = async (file: File | undefined) => {
    if (file === undefined) return
    setBusy(true)
    setError(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const { persona, lorebook } = readCard(bytes)
      const isPng = persona !== undefined && bytes[0] === 0x89
      const avatar = isPng ? await session.blobs.put(bytes, 'image/png') : undefined
      const book = lorebook === null ? undefined : ws.collection('lorebooks').create(lorebook)
      ws.collection('personas').create({
        ...persona,
        ...(avatar === undefined ? {} : { avatar }),
        ...(book === undefined ? {} : { lorebook: book }),
      })
      toast(
        book === undefined
          ? t('roleplay.imported', { name: persona.name })
          : t('roleplay.importedWithLorebook', { name: persona.name }),
      )
    } catch (cause) {
      setError(t('roleplay.importFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className={styles.section} aria-labelledby={`${inputId}-title`}>
      <h2 id={`${inputId}-title`} className={styles.sectionTitle}>
        {t('roleplay.charactersTitle')}
      </h2>
      {personas.length === 0 ? (
        <p className={styles.muted}>{t('roleplay.charactersEmpty')}</p>
      ) : (
        <ListGroup title={t('roleplay.charactersTitle')} hideTitle>
          {personas.map((p) => (
            <ListRow
              key={p.id}
              href={characterPath(p.id)}
              leading={<Avatar blob={p.avatar} alt={t('roleplay.avatarOf', { name: p.name })} />}
              title={p.name}
              subtitle={firstLine(p.description)}
            />
          ))}
        </ListGroup>
      )}
      <div className={styles.field}>
        <label htmlFor={inputId} className={styles.label}>
          {t('roleplay.importCard')}
        </label>
        <input
          id={inputId}
          className={styles.file}
          type="file"
          accept=".png,.json,image/png,application/json"
          disabled={busy}
          aria-describedby={`${inputId}-hint`}
          onChange={(e) => {
            void importFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <p id={`${inputId}-hint`} className={styles.muted}>
          {busy ? t('roleplay.importing') : t('roleplay.importCardHint')}
        </p>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
      <div className={styles.row}>
        <Button
          icon={<Plus size={18} strokeWidth={1.75} aria-hidden="true" />}
          onClick={() => {
            const id = ws
              .collection('personas')
              .create({ name: t('roleplay.untitledCharacter'), systemPrompt: '', source: 'manual' })
            navigate(characterPath(id))
          }}
        >
          {t('roleplay.newCharacter')}
        </Button>
      </div>
    </section>
  )
}

function Lorebooks() {
  const t = useT()
  const session = useSession()
  const [, navigate] = useLocation()
  const books = useCollection('lorebooks')
  const id = useId()
  if (session === null) return null
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h2 id={id} className={styles.sectionTitle}>
        {t('roleplay.lorebooksTitle')}
      </h2>
      {books.length === 0 ? (
        <p className={styles.muted}>{t('roleplay.lorebooksEmpty')}</p>
      ) : (
        <ListGroup title={t('roleplay.lorebooksTitle')} hideTitle>
          {books.map((b) => (
            <ListRow
              key={b.id}
              href={lorebookPath(b.id)}
              title={b.name}
              subtitle={t('roleplay.lorebookEntries', { count: b.entries.length })}
            />
          ))}
        </ListGroup>
      )}
      <div className={styles.row}>
        <Button
          icon={<Plus size={18} strokeWidth={1.75} aria-hidden="true" />}
          onClick={() => {
            const book = session.workspace
              .collection('lorebooks')
              .create({ name: t('roleplay.untitledLorebook'), entries: [], scanDepth: 4, budget: 4000 })
            navigate(lorebookPath(book))
          }}
        >
          {t('roleplay.newLorebook')}
        </Button>
      </div>
    </section>
  )
}

function QuickReplies() {
  const t = useT()
  const session = useSession()
  const replies = useCollection('quickReplies')
  const id = useId()
  const [label, setLabel] = useState('')
  const [text, setText] = useState('')
  if (session === null) return null
  const collection = session.workspace.collection('quickReplies')
  const sorted = [...replies].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h2 id={id} className={styles.sectionTitle}>
        {t('roleplay.quickTitle')}
      </h2>
      <p className={styles.muted}>{t('roleplay.quickHint')}</p>
      {sorted.length === 0 ? (
        <p className={styles.muted}>{t('roleplay.quickEmpty')}</p>
      ) : (
        <ListGroup title={t('roleplay.quickTitle')} hideTitle>
          {sorted.map((r) => (
            <ListRow
              key={r.id}
              title={r.label}
              subtitle={r.text}
              trailing={
                <IconButton
                  icon={Trash2}
                  label={t('roleplay.quickRemove', { label: r.label })}
                  onClick={() => collection.trash(r.id)}
                />
              }
            />
          ))}
        </ListGroup>
      )}
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault()
          if (label.trim() === '' || text.trim() === '') return
          collection.create({ label: label.trim(), text: text.trim(), order: keyAfter(sorted.at(-1)?.order ?? null) })
          setLabel('')
          setText('')
        }}
      >
        <Field
          label={t('roleplay.quickLabel')}
          value={label}
          maxLength={60}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Field
          label={t('roleplay.quickText')}
          value={text}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" disabled={label.trim() === '' || text.trim() === ''}>
          {t('roleplay.quickAdd')}
        </Button>
      </form>
    </section>
  )
}

function RuleRow({ rule }: { rule: Entity<RegexRule> }) {
  const t = useT()
  const session = useSession()
  if (session === null) return null
  const collection = session.workspace.collection('regexRules')
  return (
    <li className={styles.card}>
      <div className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{rule.name}</h3>
        <IconButton
          icon={Trash2}
          label={t('roleplay.regexRemove', { name: rule.name })}
          onClick={() => collection.trash(rule.id)}
        />
      </div>
      <p className={styles.mono}>
        /{rule.find}/{rule.flags} → {rule.replace}
      </p>
      <p className={styles.muted}>
        {rule.placement === 'input' ? t('roleplay.regexOnInput') : t('roleplay.regexOnDisplay')}
      </p>
      <SwitchRow
        label={t('roleplay.regexEnabled', { name: rule.name })}
        checked={rule.enabled}
        onChange={(enabled) => collection.update(rule.id, { enabled })}
      />
    </li>
  )
}

function RegexRules() {
  const t = useT()
  const session = useSession()
  const rules = useCollection('regexRules')
  const id = useId()
  const [form, setForm] = useState({ name: '', find: '', flags: 'g', replace: '', sample: '' })
  const [placement, setPlacement] = useState<RegexRule['placement']>('display')
  if (session === null) return null
  const draft: RegexRule = { ...form, placement, enabled: true }
  const problem = form.find === '' ? null : ruleProblem(draft)
  const problemText =
    problem === 'flags'
      ? t('roleplay.regexProblemFlags')
      : problem === 'pattern'
        ? t('roleplay.regexProblemPattern')
        : problem === 'empty'
          ? t('roleplay.regexProblemEmpty')
          : undefined
  const result = form.sample === '' || problem !== null ? null : applyRules(form.sample, [draft], placement)
  const set = (field: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [field]: e.target.value }))
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h2 id={id} className={styles.sectionTitle}>
        {t('roleplay.regexTitle')}
      </h2>
      <p className={styles.muted}>{t('roleplay.regexHint')}</p>
      {rules.length === 0 ? (
        <p className={styles.muted}>{t('roleplay.regexEmpty')}</p>
      ) : (
        <ul className={styles.list}>
          {rules.map((r) => (
            <RuleRow key={r.id} rule={r} />
          ))}
        </ul>
      )}
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault()
          if (form.name.trim() === '' || ruleProblem(draft) !== null) return
          session.workspace.collection('regexRules').create({
            name: form.name.trim(),
            find: form.find,
            flags: form.flags,
            replace: form.replace,
            placement,
            enabled: true,
          })
          setForm({ name: '', find: '', flags: 'g', replace: '', sample: '' })
        }}
      >
        <Field label={t('roleplay.regexName')} value={form.name} maxLength={100} onChange={set('name')} />
        <Field
          label={t('roleplay.regexFind')}
          value={form.find}
          maxLength={1000}
          spellCheck={false}
          autoComplete="off"
          onChange={set('find')}
          {...(problemText === undefined ? {} : { error: problemText })}
        />
        <Field
          label={t('roleplay.regexFlags')}
          hint={t('roleplay.regexFlagsHint')}
          value={form.flags}
          maxLength={5}
          spellCheck={false}
          autoComplete="off"
          onChange={set('flags')}
        />
        <Field
          label={t('roleplay.regexReplace')}
          hint={t('roleplay.regexReplaceHint')}
          value={form.replace}
          maxLength={4000}
          spellCheck={false}
          onChange={set('replace')}
        />
        <Segmented
          label={t('roleplay.regexPlacement')}
          options={[
            { value: 'display', label: t('roleplay.regexDisplay') },
            { value: 'input', label: t('roleplay.regexInput') },
          ]}
          value={placement}
          onChange={setPlacement}
        />
        <Field label={t('roleplay.regexTest')} value={form.sample} onChange={set('sample')} />
        {result !== null && (
          <p className={styles.preview} aria-live="polite">
            {t('roleplay.regexResult', { result })}
          </p>
        )}
        <Button type="submit" disabled={form.name.trim() === '' || form.find === '' || problem !== null}>
          {t('roleplay.regexAdd')}
        </Button>
      </form>
    </section>
  )
}
