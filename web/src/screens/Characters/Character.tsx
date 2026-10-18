import { Download } from 'lucide-react'
import { useId, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { useSession } from '../../app/chat.tsx'
import { paths } from '../../app/routes.ts'
import { useToast } from '../../app/toast.tsx'
import type { Persona } from '../../core/contracts/extras.ts'
import type { Entity } from '../../core/contracts/workspace.ts'
import { systemPromptOf, toCardV2 } from '../../core/roleplay/cards.ts'
import { useT } from '../../i18n/react.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { Avatar, downloadText } from '../../ui/roleplay/Avatar.tsx'
import { useCollection, useEntity } from '../../ui/roleplay/hooks.ts'
import styles from '../../ui/roleplay/Roleplay.module.css'
import { Screen } from '../../ui/shell/Screen.tsx'

/** One character: its card fields, the lorebook it brings, the system prompt it gives, export and delete. */
export default function CharacterScreen({ params }: { params?: { id?: string } }) {
  const t = useT()
  const id = params?.id === undefined ? null : decodeURIComponent(params.id)
  const persona = useEntity('personas', id)
  if (persona === undefined || persona.deletedAt !== undefined) {
    return (
      <Screen title={t('roleplay.characterTitle')} back={paths.characters}>
        <EmptyState
          title={t('roleplay.characterMissing')}
          action={
            <Link href={paths.characters} className={buttonClass({ variant: 'primary' })}>
              {t('roleplay.charactersTitle')}
            </Link>
          }
        />
      </Screen>
    )
  }
  return <Editor key={persona.id} persona={persona} />
}

type Form = Required<
  Pick<Persona, 'name' | 'systemPrompt' | 'description' | 'personality' | 'scenario' | 'firstMessage' | 'examples'>
> & { lorebook: string }

function TextArea({
  label,
  hint,
  value,
  rows = 4,
  onChange,
}: {
  label: string
  hint?: string
  value: string
  rows?: number
  onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      <textarea
        id={id}
        className={styles.textarea}
        rows={rows}
        value={value}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && (
        <p id={`${id}-hint`} className={styles.muted}>
          {hint}
        </p>
      )}
    </div>
  )
}

function Editor({ persona }: { persona: Entity<Persona> }) {
  const t = useT()
  const toast = useToast()
  const session = useSession()
  const [, navigate] = useLocation()
  const books = useCollection('lorebooks')
  const selectId = useId()
  const [form, setForm] = useState<Form>({
    name: persona.name,
    systemPrompt: persona.systemPrompt,
    description: persona.description ?? '',
    personality: persona.personality ?? '',
    scenario: persona.scenario ?? '',
    firstMessage: persona.firstMessage ?? '',
    examples: persona.examples ?? '',
    lorebook: persona.lorebook ?? '',
  })
  if (session === null) return null
  const ws = session.workspace
  const field = (name: keyof Form) => (value: string) => setForm((f) => ({ ...f, [name]: value }))
  const optional = (value: string) => (value.trim() === '' ? undefined : value.trim())

  const save = () => {
    ws.collection('personas').update(persona.id, {
      name: form.name.trim() === '' ? persona.name : form.name.trim(),
      systemPrompt: form.systemPrompt.trim(),
      description: optional(form.description),
      personality: optional(form.personality),
      scenario: optional(form.scenario),
      firstMessage: optional(form.firstMessage),
      examples: optional(form.examples),
      lorebook: form.lorebook === '' ? undefined : form.lorebook,
    })
    toast(t('roleplay.characterSaved'))
  }

  const exportCard = () => {
    const book = persona.lorebook === undefined ? null : (ws.collection('lorebooks').get(persona.lorebook) ?? null)
    const card = toCardV2(persona, book)
    const name = `${persona.name.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'character'}.json`
    downloadText(JSON.stringify(card, null, 2), name, 'application/json')
  }

  return (
    <Screen title={persona.name} back={paths.characters}>
      <div className={styles.stack}>
        <div className={styles.row}>
          <Avatar blob={persona.avatar} alt={t('roleplay.avatarOf', { name: persona.name })} />
          {persona.creator && (
            <p className={styles.muted}>{t('roleplay.characterCreator', { creator: persona.creator })}</p>
          )}
        </div>
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <Field
            label={t('roleplay.characterName')}
            value={form.name}
            maxLength={200}
            onChange={(e) => field('name')(e.target.value)}
          />
          <TextArea
            label={t('roleplay.characterDescription')}
            value={form.description}
            onChange={field('description')}
          />
          <TextArea
            label={t('roleplay.characterPersonality')}
            value={form.personality}
            rows={3}
            onChange={field('personality')}
          />
          <TextArea
            label={t('roleplay.characterScenario')}
            value={form.scenario}
            rows={3}
            onChange={field('scenario')}
          />
          <TextArea
            label={t('roleplay.characterFirstMessage')}
            hint={t('roleplay.characterFirstMessageHint')}
            value={form.firstMessage}
            rows={3}
            onChange={field('firstMessage')}
          />
          <TextArea label={t('roleplay.characterExamples')} value={form.examples} onChange={field('examples')} />
          <TextArea
            label={t('roleplay.characterSystem')}
            hint={t('roleplay.characterSystemHint')}
            value={form.systemPrompt}
            rows={3}
            onChange={field('systemPrompt')}
          />
          <div className={styles.field}>
            <label htmlFor={selectId} className={styles.label}>
              {t('roleplay.characterLorebook')}
            </label>
            <select
              id={selectId}
              className={styles.select}
              value={form.lorebook}
              onChange={(e) => field('lorebook')(e.target.value)}
            >
              <option value="">{t('roleplay.characterNoLorebook')}</option>
              {books.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <Button type="submit" variant="primary">
            {t('roleplay.characterSave')}
          </Button>
        </form>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>{t('roleplay.characterPreview')}</h2>
          <p className={styles.preview}>{systemPromptOf({ ...form })}</p>
        </section>
        <div className={styles.row}>
          <Button icon={<Download size={18} strokeWidth={1.75} aria-hidden="true" />} onClick={exportCard}>
            {t('roleplay.characterExport')}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              ws.collection('personas').trash(persona.id)
              toast(t('roleplay.characterDeleted'))
              navigate(paths.characters, { replace: true })
            }}
          >
            {t('roleplay.characterDelete')}
          </Button>
        </div>
      </div>
    </Screen>
  )
}
