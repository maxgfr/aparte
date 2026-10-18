/*
 * Citations of knowledge passages in an answer. The model cites a passage as `[[id]]` (or several, `[[id, id]]`); a
 * citation is kept only when the passage it names was given to the model on that branch, before the answer: in the
 * `knowledge` part of a user message or in a `search_knowledge` result. Kept citations become `[n]` in the text, n
 * the order of first citation; any other citation is removed, never shown as a source.
 */
import type { KnowledgePassage, Message, Part } from '../contracts/workspace.ts'

export const SEARCH_KNOWLEDGE = 'search_knowledge'

/** One `[[...]]` group of passage ids. */
const GROUP = /( *)\[\[\s*([a-z2-7]{6}-\d{1,6}(?:\s*[,;]\s*[a-z2-7]{6}-\d{1,6})*)\s*\]\]/gi

/** A passage as `search_knowledge` returns it in its result's `details`. */
function passageOf(value: unknown): KnowledgePassage | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const p = value as Record<string, unknown>
  if (
    typeof p.id !== 'string' ||
    typeof p.base !== 'string' ||
    typeof p.document !== 'string' ||
    typeof p.blob !== 'string' ||
    typeof p.text !== 'string'
  ) {
    return null
  }
  return {
    id: p.id,
    base: p.base,
    document: p.document,
    blob: p.blob,
    text: p.text,
    ...(typeof p.page === 'number' ? { page: p.page } : {}),
    ...(typeof p.heading === 'string' ? { heading: p.heading } : {}),
  }
}

/** The passages one message's parts hand to the model (refs must already be resolved). */
export function passagesOfParts(role: Message['role'], parts: readonly Part[]): KnowledgePassage[] {
  const out: KnowledgePassage[] = []
  for (const part of parts) {
    if (role === 'user' && part.type === 'knowledge') {
      for (const p of part.passages) {
        const passage = passageOf(p)
        if (passage) out.push(passage)
      }
    } else if (role === 'tool' && part.type === 'tool-result' && part.name === SEARCH_KNOWLEDGE && !part.isError) {
      const details = part.details as { passages?: unknown } | undefined
      if (Array.isArray(details?.passages)) {
        for (const p of details.passages) {
          const passage = passageOf(p)
          if (passage) out.push(passage)
        }
      }
    }
  }
  return out
}

/** Every passage given to the model on `path` (oldest first), by id; deleted messages give none. */
export function passagesOfPath(
  path: readonly Pick<Message, 'role' | 'parts' | 'deletedAt'>[],
): Map<string, KnowledgePassage> {
  const out = new Map<string, KnowledgePassage>()
  for (const m of path) {
    if (m.deletedAt !== undefined) continue
    for (const p of passagesOfParts(m.role, m.parts)) if (!out.has(p.id)) out.set(p.id, p)
  }
  return out
}

export interface Cited {
  /** The text with each kept citation as `[n]` and every other one removed. */
  readonly text: string
  /** The passages cited, in the order of `n`. */
  readonly sources: readonly KnowledgePassage[]
}

/** Validates and numbers the citations of an answer against the passages it was given. */
export function citeText(text: string, known: ReadonlyMap<string, KnowledgePassage>): Cited {
  const sources: KnowledgePassage[] = []
  const number = new Map<string, number>()
  const out = text.replace(GROUP, (_m, space: string, ids: string) => {
    const marks: string[] = []
    for (const raw of ids.split(/[,;]/)) {
      const id = raw.trim().toLowerCase()
      const passage = known.get(id)
      if (passage === undefined) continue
      let n = number.get(id)
      if (n === undefined) {
        sources.push(passage)
        n = sources.length
        number.set(id, n)
      }
      const mark = `[${n}]`
      if (!marks.includes(mark)) marks.push(mark)
    }
    // A removed citation takes the spaces before it along, so no gap is left before the punctuation.
    return marks.length === 0 ? '' : `${space}${marks.join('')}`
  })
  return { text: out, sources }
}
