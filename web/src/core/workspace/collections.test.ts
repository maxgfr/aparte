/*
 * The collections of contracts/extras.ts over the real workspace: entities are created, patched, trashed and
 * restored, survive a reopen from the encrypted pending queue, refuse secrets and non-Any values, and notify their
 * own scope.
 */
import { describe, expect, test } from 'bun:test'
import { InvalidInputError } from '../contracts/crypto.ts'
import { newId, reopen, setup } from './testkit.ts'

describe('workspace collections', () => {
  test('create, update, trash and restore, persisted across a reopen', async () => {
    const { ws, store, clock } = await setup()
    const lorebooks = ws.collection('lorebooks')
    let notified = 0
    const off = ws.subscribe('lorebooks', () => notified++)
    const id = lorebooks.create({
      name: 'Harbour town',
      entries: [{ triggers: ['harbour'], content: 'The harbour freezes in winter.', enabled: true, order: 0 }],
      scanDepth: 4,
      budget: 2000,
    })
    expect(notified).toBe(1)
    clock.tick()
    lorebooks.update(id, { name: 'Harbour', description: 'Places' })
    lorebooks.update(id, { description: undefined })
    const read = lorebooks.get(id)
    expect(read?.name).toBe('Harbour')
    expect(read?.description).toBeUndefined()
    expect(read?.entries[0]?.triggers).toEqual(['harbour'])
    expect(read?.updatedAt).toBeGreaterThan(read?.createdAt ?? 0)
    expect(Object.isFrozen(read)).toBe(true)
    expect(lorebooks.list()).toEqual([read as NonNullable<typeof read>])
    // The same object until it changes, for useSyncExternalStore.
    expect(lorebooks.get(id)).toBe(read as NonNullable<typeof read>)

    lorebooks.trash(id)
    expect(lorebooks.list()).toEqual([])
    expect(lorebooks.list({ trashed: true }).map((e) => e.id)).toEqual([id])
    lorebooks.restore(id)
    expect(lorebooks.list().map((e) => e.id)).toEqual([id])
    off()

    await ws.flush()
    ws.close()
    const again = await reopen(store, clock)
    expect(again.collection('lorebooks').get(id)?.name).toBe('Harbour')
    again.close()
  })

  test('an entity can take a given id, once', async () => {
    const { ws } = await setup()
    const conversation = ws.conversations.create()
    const options = ws.collection('chatOptions')
    expect(options.create({ note: 'Keep it short.', noteEvery: 2 }, { id: conversation })).toBe(conversation)
    expect(options.get(conversation)?.note).toBe('Keep it short.')
    expect(() => options.create({}, { id: conversation })).toThrow(InvalidInputError)
    expect(() => options.create({}, { id: 'not-an-id' })).toThrow(InvalidInputError)
    ws.close()
  })

  test('refuses secrets, metadata fields and values that are not Any', async () => {
    const { ws } = await setup()
    const personas = ws.collection('personas')
    expect(() => personas.create({ name: 'A', systemPrompt: `Use sk-${'a'.repeat(24)} for everything.` })).toThrow(
      InvalidInputError,
    )
    expect(() => personas.create({ name: 'A', systemPrompt: '', apiKey: 'x' } as never)).toThrow(InvalidInputError)
    expect(() => personas.create({ name: 'A', systemPrompt: '', id: newId() } as never)).toThrow(InvalidInputError)
    expect(() => personas.create({ name: 'A', systemPrompt: '', when: new Date() } as never)).toThrow(InvalidInputError)
    expect(() => personas.update(newId(), { name: 'B' })).toThrow(InvalidInputError)
    expect(() => ws.collection('nope' as never)).toThrow(InvalidInputError)
    expect(personas.list()).toEqual([])
    ws.close()
  })

  test('keeps fields it does not know', async () => {
    const { ws } = await setup()
    const votes = ws.collection('arenaVotes')
    const id = votes.create({
      a: { provider: 'p', id: 'm1' },
      b: { provider: 'p', id: 'm2' },
      winner: 'a',
      conversation: newId(),
      note: 'from a newer build',
    } as never)
    expect((votes.get(id) as unknown as { note: string }).note).toBe('from a newer build')
    ws.close()
  })
})
