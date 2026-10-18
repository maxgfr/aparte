/* What a roleplay turn commits: input rules, lorebook and Author's Note parts, only on the new turn, deterministic. */
import { describe, expect, test } from 'bun:test'
import type { Lorebook, RegexRule } from '../contracts/extras.ts'
import type { Message, Part } from '../contracts/workspace.ts'
import { injectedOf, ownText, prepareTurn } from './turn.ts'

const msg = (role: Message['role'], text: string, extra: Partial<Message> = {}): Message => ({
  id: `m${Math.random()}`,
  conv: 'c',
  parent: null,
  role,
  parts: [{ type: 'text', text }],
  model: null,
  createdAt: 1,
  status: 'done',
  ...extra,
})

const lore: Lorebook = {
  name: 'Coast',
  entries: [
    { triggers: ['lighthouse'], content: '{{char}} keeps the lamp lit for {{user}}.', enabled: true, order: 0 },
  ],
  scanDepth: 3,
  budget: 1000,
}
const books = [{ id: 'b1', book: lore }]
const text = (t: string): Part[] => [{ type: 'text', text: t }]

describe('prepareTurn', () => {
  test('appends the triggered lore as an injected part, macros substituted', () => {
    const parts = prepareTurn({
      parts: text('Is the lighthouse open?'),
      path: [],
      lorebooks: books,
      persona: { name: 'Mira' },
      options: { userName: 'Ana' },
    })
    expect(parts).toHaveLength(2)
    expect(injectedOf(parts[1] as Part)).toBe('lorebook')
    expect((parts[1] as { text: string }).text).toBe('<lore>\nMira keeps the lamp lit for Ana.\n</lore>')
    expect(ownText(parts)).toBe('Is the lighthouse open?')
  })

  test('scans the path too, and nothing without a trigger', () => {
    const path = [msg('user', 'Tell me of the lighthouse'), msg('assistant', 'It stands tall.')]
    expect(prepareTurn({ parts: text('And then?'), path, lorebooks: books })).toHaveLength(2)
    expect(prepareTurn({ parts: text('And then?'), path: [], lorebooks: books })).toHaveLength(1)
    // Injected text of earlier turns is not scanned again.
    const injected = msg('user', 'x', { parts: [{ type: 'text', text: 'lighthouse', injected: 'lorebook' } as Part] })
    expect(prepareTurn({ parts: text('And then?'), path: [injected], lorebooks: books })).toHaveLength(1)
  })

  test("the Author's Note goes into the first turn, then every noteEvery-th", () => {
    const options = { note: 'Keep {{char}} terse.', noteEvery: 2 }
    const persona = { name: 'Mira' }
    const at = (turns: number) =>
      prepareTurn({
        parts: text('go'),
        path: Array.from({ length: turns }, () => msg('user', 'u')),
        options,
        persona,
      })
    expect(at(0).map((p) => injectedOf(p))).toEqual([null, 'authors-note'])
    expect((at(0)[1] as { text: string }).text).toBe('<authors-note>\nKeep Mira terse.\n</authors-note>')
    expect(at(1)).toHaveLength(1)
    expect(at(2)).toHaveLength(2)
  })

  test('input rules rewrite what was typed; the result is deterministic and the path untouched', () => {
    const rules: RegexRule[] = [
      { name: 'r', find: 'colour', flags: 'gi', replace: 'color', placement: 'input', enabled: true },
      { name: 'd', find: 'color', flags: 'g', replace: 'X', placement: 'display', enabled: true },
    ]
    const path = [msg('user', 'old colour')]
    const input = { parts: text('Colour of the lighthouse'), path, rules, lorebooks: books }
    const first = prepareTurn(input)
    expect(ownText(first)).toBe('color of the lighthouse')
    expect(prepareTurn(input)).toEqual(first)
    expect(path[0]?.parts).toEqual([{ type: 'text', text: 'old colour' }])
  })
})
