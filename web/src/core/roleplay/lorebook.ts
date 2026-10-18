/*
 * Lorebooks (SillyTavern's World Info): entries injected into a user turn when one of their triggers appears in the
 * latest messages. Pure: the same texts and books always give the same entries, in the same order.
 *
 * Rules: an entry is a candidate when it is enabled and either `constant` or one of its triggers matches; with
 * `secondary` triggers, one of those must match too. Matching ignores case unless `caseSensitive`, and takes whole
 * words unless `wholeWord` is false. Candidates are sorted by `order`, then by book and entry position, and taken
 * while their contents fit the book's budget (in characters); an entry that does not fit is skipped, a smaller later
 * one may still fit. The same content from two books is injected once.
 */

import type { Lorebook, LoreEntry } from '../contracts/extras.ts'

/** One entry chosen for a turn. */
export interface TriggeredEntry {
  readonly book: string
  readonly entry: LoreEntry
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether `trigger` occurs in `haystack` under the entry's matching rules. */
export function matchesTrigger(
  haystack: string,
  trigger: string,
  entry: Pick<LoreEntry, 'caseSensitive' | 'wholeWord'>,
): boolean {
  const needle = trigger.trim()
  if (needle === '') return false
  const sensitive = entry.caseSensitive === true
  if (entry.wholeWord === false) {
    return sensitive ? haystack.includes(needle) : haystack.toLowerCase().includes(needle.toLowerCase())
  }
  // A word boundary that also holds for letters outside ASCII: no letter or digit right before or after.
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(needle)}(?![\\p{L}\\p{N}_])`, sensitive ? 'u' : 'iu')
  return pattern.test(haystack)
}

/**
 * The entries of `books` triggered by `texts` (oldest first; only the last `scanDepth` of each book are scanned),
 * within each book's budget.
 */
export function triggeredEntries(
  books: readonly { readonly id: string; readonly book: Lorebook }[],
  texts: readonly string[],
): TriggeredEntry[] {
  const candidates: { book: string; entry: LoreEntry; bookIndex: number; entryIndex: number }[] = []
  for (const [bookIndex, { id, book }] of books.entries()) {
    const depth = Math.max(1, Math.floor(book.scanDepth))
    const haystack = texts.slice(-depth).join('\n')
    for (const [entryIndex, entry] of book.entries.entries()) {
      if (!entry.enabled || entry.content.trim() === '') continue
      if (entry.constant !== true) {
        if (!entry.triggers.some((t) => matchesTrigger(haystack, t, entry))) continue
        const secondary = entry.secondary ?? []
        if (secondary.length > 0 && !secondary.some((t) => matchesTrigger(haystack, t, entry))) continue
      }
      candidates.push({ book: id, entry, bookIndex, entryIndex })
    }
  }
  candidates.sort((a, b) => a.entry.order - b.entry.order || a.bookIndex - b.bookIndex || a.entryIndex - b.entryIndex)
  const used = new Map<string, number>()
  const seen = new Set<string>()
  const out: TriggeredEntry[] = []
  for (const c of candidates) {
    const content = c.entry.content.trim()
    if (seen.has(content)) continue
    const budget = books[c.bookIndex]?.book.budget ?? 0
    const spent = used.get(c.book) ?? 0
    if (spent + content.length > budget) continue
    used.set(c.book, spent + content.length)
    seen.add(content)
    out.push({ book: c.book, entry: c.entry })
  }
  return out
}
