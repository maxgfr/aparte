/* Lorebook matching: case, whole words, secondary triggers, constant entries, scan depth, budget and order. */
import { describe, expect, test } from 'bun:test'
import type { Lorebook, LoreEntry } from '../contracts/extras.ts'
import { matchesTrigger, triggeredEntries } from './lorebook.ts'

const entry = (content: string, triggers: string[], extra: Partial<LoreEntry> = {}): LoreEntry => ({
  triggers,
  content,
  enabled: true,
  order: 0,
  ...extra,
})
const book = (entries: LoreEntry[], extra: Partial<Lorebook> = {}): Lorebook => ({
  name: 'b',
  entries,
  scanDepth: 4,
  budget: 10_000,
  ...extra,
})
const contents = (books: { id: string; book: Lorebook }[], texts: string[]) =>
  triggeredEntries(books, texts).map((e) => e.entry.content)

describe('lorebook', () => {
  test('whole words, case-insensitive by default', () => {
    expect(matchesTrigger('The Dragon sleeps', 'dragon', {})).toBe(true)
    expect(matchesTrigger('dragonfly', 'dragon', {})).toBe(false)
    expect(matchesTrigger('dragonfly', 'dragon', { wholeWord: false })).toBe(true)
    expect(matchesTrigger('The Dragon', 'dragon', { caseSensitive: true })).toBe(false)
    expect(matchesTrigger('Un éléphant', 'éléphant', {})).toBe(true)
    expect(matchesTrigger('anything', '  ', {})).toBe(false)
    expect(matchesTrigger('a (b) c', '(b)', {})).toBe(true)
  })

  test('secondary triggers, constant and disabled entries', () => {
    const b = book([
      entry('storm lore', ['storm'], { secondary: ['night'] }),
      entry('always', [], { constant: true }),
      entry('off', ['storm'], { enabled: false }),
    ])
    expect(contents([{ id: 'b', book: b }], ['A storm today'])).toEqual(['always'])
    expect(contents([{ id: 'b', book: b }], ['A storm tonight', 'at night'])).toEqual(['storm lore', 'always'])
  })

  test('only the last scanDepth texts are scanned', () => {
    const b = book([entry('harbour lore', ['harbour'])], { scanDepth: 2 })
    expect(contents([{ id: 'b', book: b }], ['the harbour', 'x', 'y'])).toEqual([])
    expect(contents([{ id: 'b', book: b }], ['the harbour', 'y'])).toEqual(['harbour lore'])
  })

  test('order, budget and duplicates across books', () => {
    const a = book(
      [
        entry('second', ['go'], { order: 5 }),
        entry('first', ['go'], { order: 1 }),
        entry('x'.repeat(50), ['go'], { order: 2 }),
      ],
      { budget: 20 },
    )
    const b = book([entry('first', ['go'], { order: 0 }), entry('other', ['go'], { order: 3 })])
    expect(
      contents(
        [
          { id: 'a', book: a },
          { id: 'b', book: b },
        ],
        ['go'],
      ),
    ).toEqual(['first', 'other', 'second'])
    expect(
      triggeredEntries(
        [
          { id: 'a', book: a },
          { id: 'b', book: b },
        ],
        ['go'],
      )[0]?.book,
    ).toBe('b')
  })
})
