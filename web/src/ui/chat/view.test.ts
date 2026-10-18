import { describe, expect, test } from 'bun:test'
import type { Conversation, Message } from '../../core/contracts/workspace.ts'
import {
  costOf,
  groupConversations,
  groupOf,
  injectedTextOf,
  matches,
  queryWords,
  reasoningOf,
  textOf,
  visibleMessages,
  WINDOW,
  windowOf,
} from './view.ts'

const message = (id: string, extra: Partial<Message> = {}): Message => ({
  id,
  conv: 'c',
  parent: null,
  role: 'user',
  parts: [],
  model: null,
  createdAt: 1,
  status: 'done',
  ...extra,
})

const conversation = (id: string, extra: Partial<Conversation> = {}): Conversation => ({
  id,
  createdAt: 0,
  updatedAt: 0,
  title: '',
  folder: null,
  persona: null,
  model: null,
  effort: null,
  leaf: null,
  system: '',
  tools: [],
  pinned: false,
  archived: false,
  ...extra,
})

describe('thread view', () => {
  test('hides deleted messages', () => {
    const path = [message('a'), message('b', { deletedAt: 5 }), message('c')]
    expect(visibleMessages(path).map((m) => m.id)).toEqual(['a', 'c'])
  })

  test('copy takes the text parts only, reasoning is apart', () => {
    const parts = [
      { type: 'reasoning', text: 'thinking' },
      { type: 'text', text: 'First' },
      { type: 'text', text: '  ' },
      { type: 'text', text: 'Second' },
    ] as const
    expect(textOf(parts)).toBe('First\n\nSecond')
    expect(reasoningOf(parts)).toBe('thinking')
  })

  test('injected roleplay context is not part of the text shown or copied', () => {
    const parts = [
      { type: 'text', text: 'Is the lighthouse open?' },
      { type: 'text', text: '<lore>\nThe lamp is lit.\n</lore>', injected: 'lorebook' },
      { type: 'text', text: '<authors-note>\nBe brief.\n</authors-note>', injected: 'authors-note' },
    ] as unknown as Message['parts']
    expect(textOf(parts)).toBe('Is the lighthouse open?')
    expect(injectedTextOf(parts)).toBe(
      '<lore>\nThe lamp is lit.\n</lore>\n\n<authors-note>\nBe brief.\n</authors-note>',
    )
  })

  test('cost prices fresh input, cache reads and writes and output apart', () => {
    const price = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
    expect(costOf({ input: 1_000_000, output: 1_000_000 }, price)).toBeCloseTo(18)
    expect(costOf({ input: 1_000_000, cacheRead: 600_000, cacheWrite: 400_000, output: 0 }, price)).toBeCloseTo(
      0.18 + 1.5,
    )
    expect(costOf({ input: 10 }, null)).toBeNull()
    expect(costOf(undefined, price)).toBeNull()
    expect(costOf({}, price)).toBeNull()
  })

  test('long threads render a window of the latest messages', () => {
    const many = Array.from({ length: WINDOW * 2 + 5 }, (_, i) => i)
    expect(windowOf(many, 0)).toEqual({ shown: many.slice(WINDOW + 5), hidden: WINDOW + 5 })
    expect(windowOf(many, 1).hidden).toBe(5)
    expect(windowOf(many, 9).hidden).toBe(0)
    expect(windowOf([1, 2], 0)).toEqual({ shown: [1, 2], hidden: 0 })
  })
})

describe('conversation list', () => {
  test('search ignores case and accents and needs every word', () => {
    expect(matches('Résumé de la réunion', queryWords('resume REUNION'))).toBe(true)
    expect(matches('Résumé', queryWords('resume budget'))).toBe(false)
    expect(matches('anything', queryWords('   '))).toBe(true)
  })

  test('sections by last change in local time, pinned first', () => {
    const now = new Date(2026, 9, 17, 12).getTime()
    expect(groupOf({ pinned: true, updatedAt: 0 }, now)).toBe('pinned')
    expect(groupOf({ pinned: false, updatedAt: new Date(2026, 9, 17, 1).getTime() }, now)).toBe('today')
    expect(groupOf({ pinned: false, updatedAt: new Date(2026, 9, 16, 23).getTime() }, now)).toBe('yesterday')
    expect(groupOf({ pinned: false, updatedAt: new Date(2026, 9, 12).getTime() }, now)).toBe('week')
    expect(groupOf({ pinned: false, updatedAt: new Date(2026, 8, 30).getTime() }, now)).toBe('month')
    expect(groupOf({ pinned: false, updatedAt: new Date(2025, 0, 1).getTime() }, now)).toBe('older')
    const groups = groupConversations(
      [
        conversation('p', { pinned: true }),
        conversation('a', { updatedAt: now }),
        conversation('b', { updatedAt: now }),
      ],
      now,
    )
    expect(groups.map((g) => [g.key, g.items.map((c) => c.id)])).toEqual([
      ['pinned', ['p']],
      ['today', ['a', 'b']],
    ])
  })
})
