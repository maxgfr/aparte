/*
 * In-memory search over an open workspace: titles and message text, diacritics folded, trashed conversations and
 * deleted messages left out, kept current on every change, and emptied on lock.
 */
import { describe, expect, test } from 'bun:test'
import { LockedError } from '../contracts/crypto.ts'
import { eventually, msg, newId, setup } from '../workspace/testkit.ts'
import { createSearch, fold, snippetOf } from './search.ts'

describe('search', () => {
  test('finds titles and messages, across shards, and keeps up with changes', async () => {
    const { ws, clock } = await setup()
    const trip = ws.conversations.create({ title: 'Voyage à Kyōto' })
    const recipe = ws.conversations.create({ title: 'Recipes' })
    const tripThread = await ws.thread(trip)
    const q = newId()
    tripThread.commit(msg(q, null, 'user', 'Which temples should I visit in spring?'))
    clock.tick()
    tripThread.commit(msg(newId(), q, 'assistant', 'Kiyomizu-dera is lovely when the cherry blossoms are out.'))
    const recipeThread = await ws.thread(recipe)
    recipeThread.commit(msg(newId(), null, 'user', 'A crème brûlée for six'))

    const search = createSearch({ workspace: ws })
    expect(search.indexing()).toBe(true)
    await search.ready()
    expect(search.indexing()).toBe(false)

    const byTitle = await search.search('kyoto')
    expect(byTitle.map((h) => h.conversation)).toEqual([trip])
    expect(byTitle[0]?.titleMatch).toBe(true)

    const byText = await search.search('cherry blossom')
    expect(byText.map((h) => h.conversation)).toEqual([trip])
    const snippet = byText[0]?.messages[0]?.snippet
    expect(snippet?.text).toContain('cherry blossoms')
    const [start, end] = snippet?.highlights[0] ?? [0, 0]
    expect(snippet?.text.slice(start, end).toLowerCase()).toBe('cherry')

    expect((await search.search('creme brulee')).map((h) => h.conversation)).toEqual([recipe])
    expect(await search.search('   ')).toEqual([])

    let notified = 0
    search.subscribe(() => notified++)
    const added = newId()
    recipeThread.commit(msg(added, null, 'user', 'And a tarte tatin'))
    expect((await search.search('tatin')).map((h) => h.conversation)).toEqual([recipe])
    expect(notified).toBeGreaterThan(0)

    recipeThread.delete(added)
    expect(await search.search('tatin')).toEqual([])

    ws.conversations.update(recipe, { title: 'Desserts' })
    expect((await search.search('desserts')).map((h) => h.conversation)).toEqual([recipe])

    ws.conversations.update(recipe, { archived: true })
    expect((await search.search('desserts')).map((h) => h.conversation)).toEqual([recipe])

    ws.conversations.trash(trip)
    expect(await search.search('cherry')).toEqual([])
    ws.conversations.restore(trip)
    await eventually(async () => (await search.search('cherry')).length === 1)

    const fresh = ws.conversations.create({ title: 'Later' })
    const freshThread = await ws.thread(fresh)
    freshThread.commit(msg(newId(), null, 'user', 'zanzibar'))
    await eventually(async () => (await search.search('zanzibar')).length === 1)
    search.dispose()
  })

  test('dispose on lock drops everything; later searches reject', async () => {
    const { ws } = await setup()
    ws.conversations.create({ title: 'Secret project' })
    const cleanups: (() => void)[] = []
    const search = createSearch({
      workspace: ws,
      onLock: (fn) => {
        cleanups.push(fn)
        return () => {}
      },
    })
    await search.ready()
    expect(await search.search('secret')).toHaveLength(1)
    for (const fn of cleanups) fn()
    await expect(search.search('secret')).rejects.toBeInstanceOf(LockedError)
    search.dispose()
  })

  test('a workspace closed during the build ends it quietly', async () => {
    const { ws } = await setup()
    const conv = ws.conversations.create({ title: 'x' })
    ;(await ws.thread(conv)).commit(msg(newId(), null, 'user', 'hello'))
    const search = createSearch({ workspace: ws })
    ws.close()
    await search.ready()
    search.dispose()
  })

  test('snippets and folding', () => {
    expect(fold('Élève ÇA')).toBe('eleve ca')
    const long = `${'word '.repeat(40)}Ünïcode target here ${'tail '.repeat(60)}`
    const s = snippetOf(long, ['unicode', 'target'])
    expect(s.text.startsWith('…')).toBe(true)
    expect(s.text.endsWith('…')).toBe(true)
    const marked = s.highlights.map(([a, b]) => s.text.slice(a, b))
    expect(marked).toEqual(['Ünïcode', 'target'])
    expect(snippetOf('short text', []).text).toBe('short text')
  })
})
