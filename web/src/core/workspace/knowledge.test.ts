/*
 * Knowledge bases in the workspace index (spec/DATA-MODEL.md section 3) and their attachment to conversations.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { InvalidInputError, InvalidStateError } from '../contracts/crypto.ts'
import type { KnowledgeDocument } from '../contracts/workspace.ts'
import { type Ctx, msg, newId, reopen, setup } from './testkit.ts'

let ctx: Ctx | null = null
afterEach(() => {
  ctx?.ws.close()
  ctx?.db.close()
  ctx = null
})

const blob = (c: string) => c.repeat(26)
const doc = (c: string, extra: Partial<KnowledgeDocument> = {}): KnowledgeDocument => ({
  blob: blob(c),
  name: `${c}.pdf`,
  mediaType: 'application/pdf',
  size: 10,
  index: blob('z'),
  chunks: 3,
  addedAt: 5,
  ...extra,
})

describe('knowledge bases', () => {
  test('create, rename, documents, trash and restore; reads are frozen and survive a reopen', async () => {
    ctx = await setup()
    const { ws } = ctx
    let changes = 0
    ws.subscribe('knowledge', () => changes++)
    const id = ws.knowledge.create({ name: 'Heron', embedder: { kind: 'local', model: 'Xenova/all-MiniLM-L6-v2' } })
    expect(ws.knowledge.get(id)).toMatchObject({ id, name: 'Heron', documents: [], embedder: { kind: 'local' } })
    ws.knowledge.update(id, { name: 'Heron project' })
    ws.knowledge.addDocument(id, doc('a'))
    ws.knowledge.addDocument(id, doc('b'))
    ws.knowledge.addDocument(id, doc('a', { chunks: 9 }))
    const base = ws.knowledge.get(id)
    expect(base?.name).toBe('Heron project')
    expect(base?.documents.map((d) => [d.blob[0], d.chunks])).toEqual([
      ['a', 9],
      ['b', 3],
    ])
    expect(Object.isFrozen(base)).toBe(true)
    expect(ws.knowledge.get(id)).toBe(base as never)
    ws.knowledge.removeDocument(id, blob('a'))
    expect(ws.knowledge.get(id)?.documents.map((d) => d.name)).toEqual(['b.pdf'])
    expect(changes).toBeGreaterThan(4)

    const other = ws.knowledge.create({ name: 'Alpha' })
    expect(ws.knowledge.list().map((k) => k.name)).toEqual(['Alpha', 'Heron project'])
    ws.knowledge.trash(other)
    expect(ws.knowledge.list().map((k) => k.name)).toEqual(['Heron project'])
    expect(ws.knowledge.list({ trashed: true }).map((k) => k.id)).toEqual([other])
    ws.knowledge.restore(other)
    expect(ws.knowledge.list()).toHaveLength(2)

    await ws.flush()
    ws.close()
    const again = await reopen(ctx.store, ctx.clock)
    expect(again.knowledge.get(id)?.documents.map((d) => d.name)).toEqual(['b.pdf'])
    expect(again.knowledge.get(id)?.embedder).toEqual({ kind: 'local', model: 'Xenova/all-MiniLM-L6-v2' })
    again.close()
  })

  test('malformed documents and embedders are refused', async () => {
    ctx = await setup()
    const { ws } = ctx
    const id = ws.knowledge.create({ name: 'K' })
    expect(() => ws.knowledge.addDocument(id, { ...doc('a'), blob: 'not-a-blob' })).toThrow(InvalidInputError)
    expect(() => ws.knowledge.addDocument(id, { ...doc('a'), size: -1 })).toThrow(InvalidInputError)
    expect(() => ws.knowledge.update(id, { embedder: { kind: 'provider', provider: 'x', model: 'm' } })).toThrow(
      InvalidInputError,
    )
    expect(() => ws.knowledge.update(id, { embedder: { kind: 'local', model: '' } })).toThrow(InvalidInputError)
    expect(() => ws.knowledge.update(newId(), { name: 'x' })).toThrow(InvalidInputError)
    ws.knowledge.update(id, { embedder: { kind: 'provider', provider: newId(), model: 'text-embedding-3-small' } })
    ws.knowledge.update(id, { embedder: null })
    expect(ws.knowledge.get(id)?.embedder).toBeNull()
  })
})

describe('attached knowledge', () => {
  test('a conversation carries the bases attached to it, and they may change after it started', async () => {
    ctx = await setup()
    const { ws } = ctx
    const a = ws.knowledge.create({ name: 'A' })
    const b = ws.knowledge.create({ name: 'B' })
    const conv = ws.conversations.create({ knowledge: [a, a] })
    expect(ws.conversations.get(conv)?.knowledge).toEqual([a])
    const plain = ws.conversations.create()
    expect(ws.conversations.get(plain)?.knowledge).toBeUndefined()
    const thread = await ws.thread(conv)
    thread.commit(msg(newId(), null, 'user', 'hello'))
    expect(() => ws.conversations.update(conv, { system: 'changed' })).toThrow(InvalidStateError)
    ws.conversations.update(conv, { knowledge: [b, a] })
    expect(ws.conversations.get(conv)?.knowledge).toEqual([b, a])
    ws.conversations.update(conv, { knowledge: [] })
    expect(ws.conversations.get(conv)?.knowledge).toEqual([])
    expect(() => ws.conversations.update(conv, { knowledge: ['nope'] })).toThrow(InvalidInputError)
  })
})
