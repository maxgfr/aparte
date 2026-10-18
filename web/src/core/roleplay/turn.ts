/*
 * What roleplay adds to a user turn, computed once when the message is sent and committed with it: the `input` regex
 * rules rewrite the typed text, then the triggered lorebook entries and the Author's Note are appended as text parts
 * marked `injected` (contracts/extras.ts). The view hides those parts; the request sends them as the text they are.
 *
 * Invariants:
 * - Nothing is injected into an earlier message, and nothing is removed later: the stored path stays the request, so
 *   a provider that signed the conversation so far still sees the same prefix (spec/DATA-MODEL.md section 5, rule 4).
 * - Pure and deterministic: the same parts, path, options and books always give the same parts.
 */

import type { ChatOptions, Injected, Lorebook, Persona, RegexRule } from '../contracts/extras.ts'
import type { Message, Part } from '../contracts/workspace.ts'
import { DEFAULT_USER, substituteMacros } from './cards.ts'
import { triggeredEntries } from './lorebook.ts'
import { applyRules } from './regex.ts'

/** A text part a feature added to a user message. */
export function injectedPart(kind: Injected, text: string): Part {
  return { type: 'text', text, injected: kind } as Part
}

/** What injected the part, or null for a part the user wrote. */
export function injectedOf(part: Part): Injected | null {
  const v = (part as { injected?: unknown }).injected
  return v === 'lorebook' || v === 'authors-note' || v === 'character' ? v : null
}

/** The text the user wrote in `parts`: injected parts left out. */
export function ownText(parts: readonly Part[]): string {
  const out: string[] = []
  for (const p of parts) if (p.type === 'text' && injectedOf(p) === null && p.text.trim() !== '') out.push(p.text)
  return out.join('\n\n')
}

export interface TurnInput {
  /** The parts the user is sending. */
  readonly parts: readonly Part[]
  /** The stored path the message will be a child of (oldest first). */
  readonly path: readonly Message[]
  readonly options?: ChatOptions | null
  /** The books the conversation uses, in the options' order. */
  readonly lorebooks?: readonly { readonly id: string; readonly book: Lorebook }[]
  readonly persona?: Pick<Persona, 'name'> | null
  readonly rules?: readonly RegexRule[]
}

/** The user turns of a path that count toward the Author's Note frequency. */
function userTurns(path: readonly Message[]): number {
  return path.filter((m) => m.role === 'user' && m.deletedAt === undefined).length
}

/**
 * The parts to commit for the turn. The Author's Note goes into the first turn and then every `noteEvery`-th one
 * (turns counted on the path, the new one included).
 */
export function prepareTurn(input: TurnInput): Part[] {
  const char = input.persona?.name.trim() || ''
  const user = input.options?.userName?.trim() || DEFAULT_USER
  const rules = input.rules ?? []
  const out: Part[] = input.parts.map((p) =>
    p.type === 'text' && injectedOf(p) === null
      ? { ...p, text: applyRules(p.text, rules, 'input', { char, user }) }
      : p,
  )
  const typed = ownText(out)

  const scanned: string[] = []
  for (const m of input.path) {
    if (m.deletedAt !== undefined || (m.role !== 'user' && m.role !== 'assistant')) continue
    const t = ownText(m.parts)
    if (t !== '') scanned.push(t)
  }
  scanned.push(typed)
  const entries = triggeredEntries(input.lorebooks ?? [], scanned)
  if (entries.length > 0) {
    const body = entries.map((e) => substituteMacros(e.entry.content.trim(), char || 'Character', user)).join('\n\n')
    out.push(injectedPart('lorebook', `<lore>\n${body}\n</lore>`))
  }

  const note = input.options?.note?.trim() ?? ''
  if (note !== '') {
    const every = Math.max(1, Math.floor(input.options?.noteEvery ?? 1))
    if (userTurns(input.path) % every === 0) {
      out.push(
        injectedPart(
          'authors-note',
          `<authors-note>\n${substituteMacros(note, char || 'Character', user)}\n</authors-note>`,
        ),
      )
    }
  }
  return out
}
