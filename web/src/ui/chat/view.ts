import type { ModelCost, Usage } from '../../core/contracts/ai.ts'
import type { Conversation, Message, Part } from '../../core/contracts/workspace.ts'

/*
 * What the thread view shows of the stored data, as pure functions: which messages appear, the text a Copy takes,
 * what an answer cost, and how the conversation list is searched and grouped.
 */

/** The messages of a path the view shows: deleted ones are hidden (their branch stays). */
export function visibleMessages(path: readonly Message[]): readonly Message[] {
  return path.filter((m) => m.deletedAt === undefined)
}

/** The text parts of a message, joined by blank lines: what Copy puts on the clipboard. */
export function textOf(parts: readonly Part[]): string {
  const out: string[] = []
  for (const p of parts) if (p.type === 'text' && p.text.trim() !== '') out.push(p.text)
  return out.join('\n\n')
}

/** The reasoning parts of a message, joined: shown collapsed above the answer. */
export function reasoningOf(parts: readonly Part[]): string {
  const out: string[] = []
  for (const p of parts) if (p.type === 'reasoning' && p.text.trim() !== '') out.push(p.text)
  return out.join('\n\n')
}

export type ImagePart = Extract<Part, { type: 'image' }>

export function imagesOf(parts: readonly Part[]): readonly ImagePart[] {
  return parts.filter((p): p is ImagePart => p.type === 'image')
}

/**
 * What a response cost in US dollars from the provider's token counts and the model's prices, or null when either is
 * unknown. Cached reads and cache writes are parts of `input` (contracts/ai.ts `Usage`) and priced on their own.
 */
export function costOf(usage: Usage | undefined, cost: ModelCost | null): number | null {
  if (usage === undefined || cost === null) return null
  if (usage.input === undefined && usage.output === undefined) return null
  const input = usage.input ?? 0
  const read = usage.cacheRead ?? 0
  const write = usage.cacheWrite ?? 0
  const fresh = Math.max(0, input - read - write)
  const total =
    fresh * cost.input +
    read * (cost.cacheRead ?? cost.input) +
    write * (cost.cacheWrite ?? cost.input) +
    (usage.output ?? 0) * cost.output
  return total / 1_000_000
}

/** Lowercase words of a query, without accents, so "resume" finds "Résumé". */
export function queryWords(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean)
}

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
}

/** Whether every word of the query appears in the text (accent and case insensitive). */
export function matches(text: string, words: readonly string[]): boolean {
  if (words.length === 0) return true
  const hay = fold(text)
  return words.every((w) => hay.includes(w))
}

export type ListGroupKey = 'pinned' | 'today' | 'yesterday' | 'week' | 'month' | 'older'

/** The section of the conversation list a conversation falls in, by its last change in local time. */
export function groupOf(conv: Pick<Conversation, 'pinned' | 'updatedAt'>, now: number): ListGroupKey {
  if (conv.pinned) return 'pinned'
  const day = (t: number) => {
    const d = new Date(t)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const days = Math.round((day(now) - day(conv.updatedAt)) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return 'week'
  if (days < 30) return 'month'
  return 'older'
}

/** Conversations in sections, keeping the list's order inside each; empty sections are left out. */
export function groupConversations(
  list: readonly Conversation[],
  now: number,
): readonly { readonly key: ListGroupKey; readonly items: readonly Conversation[] }[] {
  const order: ListGroupKey[] = ['pinned', 'today', 'yesterday', 'week', 'month', 'older']
  const groups = new Map<ListGroupKey, Conversation[]>()
  for (const conv of list) {
    const key = groupOf(conv, now)
    const items = groups.get(key) ?? []
    items.push(conv)
    groups.set(key, items)
  }
  return order.filter((k) => groups.has(k)).map((key) => ({ key, items: groups.get(key) as Conversation[] }))
}

/** How many messages a long thread renders at first; earlier ones come on request. */
export const WINDOW = 60

/** The slice of `messages` shown when `extra` earlier windows were requested. */
export function windowOf<T>(
  messages: readonly T[],
  extra: number,
): { readonly shown: readonly T[]; readonly hidden: number } {
  const count = Math.min(messages.length, WINDOW * (1 + Math.max(0, extra)))
  return { shown: messages.slice(messages.length - count), hidden: messages.length - count }
}
