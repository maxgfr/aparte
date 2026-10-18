import { Drama } from 'lucide-react'
import { useId, useMemo, useState } from 'react'
import { useSession } from '../../app/chat.tsx'
import { useToast } from '../../app/toast.tsx'
import type { ChatOptions } from '../../core/contracts/extras.ts'
import type { Id, Part } from '../../core/contracts/workspace.ts'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../components/Button.tsx'
import { Field } from '../components/Field.tsx'
import { Sheet } from '../components/Sheet.tsx'
import { SwitchRow } from '../components/Switch.tsx'
import {
  characterOf,
  characterPrompt,
  prepareTurnFor,
  saveChatOptions,
  useChatOptions,
  useCollection,
} from './hooks.ts'
import styles from './Roleplay.module.css'

/*
 * The roleplay of one chat: its character, the user's name, the lorebooks it uses and the Author's Note. A new chat
 * (no conversation yet) keeps them as a draft until its first message creates the conversation; `useRoleplay` holds
 * that draft and says what the chat screen does with it.
 *
 * Choosing a character never rewrites the conversation: before the first message the character's prompt becomes the
 * system prompt; afterwards the switch is appended as a `system` message (the controller's `appendSystem`), and the
 * model takes it from that point on (spec/DATA-MODEL.md section 5, rule 1). The greeting is never sent as an
 * assistant message (no prefill).
 */

export interface Roleplay {
  readonly conversationId: Id | null
  /** The options of a new chat, before its conversation exists. */
  readonly draft: ChatOptions
  readonly setDraft: (options: ChatOptions) => void
  /** For a new chat: the system prompt its draft's character gives, or null without a character. */
  draftSystem(): string | null
  /** Right after the new chat's conversation is created: stores the draft as its options. */
  commitDraft(conversationId: Id): void
  /** The parts to send for a user message of the conversation (core/roleplay/turn.ts). */
  prepare(conversationId: Id, parts: readonly Part[], parentId?: Id | null): Promise<Part[]>
}

/** The roleplay of the chat `conversationId` (null: a new chat, whose options stay a draft). */
export function useRoleplay(conversationId: Id | null): Roleplay {
  const session = useSession()
  const [draft, setDraft] = useState<ChatOptions>({})
  return useMemo<Roleplay>(
    () => ({
      conversationId,
      draft,
      setDraft,
      draftSystem() {
        if (session === null) return null
        const persona = characterOf(session.workspace, draft.character)
        return persona === null ? null : characterPrompt(persona, draft)
      },
      commitDraft(id) {
        if (session === null || Object.keys(draft).length === 0) return
        saveChatOptions(session.workspace, id, draft)
      },
      async prepare(id, parts, parentId) {
        if (session === null) return [...parts]
        return prepareTurnFor(session.workspace, id, parts, parentId)
      },
    }),
    [session, conversationId, draft],
  )
}

/** A positive whole number from a field, or the fallback. */
const count = (value: string, fallback: number): number => {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 1000) : fallback
}

/** The composer's Roleplay control and its sheet. */
export function RoleplayButton({ roleplay, started }: { roleplay: Roleplay; started: boolean }) {
  const t = useT()
  const toast = useToast()
  const session = useSession()
  const noteId = useId()
  const nameId = useId()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const personas = useCollection('personas')
  const lorebooks = useCollection('lorebooks')
  const stored = useChatOptions(roleplay.conversationId)
  const current: ChatOptions = roleplay.conversationId === null ? roleplay.draft : (stored ?? {})
  const [form, setForm] = useState({ character: '', userName: '', lorebooks: [] as string[], note: '', every: '1' })

  // The form starts from the stored options each time the sheet opens, then is the user's while it is open.
  const openSheet = () => {
    setForm({
      character: current.character ?? '',
      userName: current.userName ?? '',
      lorebooks: [...(current.lorebooks ?? [])],
      note: current.note ?? '',
      every: String(current.noteEvery ?? 1),
    })
    setOpen(true)
  }

  const character = personas.find((p) => p.id === current.character)
  const label =
    character === undefined ? t('roleplay.chatButton') : t('roleplay.chatButtonWith', { name: character.name })

  const apply = async () => {
    if (session === null) return
    const next: ChatOptions = {
      ...(form.character === '' ? {} : { character: form.character }),
      ...(form.userName.trim() === '' ? {} : { userName: form.userName.trim() }),
      ...(form.lorebooks.length === 0 ? {} : { lorebooks: form.lorebooks }),
      ...(form.note.trim() === '' ? {} : { note: form.note.trim(), noteEvery: count(form.every, 1) }),
    }
    const id = roleplay.conversationId
    if (id === null) {
      roleplay.setDraft(next)
      setOpen(false)
      return
    }
    setBusy(true)
    try {
      const ws = session.workspace
      const before = current.character
      const persona = characterOf(ws, next.character)
      const nameChanged = (current.userName ?? '') !== (next.userName ?? '')
      if (before !== next.character || (persona !== null && nameChanged)) {
        // Before the first message this sets the system prompt; afterwards it appends the switch (no history edit).
        if (persona !== null) {
          await session.chat.appendSystem(id, characterPrompt(persona, next))
          toast(t('roleplay.chatSwitched', { name: persona.name }))
        } else if (started) {
          await session.chat.appendSystem(id, t('roleplay.chatNoCharacterSystem'))
          toast(t('roleplay.chatCharacterLeft'))
        } else {
          await session.chat.appendSystem(id, ws.settings.get('defaultSystem'))
        }
      }
      saveChatOptions(ws, id, next)
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }

  const live = personas.filter((p) => p.deletedAt === undefined)
  return (
    <>
      <button type="button" className={styles.chip} aria-label={label} title={label} onClick={openSheet}>
        <Drama size={20} strokeWidth={1.75} aria-hidden="true" />
        {character !== undefined && <span className={styles.chipName}>{character.name}</span>}
      </button>
      <Sheet open={open} title={t('roleplay.chatSheet')} onClose={() => setOpen(false)}>
        <div className={styles.form}>
          <fieldset className={styles.choices}>
            <legend>{t('roleplay.chatCharacter')}</legend>
            <label className={styles.choice}>
              <input
                type="radio"
                name={`${nameId}-character`}
                checked={form.character === ''}
                onChange={() => setForm((f) => ({ ...f, character: '' }))}
              />
              {t('roleplay.chatNoCharacter')}
            </label>
            {live.map((p) => (
              <label key={p.id} className={styles.choice}>
                <input
                  type="radio"
                  name={`${nameId}-character`}
                  checked={form.character === p.id}
                  onChange={() => setForm((f) => ({ ...f, character: p.id }))}
                />
                {p.name}
              </label>
            ))}
          </fieldset>
          <p className={styles.muted}>
            {live.length === 0 ? t('roleplay.chatNoCharacters') : t('roleplay.chatCharacterHint')}
          </p>
          <Field
            label={t('roleplay.chatUserName')}
            hint={t('roleplay.chatUserNameHint')}
            value={form.userName}
            maxLength={100}
            autoComplete="off"
            onChange={(e) => setForm((f) => ({ ...f, userName: e.target.value }))}
          />
          <div className={styles.field}>
            <span className={styles.label}>{t('roleplay.chatLorebooks')}</span>
            {lorebooks.length === 0 && <p className={styles.muted}>{t('roleplay.chatNoLorebooks')}</p>}
            {lorebooks.map((b) => (
              <SwitchRow
                key={b.id}
                label={b.name}
                checked={form.lorebooks.includes(b.id)}
                onChange={(on) =>
                  setForm((f) => ({
                    ...f,
                    lorebooks: on ? [...f.lorebooks, b.id] : f.lorebooks.filter((x) => x !== b.id),
                  }))
                }
              />
            ))}
          </div>
          <div className={styles.field}>
            <label htmlFor={noteId} className={styles.label}>
              {t('roleplay.chatNote')}
            </label>
            <textarea
              id={noteId}
              className={styles.textarea}
              rows={3}
              value={form.note}
              aria-describedby={`${noteId}-hint`}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            />
            <p id={`${noteId}-hint`} className={styles.muted}>
              {t('roleplay.chatNoteHint')}
            </p>
          </div>
          <Field
            label={t('roleplay.chatNoteEvery')}
            type="number"
            inputMode="numeric"
            min={1}
            max={1000}
            value={form.every}
            onChange={(e) => setForm((f) => ({ ...f, every: e.target.value }))}
          />
          <Button variant="primary" loading={busy} onClick={() => void apply()}>
            {t('roleplay.chatSave')}
          </Button>
        </div>
      </Sheet>
    </>
  )
}

/** One-tap messages above the composer; renders nothing without quick replies. */
export function QuickRepliesBar({ onSend, disabled }: { onSend: (text: string) => void; disabled?: boolean }) {
  const t = useT()
  const replies = useCollection('quickReplies')
  if (replies.length === 0) return null
  const sorted = [...replies].sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
  return (
    <ul className={styles.quickBar} aria-label={t('roleplay.quickBar')}>
      {sorted.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            className={styles.quickButton}
            disabled={disabled}
            title={r.text}
            onClick={() => onSend(r.text)}
          >
            {r.label}
          </button>
        </li>
      ))}
    </ul>
  )
}
