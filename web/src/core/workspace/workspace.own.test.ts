/*
 * The workspace's own cases beyond the contract tests: cross-tab catch-up through BroadcastChannel notices that never
 * carry content, retries of a failing queue, automatic compaction, the Any rules, fractional order keys, secrets
 * refused in provider configuration, and the vault binding (hold while saving, close on lock).
 */
import { describe, expect, test } from 'bun:test'
import { InvalidInputError, InvalidStateError, LockedError } from '../contracts/crypto.ts'
import type { LocalStore } from '../contracts/store.ts'
import { deepFreeze, frozenCopy, toAny, wellFormed } from './any.ts'
import { bindWorkspaceToVault, type VaultLink } from './lifecycle.ts'
import { keyAfter } from './order.ts'
import { channelHub, eventually, msg, newId, openStore, reopen, setup } from './testkit.ts'
import { CHANNEL_NAME } from './workspace.ts'

describe('cross-tab notices', () => {
  test('a second tab on the same database catches up from the queue; notices carry no content', async () => {
    const hub = channelHub()
    const a = await setup({ channel: () => hub.join() })
    const tab = await openStore(a.name)
    const b = await reopen(tab.store, a.clock, { channel: () => hub.join() })
    const conv = a.ws.conversations.create({ title: 'From tab A' })
    let seen = 0
    b.subscribe('conversations', () => seen++)
    await eventually(() => b.conversations.get(conv)?.title === 'From tab A')
    expect(seen).toBeGreaterThan(0)

    const threadA = await a.ws.thread(conv)
    const threadB = await b.thread(conv)
    const u = newId()
    threadA.commit(msg(u, null, 'user', 'typed in A'))
    await eventually(() => threadB.get(u)?.parts[0]?.type === 'text')
    const v = newId()
    threadB.commit(msg(v, u, 'assistant', 'answered in B'))
    await eventually(() => threadA.get(v) !== undefined)

    await a.ws.flush()
    await b.flush()
    for (const message of hub.posted) {
      expect(Object.keys(message as object).sort()).toEqual(['doc', 'type'])
      expect(JSON.stringify(message)).not.toContain('typed')
    }
    expect(CHANNEL_NAME).toBe('aparte-workspace')
    a.ws.close()
    b.close()
  })
})

describe('a failing queue', () => {
  test('blocks, retries in order, and saves everything once the store recovers', async () => {
    const { store, clock } = await setup()
    let failures = 2
    const appended: number[] = []
    const flaky: LocalStore = {
      ...store,
      pending: {
        ...store.pending,
        append: async (docId, update) => {
          if (failures > 0) {
            failures--
            throw new Error('quota')
          }
          const n = await store.pending.append(docId, update)
          appended.push(n)
          return n
        },
      },
    }
    const ws = await reopen(flaky, clock, { retryDelayMs: () => 5 })
    const changes: boolean[] = []
    ws.onPersistence(() => changes.push(ws.persistence().blocked))
    const first = ws.conversations.create({ title: 'one' })
    const second = ws.conversations.create({ title: 'two' })
    await eventually(() => ws.persistence().blocked)
    await expect(ws.flush()).rejects.toThrow('quota')
    await eventually(() => ws.persistence().unsaved === 0)
    expect(ws.persistence()).toEqual({ unsaved: 0, blocked: false })
    expect(changes).toContain(true)
    ws.close()
    const again = await reopen(store, clock)
    expect(again.conversations.get(first)?.title).toBe('one')
    expect(again.conversations.get(second)?.title).toBe('two')
    expect(appended).toEqual([...appended].sort((x, y) => x - y))
  })

  test('the persistence status object is stable until it changes', async () => {
    const { ws } = await setup()
    const idle = ws.persistence()
    expect(ws.persistence()).toBe(idle)
    ws.conversations.create()
    const busy = ws.persistence()
    expect(busy).not.toBe(idle)
    await ws.flush()
    expect(Object.isFrozen(ws.persistence())).toBe(true)
  })
})

describe('compaction', () => {
  test('a queue that reaches the threshold is compacted on its own, without losing anything', async () => {
    const { ws, store, clock } = await setup({ compactAt: 4 })
    const ids: string[] = []
    for (let i = 0; i < 12; i++) {
      ids.push(ws.conversations.create({ title: `c${i}` }))
      await ws.flush()
    }
    await eventually(async () => (await store.pending.list('index')).length < 4)
    ws.close()
    const again = await reopen(store, clock)
    expect(ids.map((id) => again.conversations.get(id)?.title)).toEqual(ids.map((_, i) => `c${i}`))
  })

  test('compact on a document never loaded only merges its queue', async () => {
    const { ws, store } = await setup()
    await ws.compact('c07')
    expect(await store.pending.list('c07')).toEqual([])
  })
})

describe('validation', () => {
  test('Any values', () => {
    expect(toAny({ a: [1, 'x', null, true, new Uint8Array([1])] })).toEqual({
      a: [1, 'x', null, true, new Uint8Array([1])],
    })
    for (const bad of [
      Number.POSITIVE_INFINITY,
      Number.NaN,
      1n,
      undefined,
      Symbol('s'),
      new Date(0),
      new Map(),
      '\ud800',
    ]) {
      expect(() => toAny(bad)).toThrow(InvalidInputError)
    }
    const holey: number[] = []
    holey[1] = 2
    expect(() => toAny(holey)).toThrow(InvalidInputError)
    expect(() => toAny({ '\udc00': 1 })).toThrow(InvalidInputError)
    expect(wellFormed('emoji 😀')).toBe(true)
    expect(wellFormed('\ud83d')).toBe(false)
    const input = { nested: { list: [1] } }
    const copy = toAny(input) as typeof input
    input.nested.list.push(2)
    expect(copy.nested.list).toEqual([1])
    const frozen = frozenCopy<{ n: { l: number[]; b: Uint8Array } }>({ n: { l: [1], b: new Uint8Array(2) } })
    expect(Object.isFrozen(frozen.n.l)).toBe(true)
    expect(deepFreeze(frozen)).toBe(frozen)
  })

  test('order keys always sort after the previous one', () => {
    let key: string | null = null
    const keys: string[] = []
    for (let i = 0; i < 200; i++) {
      key = keyAfter(key)
      keys.push(key)
    }
    expect([...keys].sort()).toEqual(keys)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keyAfter('z') > 'z').toBe(true)
  })

  test('folders are appended in order and listed by it', async () => {
    const { ws } = await setup()
    const names = ['a', 'b', 'c', 'd']
    for (const name of names) ws.folders.create({ name })
    expect(ws.folders.list().map((f) => f.name)).toEqual(names)
    const [first] = ws.folders.list()
    ws.folders.trash(first?.id as string)
    expect(ws.folders.list({ trashed: true }).map((f) => f.name)).toEqual(['a'])
    ws.folders.restore(first?.id as string)
    expect(ws.folders.list()).toHaveLength(4)
  })

  test('provider fields never carry a key, a credential URL or an unknown field', async () => {
    const { ws } = await setup()
    const base = { kind: 'openai-compatible', label: 'Groq', syncKey: false } as const
    const bad = [
      { ...base, label: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz' },
      { ...base, models: ['gsk_abcdefghijklmnopqrstuvwxyz0123'] },
      { ...base, overrides: { m: { headers: { authorization: 'x' } } } },
      { ...base, baseUrl: 'https://user:pass@api.example.com/v1' },
      { ...base, baseUrl: 'https://api.example.com/v1?key=abc' },
      { ...base, baseUrl: 'http://api.example.com/v1' },
      { ...base, secret: 'sk-not-an-id' },
      { ...base, password: 'x' },
      { ...base, color: 'red' },
      { ...base, kind: 'unknown' },
    ]
    for (const input of bad) expect(() => ws.providers.create(input as never)).toThrow(InvalidInputError)
    const id = ws.providers.create({ ...base, baseUrl: 'http://localhost:11434/v1/', models: ['llama'] })
    expect(ws.providers.get(id)?.baseUrl).toBe('http://localhost:11434/v1')
    ws.providers.update(id, { label: 'Local', baseUrl: undefined })
    expect(ws.providers.get(id)?.baseUrl).toBeUndefined()
    expect(ws.providers.get(id)?.label).toBe('Local')
    expect(() => ws.providers.update(id, { label: undefined } as never)).toThrow(InvalidInputError)
    ws.providers.trash(id)
    expect(ws.providers.list()).toEqual([])
  })

  test('commit validates the whole message before writing anything', async () => {
    const { ws } = await setup()
    const conv = ws.conversations.create()
    const thread = await ws.thread(conv)
    const cases = [
      msg('not-an-id', null, 'user', 'x'),
      msg(newId(), null, 'robot' as never, 'x'),
      msg(newId(), null, 'user', 'x', { status: 'pending' as never }),
      msg(newId(), null, 'user', 'x', { usage: { input: -1 } }),
      msg(newId(), null, 'user', 'x', { stop: 'tired' as never }),
      msg(newId(), null, 'user', 'x', { effort: 'extreme' as never }),
      msg(newId(), null, 'user', 'x', { createdAt: 1.5 }),
    ]
    for (const input of cases) expect(() => thread.commit(input)).toThrow(InvalidInputError)
    expect(thread.all()).toEqual([])
    expect(ws.conversations.get(conv)?.startedAt).toBeUndefined()
    const refused = newId()
    thread.commit(
      msg(refused, null, 'assistant', 'x', {
        parts: [],
        status: 'refused',
        stop: 'refusal',
        refusal: { category: null, explanation: 'declined' },
        effort: 'xhigh',
        error: { code: 'refusal', message: 'm' },
      }),
    )
    expect(thread.get(refused)).toMatchObject({ status: 'refused', refusal: { category: null }, effort: 'xhigh' })
  })

  test('purged conversations refuse every change', async () => {
    const { ws } = await setup()
    const conv = ws.conversations.create()
    ws.conversations.trash(conv)
    await ws.conversations.purge(conv)
    expect(() => ws.conversations.update(conv, { title: 'x' })).toThrow(InvalidStateError)
    expect(() => ws.conversations.restore(conv)).toThrow(InvalidStateError)
    await expect(ws.conversations.purge(conv)).rejects.toBeInstanceOf(InvalidStateError)
  })

  test('reads are stable for useSyncExternalStore until a change', async () => {
    const { ws } = await setup()
    const conv = ws.conversations.create()
    const thread = await ws.thread(conv)
    const u = newId()
    thread.commit(msg(u, null, 'user', 'hi'))
    thread.setLeaf(u)
    expect(ws.conversations.list()).toBe(ws.conversations.list())
    expect(thread.all()).toBe(thread.all())
    expect(thread.path()).toBe(thread.path())
    const before = thread.path()
    thread.commit(msg(newId(), u, 'assistant', 'hello'))
    expect(thread.path()).not.toBe(before)
    expect(thread.path()).toEqual(before)
  })

  test('batch writes one update per touched document', async () => {
    const { ws, store } = await setup()
    const conv = ws.conversations.create()
    const thread = await ws.thread(conv)
    await ws.flush()
    const shard = await ws.conversations.shardOf(conv)
    const [index0, shard0] = [(await store.pending.list('index')).length, (await store.pending.list(shard)).length]
    const u = newId()
    ws.batch(() => {
      thread.commit(msg(u, null, 'user', 'hi'))
      thread.setLeaf(u)
      ws.conversations.update(conv, { title: 'batched' })
    })
    await ws.flush()
    expect((await store.pending.list('index')).length).toBe(index0 + 1)
    expect((await store.pending.list(shard)).length).toBe(shard0 + 1)
  })
})

describe('vault binding', () => {
  function fakeVault() {
    const cleanups = new Set<() => void>()
    let holds = 0
    const vault: VaultLink = {
      onLock: (fn) => {
        const entry = (): void => void fn()
        cleanups.add(entry)
        return () => cleanups.delete(entry)
      },
      holdLock: () => {
        holds++
        let released = false
        return () => {
          if (!released) holds--
          released = true
        }
      },
    }
    return {
      vault,
      holds: () => holds,
      lock: () => {
        for (const fn of [...cleanups]) fn()
      },
    }
  }

  test('holds the lock while saving, then closes the workspace on lock after the cleanups', async () => {
    const { ws } = await setup()
    const v = fakeVault()
    const order: string[] = []
    bindWorkspaceToVault(v.vault, ws, [() => order.push(`cleanup:${ws.conversations.list().length}`)])
    ws.conversations.create()
    expect(v.holds()).toBe(1)
    await ws.flush()
    expect(v.holds()).toBe(0)
    v.lock()
    expect(order).toEqual(['cleanup:1'])
    expect(() => ws.conversations.list()).toThrow(LockedError)
  })
})
