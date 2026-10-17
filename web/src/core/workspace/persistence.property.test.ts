/*
 * Property tests of the encrypted persistence (spec/DATA-MODEL.md section 4.5): whatever a session does, reopening
 * from the pending queue gives the same workspace, before and after compaction, and so does a fresh device that
 * receives the documents' states as remote updates (which it never queues).
 */
import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import type { DocId } from '../contracts/crypto.ts'
import type { Id, Workspace } from '../contracts/workspace.ts'
import { msg, newId, reopen, setup } from './testkit.ts'

type Op =
  | { readonly kind: 'create'; readonly title: string; readonly pinned: boolean }
  | { readonly kind: 'rename'; readonly pick: number; readonly title: string }
  | { readonly kind: 'archive'; readonly pick: number; readonly archived: boolean }
  | { readonly kind: 'message'; readonly pick: number; readonly parent: number; readonly text: string }
  | { readonly kind: 'leaf'; readonly pick: number; readonly message: number }
  | { readonly kind: 'trash'; readonly pick: number; readonly restore: boolean }
  | { readonly kind: 'purge'; readonly pick: number }
  | { readonly kind: 'deleteMessage'; readonly pick: number; readonly message: number }
  | { readonly kind: 'folder'; readonly name: string }
  | { readonly kind: 'setting'; readonly system: string }
  | { readonly kind: 'compact'; readonly pick: number }
  | { readonly kind: 'flush' }

const text = fc.string({ maxLength: 12 })
const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('create' as const), title: text, pinned: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('rename' as const), pick: fc.nat(), title: text }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant('archive' as const), pick: fc.nat(), archived: fc.boolean() }),
  },
  {
    weight: 5,
    arbitrary: fc.record({ kind: fc.constant('message' as const), pick: fc.nat(), parent: fc.nat(), text }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('leaf' as const), pick: fc.nat(), message: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('trash' as const), pick: fc.nat(), restore: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('purge' as const), pick: fc.nat() }) },
  {
    weight: 1,
    arbitrary: fc.record({ kind: fc.constant('deleteMessage' as const), pick: fc.nat(), message: fc.nat() }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('folder' as const), name: text }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('setting' as const), system: text }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('compact' as const), pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'flush' as const }) },
)

async function run(ws: Workspace, ops: readonly Op[]): Promise<Id[]> {
  const convs: Id[] = []
  const messages = new Map<Id, Id[]>()
  const pick = <T>(list: readonly T[], n: number): T | undefined =>
    list.length === 0 ? undefined : list[n % list.length]
  for (const o of ops) {
    const conv = 'pick' in o ? pick(convs, o.pick) : undefined
    const c = conv === undefined ? undefined : ws.conversations.get(conv)
    const usable = c !== undefined && c.purgedAt === undefined
    switch (o.kind) {
      case 'create':
        convs.push(ws.conversations.create({ title: o.title, pinned: o.pinned }))
        break
      case 'rename':
        if (usable && conv) ws.conversations.update(conv, { title: o.title })
        break
      case 'archive':
        if (usable && conv) ws.conversations.update(conv, { archived: o.archived })
        break
      case 'message': {
        if (!usable || !conv) break
        const thread = await ws.thread(conv)
        const list = messages.get(conv) ?? []
        const id = newId()
        thread.commit(msg(id, pick(list, o.parent) ?? null, list.length % 2 ? 'assistant' : 'user', o.text))
        messages.set(conv, [...list, id])
        break
      }
      case 'leaf': {
        const target = conv ? pick(messages.get(conv) ?? [], o.message) : undefined
        if (usable && conv && target) (await ws.thread(conv)).setLeaf(target)
        break
      }
      case 'deleteMessage': {
        const target = conv ? pick(messages.get(conv) ?? [], o.message) : undefined
        if (usable && conv && target) (await ws.thread(conv)).delete(target)
        break
      }
      case 'trash':
        if (usable && conv) {
          if (o.restore && c.deletedAt !== undefined) ws.conversations.restore(conv)
          else ws.conversations.trash(conv)
        }
        break
      case 'purge':
        if (usable && conv && c.deletedAt !== undefined) {
          await ws.conversations.purge(conv)
          messages.delete(conv)
        }
        break
      case 'folder':
        ws.folders.create({ name: o.name })
        break
      case 'setting':
        ws.settings.set('defaultSystem', o.system)
        break
      case 'compact': {
        const doc: DocId = conv ? await ws.conversations.shardOf(conv) : 'index'
        await ws.compact(doc)
        break
      }
      case 'flush':
        await ws.flush()
        break
    }
  }
  return convs
}

async function snapshot(ws: Workspace, convs: readonly Id[]) {
  const out: unknown[] = [
    ws.conversations.list(),
    ws.conversations.list({ archived: true }),
    ws.conversations.list({ trashed: true }),
    ws.folders.list(),
    ws.settings.get('defaultSystem'),
  ]
  for (const id of convs) {
    const c = ws.conversations.get(id)
    out.push(c)
    if (c && c.purgedAt === undefined) {
      const thread = await ws.thread(id)
      out.push(thread.all(), thread.path())
    }
  }
  return out
}

describe('persistence properties', () => {
  test('reopening from the queue, compacted or not, and replaying states remotely give the same workspace', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 25 }), async (ops) => {
        const a = await setup()
        const convs = await run(a.ws, ops)
        await a.ws.flush()
        const expected = await snapshot(a.ws, convs)

        a.ws.close()
        const again = await reopen(a.store, a.clock)
        expect(await snapshot(again, convs)).toEqual(expected)

        const docs: DocId[] = ['index', ...new Set(await Promise.all(convs.map((c) => again.conversations.shardOf(c))))]
        for (const doc of docs) await again.compact(doc)
        for (const doc of docs) expect((await a.store.pending.list(doc)).length).toBeLessThanOrEqual(1)
        again.close()
        const compacted = await reopen(a.store, a.clock)
        expect(await snapshot(compacted, convs)).toEqual(expected)

        const b = await setup()
        for (const doc of docs) await b.ws.applyRemote(doc, await compacted.state(doc))
        expect(await snapshot(b.ws, convs)).toEqual(expected)
        await b.ws.flush()
        for (const doc of docs) expect(await b.store.pending.list(doc)).toEqual([])
        compacted.close()
        b.ws.close()
      }),
      { numRuns: 15 },
    )
  })
})
