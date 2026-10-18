import { useCallback, useMemo } from 'react'
import { useCollection, useEntity, useSession } from '../../app/chat.tsx'
import type { ChatOptions, Lorebook, Persona } from '../../core/contracts/extras.ts'
import type { Entity, Id, Part, Workspace } from '../../core/contracts/workspace.ts'
import { DEFAULT_USER, systemPromptOf } from '../../core/roleplay/cards.ts'
import { applyRules } from '../../core/roleplay/regex.ts'
import { prepareTurn } from '../../core/roleplay/turn.ts'

/*
 * The roleplay collections for the interface (contracts/extras.ts): read through the workspace and re-read on its
 * change notifications, and the two things a chat asks of them: the parts a user turn commits (`prepareTurnFor`) and
 * how an answer is shown (`useDisplayText`).
 */

/** The collections read through the session (app/chat.tsx), re-exported for the roleplay screens. */
export { useCollection, useEntity }

/** The roleplay options of a conversation (none yet: undefined). */
export function useChatOptions(conversationId: Id | null): Entity<ChatOptions> | undefined {
  return useEntity('chatOptions', conversationId)
}

/** A live character by id (not trashed), or null. */
export function characterOf(ws: Workspace, id: Id | undefined): Entity<Persona> | null {
  if (id === undefined) return null
  const p = ws.collection('personas').get(id)
  return p === undefined || p.deletedAt !== undefined ? null : p
}

/** The system prompt of a character for the options' user. */
export function characterPrompt(persona: Persona, options: ChatOptions | null | undefined): string {
  return systemPromptOf(persona, options?.userName?.trim() || DEFAULT_USER)
}

/** Writes a conversation's options, creating them under its id the first time. */
export function saveChatOptions(ws: Workspace, conversationId: Id, options: ChatOptions): void {
  const collection = ws.collection('chatOptions')
  const clean: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(options)) if (v !== undefined) clean[k] = v
  if (collection.get(conversationId) === undefined) collection.create(clean as ChatOptions, { id: conversationId })
  else
    collection.update(conversationId, {
      character: options.character,
      userName: options.userName,
      lorebooks: options.lorebooks,
      note: options.note,
      noteEvery: options.noteEvery,
    })
}

/**
 * The parts a user message of `conversationId` commits: the typed parts with the `input` regex rules applied and the
 * lorebook entries and Author's Note it triggers appended (core/roleplay/turn.ts). `parentId` is what the message
 * will answer (default: the leaf). A conversation without roleplay options gets its parts back with the input rules
 * applied only.
 */
export async function prepareTurnFor(
  ws: Workspace,
  conversationId: Id,
  parts: readonly Part[],
  parentId?: Id | null,
): Promise<Part[]> {
  const options = ws.collection('chatOptions').get(conversationId) ?? null
  const rules = ws.collection('regexRules').list()
  const thread = await ws.thread(conversationId)
  const path = parentId === undefined ? thread.path() : thread.path(parentId)
  const lorebooks: { id: string; book: Lorebook }[] = []
  for (const id of options?.lorebooks ?? []) {
    const book = ws.collection('lorebooks').get(id)
    if (book !== undefined && book.deletedAt === undefined) lorebooks.push({ id, book })
  }
  return prepareTurn({
    parts,
    path,
    options,
    lorebooks,
    persona: characterOf(ws, options?.character),
    rules,
  })
}

/** `prepareTurnFor` bound to the open session. */
export function usePrepareTurn(): (
  conversationId: Id,
  parts: readonly Part[],
  parentId?: Id | null,
) => Promise<Part[]> {
  const session = useSession()
  return useCallback(
    async (conversationId, parts, parentId) =>
      session === null ? [...parts] : prepareTurnFor(session.workspace, conversationId, parts, parentId),
    [session],
  )
}

/** How an answer's text of `conversationId` is shown: the `display` regex rules applied (never stored or sent). */
export function useDisplayText(conversationId: Id | null): (text: string) => string {
  const session = useSession()
  const rules = useCollection('regexRules')
  const options = useChatOptions(conversationId)
  const personas = useCollection('personas')
  return useMemo(() => {
    const display = rules.filter((r) => r.enabled && r.placement === 'display')
    if (display.length === 0 || session === null) return (text: string) => text
    const char = personas.find((p) => p.id === options?.character)?.name ?? ''
    const user = options?.userName?.trim() || DEFAULT_USER
    return (text: string) => applyRules(text, display, 'display', { char, user })
  }, [rules, options, personas, session])
}
