/*
 * Property tests of the message tree (spec/DATA-MODEL.md section 4.1): for any sequence of commits, branch switches,
 * guarded leaf moves and deletions, every path runs from a root to its leaf through parent links, siblings are the
 * children of one parent in creation order, `descend` reaches a leaf below the chosen message, and only `setLeaf`
 * moves the leaf.
 */
import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import type { Id, Message, Thread } from '../contracts/workspace.ts'
import { msg, newId, setup } from './testkit.ts'

type Op =
  | { readonly kind: 'commit'; readonly parent: number; readonly root: boolean; readonly tick: number }
  | { readonly kind: 'leaf'; readonly pick: number; readonly empty: boolean }
  | { readonly kind: 'guarded'; readonly pick: number; readonly guard: number }
  | { readonly kind: 'delete'; readonly pick: number }
  | { readonly kind: 'descend'; readonly pick: number }

const op: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('commit' as const),
      parent: fc.nat(),
      root: fc.boolean(),
      tick: fc.integer({ min: 0, max: 2 }),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('leaf' as const), pick: fc.nat(), empty: fc.boolean() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('guarded' as const), pick: fc.nat(), guard: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('delete' as const), pick: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('descend' as const), pick: fc.nat() }) },
)

function checkTree(thread: Thread, leaf: Id | null, ids: readonly Id[]): void {
  const all = thread.all()
  expect(all.map((m) => m.id).sort()).toEqual([...ids].sort())
  for (let i = 1; i < all.length; i++) {
    const [a, b] = [all[i - 1] as Message, all[i] as Message]
    expect(a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id)).toBe(true)
  }
  const reached = new Set<Id>()
  for (const parent of [null, ...ids]) {
    const kids = thread.children(parent)
    expect(kids).toEqual(all.filter((m) => m.parent === parent))
    for (const kid of kids) reached.add(kid.id)
  }
  expect(reached.size).toBe(ids.length)
  for (const m of all) {
    const path = thread.path(m.id)
    expect(path.at(-1)).toBe(m)
    expect(path[0]?.parent).toBeNull()
    for (let i = 1; i < path.length; i++) expect(path[i]?.parent).toBe((path[i - 1] as Message).id)
    const { messages, index } = thread.siblings(m.id)
    expect(messages[index]).toBe(m)
    expect(messages).toBe(thread.children(m.parent))
    const end = thread.descend(m.id)
    expect(thread.children(end)).toEqual([])
    expect(thread.path(end).map((x) => x.id)).toContain(m.id)
    // Each step down follows the most recently created child.
    const below = thread.path(end).map((x) => x.id)
    for (let i = below.indexOf(m.id); i < below.length - 1; i++) {
      expect(thread.children(below[i] as Id).at(-1)?.id).toBe(below[i + 1] as Id)
    }
  }
  const path = thread.path()
  if (leaf === null) expect(path).toEqual([])
  else expect(path.at(-1)?.id).toBe(leaf)
}

describe('message tree properties', () => {
  test('paths, siblings, descend and the leaf stay consistent', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 30 }), async (ops) => {
        const { ws, clock } = await setup()
        const conv = ws.conversations.create()
        const thread = await ws.thread(conv)
        const ids: Id[] = []
        let leaf: Id | null = null
        for (const o of ops) {
          const pick = (n: number): Id | undefined => (ids.length === 0 ? undefined : ids[n % ids.length])
          switch (o.kind) {
            case 'commit': {
              clock.tick(o.tick)
              const id = newId()
              const parent = o.root ? null : (pick(o.parent) ?? null)
              thread.commit(msg(id, parent, ids.length % 2 ? 'assistant' : 'user', `m${ids.length}`))
              ids.push(id)
              // Committing never moves the leaf.
              expect(ws.conversations.get(conv)?.leaf ?? null).toBe(leaf)
              break
            }
            case 'leaf': {
              const target = o.empty ? null : (pick(o.pick) ?? null)
              expect(thread.setLeaf(target)).toBe(true)
              leaf = target
              break
            }
            case 'guarded': {
              const target = pick(o.pick)
              if (target === undefined) break
              const guard = o.guard % 2 === 0 ? leaf : (pick(o.guard) ?? null)
              const moved = thread.setLeaf(target, { ifLeaf: guard })
              expect(moved).toBe(guard === leaf)
              if (moved) leaf = target
              break
            }
            case 'delete': {
              const target = pick(o.pick)
              if (target === undefined) break
              thread.delete(target)
              const first = thread.get(target)?.deletedAt
              clock.tick()
              thread.delete(target)
              // Deletion is final and set once.
              expect(thread.get(target)?.deletedAt).toBe(first as number)
              break
            }
            case 'descend': {
              const target = pick(o.pick)
              if (target === undefined) break
              leaf = thread.descend(target)
              thread.setLeaf(leaf)
              break
            }
          }
          expect(ws.conversations.get(conv)?.leaf ?? null).toBe(leaf)
        }
        checkTree(thread, leaf, ids)
        ws.close()
      }),
      { numRuns: 40 },
    )
  })

  test('a message is never rewritten: a second commit with its id is refused and changes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), async (first, second) => {
        const { ws } = await setup()
        const thread = await ws.thread(ws.conversations.create())
        const id = newId()
        thread.commit(msg(id, null, 'user', first))
        const before = thread.get(id)
        expect(() => thread.commit(msg(id, null, 'user', second))).toThrow()
        expect(thread.get(id)).toBe(before as Message)
        expect(thread.get(id)?.parts).toEqual([{ type: 'text', text: first }])
        ws.close()
      }),
      { numRuns: 20 },
    )
  })
})
