/*
 * The workspace (web/src/core/contracts/workspace.ts) over the real LocalStore and fake-indexeddb: the index and the
 * 16 conversation shards of spec/DATA-MODEL.md, conversations, the message tree, encrypted persistence through the
 * pending queue, transaction origins, and the Yjs schema the Rust implementation reads. A canary checks that no title,
 * message or provider label ever reaches IndexedDB in clear.
 */
import { describe, expect, test } from 'bun:test'
import * as Y from 'yjs'
import {
  type BytesModule,
  type DocId,
  InvalidInputError,
  InvalidStateError,
  type KeysModule,
  LockedError,
  type NamesModule,
  type RngModule,
  type ShardId,
} from '../contracts/crypto.ts'
import type { LocalStore, LocalStoreModule } from '../contracts/store.ts'
import type { Clock } from '../contracts/vault.ts'
import type { Id, NewMessage, Workspace, WorkspaceModule } from '../contracts/workspace.ts'
import * as bytesImpl from '../crypto/bytes.ts'
import * as keysImpl from '../crypto/keys.ts'
import * as namesImpl from '../crypto/names.ts'
import * as rngImpl from '../crypto/rng.ts'
import * as storeImpl from '../store/localStore.ts'
import * as workspaceImpl from './workspace.ts'

const B: BytesModule = bytesImpl
const K: KeysModule = keysImpl
const N: NamesModule = namesImpl
const R: RngModule = rngImpl
const S: LocalStoreModule = storeImpl
const W: WorkspaceModule = workspaceImpl

const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  mk: string
  vaultId: string
}
const subkeys = await K.deriveSubkeys(B.fromHex(inputs.mk), B.fromHex(inputs.vaultId))
const SHARDS: ShardId[] = Array.from({ length: 16 }, (_, i) => `c${String(i).padStart(2, '0')}` as ShardId)
const CANARY = 'canary-3e9b77-no-conversation-text-in-clear'

class FakeClock implements Clock {
  t = 1_760_000_000_000
  now(): number {
    return this.t
  }
  tick(ms = 1000): void {
    this.t += ms
  }
}

let count = 0
async function setup(name = `workspace-${++count}-${crypto.randomUUID()}`) {
  const db = await S.openLocalDb({ name })
  const store = S.createLocalStore({ db, subkeys, rng: R.cryptoRng() })
  const clock = new FakeClock()
  const ws = await W.openWorkspace({ store, subkeys, rng: R.cryptoRng(), clock })
  return { name, db, store, clock, ws }
}

async function reopen(store: LocalStore, clock: Clock): Promise<Workspace> {
  return W.openWorkspace({ store, subkeys, rng: R.cryptoRng(), clock })
}

function msg(
  id: Id,
  parent: Id | null,
  role: NewMessage['role'],
  text: string,
  extra: Partial<NewMessage> = {},
): NewMessage {
  return { id, parent, role, parts: [{ type: 'text', text }], model: null, status: 'done', ...extra }
}

const newId = (): Id => B.base32Encode(R.cryptoRng().bytes(16))

describe('conversations', () => {
  test('create fills the defaults, from the synced default system prompt', async () => {
    const { ws, clock } = await setup()
    ws.settings.set('defaultSystem', 'You are concise.')
    const id = ws.conversations.create()
    expect(id).toMatch(/^[a-z2-7]{26}$/)
    expect(ws.conversations.get(id)).toEqual({
      id,
      title: '',
      folder: null,
      persona: null,
      model: null,
      effort: null,
      leaf: null,
      system: 'You are concise.',
      tools: [],
      pinned: false,
      archived: false,
      createdAt: clock.t,
      updatedAt: clock.t,
    })
    expect(Object.isFrozen(ws.conversations.get(id))).toBe(true)
  })

  test('settings default to nothing', async () => {
    const { ws } = await setup()
    expect(ws.settings.get('defaultModel')).toBeNull()
    expect(ws.settings.get('defaultEffort')).toBeNull()
    expect(ws.settings.get('defaultSystem')).toBe('')
    ws.settings.set('defaultEffort', 'xhigh')
    expect(ws.settings.get('defaultEffort')).toBe('xhigh')
  })

  test('voice and image settings: model references and a voice, validated', async () => {
    const { ws } = await setup()
    for (const key of ['transcriptionModel', 'speechModel', 'imageModel'] as const) {
      expect(ws.settings.get(key)).toBeNull()
      ws.settings.set(key, { provider: 'p1', id: 'whisper-1' })
      expect(ws.settings.get(key)).toEqual({ provider: 'p1', id: 'whisper-1' })
      expect(Object.isFrozen(ws.settings.get(key))).toBe(true)
      expect(() => ws.settings.set(key, { provider: '', id: 'x' } as never)).toThrow(InvalidInputError)
      ws.settings.set(key, null)
      expect(ws.settings.get(key)).toBeNull()
    }
    expect(ws.settings.get('speechVoice')).toBe('')
    ws.settings.set('speechVoice', 'coral')
    expect(ws.settings.get('speechVoice')).toBe('coral')
    expect(() => ws.settings.set('speechVoice', 42 as never)).toThrow(InvalidInputError)
  })

  test('update bumps updatedAt and keeps the object identity until a change', async () => {
    const { ws, clock } = await setup()
    const id = ws.conversations.create({ title: 'First' })
    const before = ws.conversations.get(id)
    expect(ws.conversations.get(id)).toBe(before as never)
    clock.tick()
    ws.conversations.update(id, { title: 'Renamed', effort: 'high', model: { provider: 'p1', id: 'claude-opus-5-5' } })
    const after = ws.conversations.get(id)
    expect(after).not.toBe(before as never)
    expect(after?.title).toBe('Renamed')
    expect(after?.effort).toBe('high')
    expect(after?.model).toEqual({ provider: 'p1', id: 'claude-opus-5-5' })
    expect(after?.updatedAt).toBe(clock.t)
    expect(() => ws.conversations.update(newId(), { title: 'x' })).toThrow(InvalidInputError)
  })

  test('list: pinned first, then most recently updated; archived and trashed only on request', async () => {
    const { ws, clock } = await setup()
    const a = ws.conversations.create({ title: 'a' })
    clock.tick()
    const b = ws.conversations.create({ title: 'b' })
    clock.tick()
    const c = ws.conversations.create({ title: 'c', pinned: true })
    clock.tick()
    const d = ws.conversations.create({ title: 'd' })
    clock.tick()
    const e = ws.conversations.create({ title: 'e' })
    ws.conversations.update(d, { archived: true })
    ws.conversations.trash(e)
    expect(ws.conversations.list().map((x) => x.id)).toEqual([c, b, a])
    expect(ws.conversations.list({ archived: true }).map((x) => x.id)).toEqual([d])
    expect(ws.conversations.list({ trashed: true }).map((x) => x.id)).toEqual([e])
    ws.conversations.restore(e)
    expect(ws.conversations.get(e)?.deletedAt).toBeUndefined()
  })

  test('folder filter, and trashing a folder moves its conversations to the root', async () => {
    const { ws } = await setup()
    const f = ws.folders.create({ name: 'Work' })
    const inside = ws.conversations.create({ folder: f })
    const outside = ws.conversations.create()
    expect(ws.conversations.list({ folder: f }).map((x) => x.id)).toEqual([inside])
    expect(ws.conversations.list({ folder: null }).map((x) => x.id)).toEqual([outside])
    ws.folders.trash(f)
    expect(ws.conversations.get(inside)?.folder).toBeNull()
    expect(ws.conversations.get(inside)?.deletedAt).toBeUndefined()
  })

  test('a folder cannot move inside its own subtree', async () => {
    const { ws } = await setup()
    const a = ws.folders.create({ name: 'a' })
    const b = ws.folders.create({ name: 'b', parent: a })
    expect(() => ws.folders.update(a, { parent: b })).toThrow(InvalidInputError)
    expect(() => ws.folders.update(a, { parent: a })).toThrow(InvalidInputError)
  })

  test('system and tools freeze with the first message', async () => {
    const { ws } = await setup()
    const id = ws.conversations.create({ system: 'v1' })
    ws.conversations.update(id, { system: 'v2' })
    const thread = await ws.thread(id)
    thread.commit(msg(newId(), null, 'user', 'Hi'))
    const conv = ws.conversations.get(id)
    expect(conv?.system).toBe('v2')
    expect(typeof conv?.startedAt).toBe('number')
    expect(() => ws.conversations.update(id, { system: 'v3' })).toThrow(InvalidStateError)
    expect(() => ws.conversations.update(id, { tools: [] })).toThrow(InvalidStateError)
    ws.conversations.update(id, { title: 'still editable' })
    expect(ws.conversations.get(id)?.title).toBe('still editable')
  })

  test('purge empties a trashed conversation and its messages', async () => {
    const { ws } = await setup()
    const id = ws.conversations.create({ title: 'to purge' })
    const thread = await ws.thread(id)
    thread.commit(msg(newId(), null, 'user', 'secret plans'))
    await expect(ws.conversations.purge(id)).rejects.toBeInstanceOf(InvalidStateError)
    ws.conversations.trash(id)
    await ws.conversations.purge(id)
    const purged = ws.conversations.get(id)
    expect(Object.keys(purged ?? {}).sort()).toEqual(['createdAt', 'id', 'purgedAt'])
    expect(ws.conversations.list({ trashed: true }).map((x) => x.id)).not.toContain(id)
    await expect(ws.thread(id)).rejects.toBeInstanceOf(InvalidInputError)
    const doc = new Y.Doc()
    Y.applyUpdateV2(doc, await ws.state(await ws.conversations.shardOf(id)))
    const messages = doc.getMap('messages')
    for (const value of messages.values()) expect((value as Y.Map<unknown>).get('conv')).not.toBe(id)
  })
})

describe('the message tree', () => {
  async function tree() {
    const ctx = await setup()
    const conv = ctx.ws.conversations.create()
    const thread = await ctx.ws.thread(conv)
    const [u1, a1, a2, u2, u3] = [newId(), newId(), newId(), newId(), newId()]
    thread.commit(msg(u1, null, 'user', 'Question'))
    ctx.clock.tick()
    thread.commit(msg(a1, u1, 'assistant', 'Answer one', { model: { provider: 'p', id: 'm' } }))
    ctx.clock.tick()
    thread.commit(msg(a2, u1, 'assistant', 'Answer two', { model: { provider: 'p', id: 'm' } }))
    ctx.clock.tick()
    thread.commit(msg(u2, a1, 'user', 'Follow-up on one'))
    ctx.clock.tick()
    thread.commit(msg(u3, a2, 'user', 'Follow-up on two'))
    return { ...ctx, conv, thread, u1, a1, a2, u2, u3 }
  }

  test('commit does not move the leaf; setLeaf selects a path from the root', async () => {
    const { ws, conv, thread, u1, a1, u2 } = await tree()
    expect(ws.conversations.get(conv)?.leaf).toBeNull()
    expect(thread.path()).toEqual([])
    expect(thread.setLeaf(u2)).toBe(true)
    expect(ws.conversations.get(conv)?.leaf).toBe(u2)
    expect(thread.path().map((m) => m.id)).toEqual([u1, a1, u2])
    expect(thread.path(a1).map((m) => m.id)).toEqual([u1, a1])
  })

  test('siblings are ordered by creation and descend follows the newest child', async () => {
    const { thread, u1, a1, a2, u3 } = await tree()
    expect(thread.children(null).map((m) => m.id)).toEqual([u1])
    expect(thread.children(u1).map((m) => m.id)).toEqual([a1, a2])
    expect(thread.siblings(a2)).toEqual({ messages: thread.children(u1), index: 1 })
    expect(thread.descend(a2)).toBe(u3)
    expect(thread.descend(u1)).toBe(u3)
  })

  test('setLeaf with ifLeaf moves only from the expected leaf', async () => {
    const { thread, a1, a2, u2 } = await tree()
    thread.setLeaf(a1)
    expect(thread.setLeaf(u2, { ifLeaf: a2 })).toBe(false)
    expect(thread.path().at(-1)?.id).toBe(a1)
    expect(thread.setLeaf(u2, { ifLeaf: a1 })).toBe(true)
    expect(thread.path().at(-1)?.id).toBe(u2)
  })

  test('commit refuses duplicates, unknown parents and foreign leaves', async () => {
    const { ws, thread, u1 } = await tree()
    expect(() => thread.commit(msg(u1, null, 'user', 'again'))).toThrow(InvalidInputError)
    expect(() => thread.commit(msg(newId(), newId(), 'user', 'orphan'))).toThrow(InvalidInputError)
    const other = await ws.thread(ws.conversations.create())
    expect(() => other.setLeaf(u1)).toThrow(InvalidInputError)
    expect(() => other.commit(msg(newId(), u1, 'user', 'cross-conversation parent'))).toThrow(InvalidInputError)
  })

  test('committed messages are frozen values with every field of the data model', async () => {
    const { thread, a1, u1 } = await tree()
    const m = thread.get(a1)
    expect(Object.isFrozen(m)).toBe(true)
    expect(m).toMatchObject({
      id: a1,
      parent: u1,
      role: 'assistant',
      status: 'done',
      model: { provider: 'p', id: 'm' },
    })
    expect(typeof m?.createdAt).toBe('number')
    expect(m?.parts).toEqual([{ type: 'text', text: 'Answer one' }])
  })

  test('parts must be Yjs Any values', async () => {
    const { thread, u1 } = await tree()
    const bad = (input: unknown) =>
      msg(newId(), u1, 'assistant', 'x', { parts: [{ type: 'tool-call', callId: 'c', name: 'n', input } as never] })
    expect(() => thread.commit(bad(Number.NaN))).toThrow(InvalidInputError)
    expect(() => thread.commit(bad(10n))).toThrow(InvalidInputError)
    expect(() => thread.commit(bad({ nested: undefined }))).toThrow(InvalidInputError)
    expect(() => thread.commit(bad(() => 1))).toThrow(InvalidInputError)
  })

  test('delete is final, keeps the message in the path, and does not move the leaf', async () => {
    const { thread, a1, u2 } = await tree()
    thread.setLeaf(u2)
    thread.delete(a1)
    expect(typeof thread.get(a1)?.deletedAt).toBe('number')
    expect(thread.path().map((m) => m.id)).toContain(a1)
    expect(thread.path().at(-1)?.id).toBe(u2)
  })

  test('subscribe fires per scope and stops after unsubscribe', async () => {
    const { ws, conv, thread, u1 } = await tree()
    let lists = 0
    let messages = 0
    const offList = ws.subscribe('conversations', () => lists++)
    const offConv = ws.subscribe({ conversation: conv }, () => messages++)
    thread.commit(msg(newId(), u1, 'assistant', 'Answer three'))
    expect(messages).toBeGreaterThan(0)
    ws.conversations.create()
    expect(lists).toBeGreaterThan(0)
    offList()
    offConv()
    const [l, m] = [lists, messages]
    ws.conversations.create()
    thread.commit(msg(newId(), u1, 'assistant', 'Answer four'))
    expect([lists, messages]).toEqual([l, m])
  })
})

describe('shards and persistence', () => {
  test('a conversation lives in the shard its id names, and only there', async () => {
    const { ws, store } = await setup()
    const conv = ws.conversations.create()
    const shard = await N.shardOf(subkeys, B.base32Decode(conv))
    expect(await ws.conversations.shardOf(conv)).toBe(shard)
    const thread = await ws.thread(conv)
    thread.commit(msg(newId(), null, 'user', 'Where am I stored?'))
    await ws.flush()
    expect((await store.pending.list(shard)).length).toBeGreaterThan(0)
    expect((await store.pending.list('index')).length).toBeGreaterThan(0)
    for (const other of SHARDS.filter((s) => s !== shard)) expect(await store.pending.list(other)).toEqual([])
  })

  test('everything survives a reopen from the pending queue', async () => {
    const { ws, store, clock } = await setup()
    const conv = ws.conversations.create({ title: 'Kept' })
    const thread = await ws.thread(conv)
    const [u, a] = [newId(), newId()]
    thread.commit(msg(u, null, 'user', 'Hi'))
    thread.commit(msg(a, u, 'assistant', 'Hello', { usage: { input: 3, output: 2 }, stop: 'end' }))
    thread.setLeaf(a)
    await ws.flush()
    ws.close()
    const again = await reopen(store, clock)
    expect(again.conversations.get(conv)?.title).toBe('Kept')
    const path = (await again.thread(conv)).path()
    expect(path.map((m) => [m.id, m.role, m.parts])).toEqual([
      [u, 'user', [{ type: 'text', text: 'Hi' }]],
      [a, 'assistant', [{ type: 'text', text: 'Hello' }]],
    ])
    expect(path[1]?.usage).toEqual({ input: 3, output: 2 })
    expect(path[1]?.stop).toBe('end')
  })

  test('persistence counts unsaved updates until the queue acknowledges them', async () => {
    const { ws } = await setup()
    ws.conversations.create()
    expect(ws.persistence().unsaved).toBeGreaterThan(0)
    await ws.flush()
    expect(ws.persistence()).toEqual({ unsaved: 0, blocked: false })
  })

  test('compact leaves one record per document and the same state', async () => {
    const { ws, store, clock } = await setup()
    for (let i = 0; i < 5; i++) ws.conversations.create({ title: `n${i}` })
    await ws.flush()
    expect((await store.pending.list('index')).length).toBeGreaterThan(1)
    const before = ws.conversations.list().map((c) => c.title)
    await ws.compact('index')
    expect(await store.pending.list('index')).toHaveLength(1)
    ws.close()
    const again = await reopen(store, clock)
    expect(again.conversations.list().map((c) => c.title)).toEqual(before)
  })

  test('remote updates are applied but never queued again; concurrent branches both survive', async () => {
    const a = await setup()
    const b = await setup()
    const conv = a.ws.conversations.create({ title: 'Shared' })
    const root = newId()
    ;(await a.ws.thread(conv)).commit(msg(root, null, 'user', 'Q'))
    await a.ws.flush()
    const shard = await a.ws.conversations.shardOf(conv)
    await b.ws.applyRemote('index', await a.ws.state('index'))
    await b.ws.applyRemote(shard, await a.ws.state(shard))
    await b.ws.flush()
    expect(await b.store.pending.list('index')).toEqual([])
    expect(await b.store.pending.list(shard)).toEqual([])
    const [fromA, fromB] = [newId(), newId()]
    ;(await a.ws.thread(conv)).commit(msg(fromA, root, 'assistant', 'A says'))
    ;(await b.ws.thread(conv)).commit(msg(fromB, root, 'assistant', 'B says'))
    await a.ws.applyRemote(shard, await b.ws.state(shard))
    await b.ws.applyRemote(shard, await a.ws.state(shard))
    const ids = async (ws: Workspace) =>
      (await ws.thread(conv))
        .children(root)
        .map((m) => m.id)
        .sort()
    expect(await ids(a.ws)).toEqual([fromA, fromB].sort())
    expect(await ids(b.ws)).toEqual(await ids(a.ws))
  })

  test('close drops everything: later calls throw LockedError', async () => {
    const { ws } = await setup()
    const conv = ws.conversations.create()
    ws.close()
    ws.close()
    expect(() => ws.conversations.list()).toThrow(LockedError)
    await expect(ws.thread(conv)).rejects.toBeInstanceOf(LockedError)
  })
})

describe('nothing in clear, no secret in a document', () => {
  function request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  async function rawBytes(name: string): Promise<Uint8Array[]> {
    const db = await request(indexedDB.open(name))
    const out: Uint8Array[] = []
    for (const storeName of [...db.objectStoreNames]) {
      const os = db.transaction(storeName, 'readonly').objectStore(storeName)
      for (const k of await request(os.getAllKeys())) out.push(B.utf8(String(k)))
      for (const v of await request(os.getAll())) {
        if (v instanceof Uint8Array) out.push(v)
        else if (v instanceof ArrayBuffer) out.push(new Uint8Array(v))
        else if (typeof v === 'string') out.push(B.utf8(v))
      }
    }
    db.close()
    return out
  }
  const contains = (haystack: Uint8Array, needle: Uint8Array): boolean => {
    outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
      for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
      return true
    }
    return false
  }

  test('titles, messages, folder names and provider labels never reach IndexedDB in clear', async () => {
    const { name, ws } = await setup()
    const conv = ws.conversations.create({ title: `${CANARY}-title`, system: `${CANARY}-system` })
    ws.folders.create({ name: `${CANARY}-folder` })
    ws.providers.create({ kind: 'anthropic', label: `${CANARY}-label`, syncKey: false })
    const thread = await ws.thread(conv)
    thread.commit(msg(newId(), null, 'user', `${CANARY}-message`))
    await ws.flush()
    await ws.compact('index')
    const needles = [B.utf8(CANARY), new Uint8Array(new Uint16Array([...CANARY].map((c) => c.charCodeAt(0))).buffer)]
    for (const bytes of await rawBytes(name)) for (const needle of needles) expect(contains(bytes, needle)).toBe(false)
  })

  test('a provider holding a key-like field is refused', async () => {
    const { ws } = await setup()
    for (const field of ['apiKey', 'key', 'token', 'secretKey']) {
      expect(() =>
        ws.providers.create({ kind: 'openai', label: 'x', syncKey: false, [field]: 'sk-abc' } as never),
      ).toThrow(InvalidInputError)
    }
    expect(ws.providers.list()).toEqual([])
    const id = ws.providers.create({ kind: 'openai', label: 'OpenAI', syncKey: false, secret: newId() })
    expect(ws.providers.get(id)?.label).toBe('OpenAI')
  })
})

describe('the Yjs schema the CLI reads', () => {
  test('index maps and conversation fields; shard messages with Any fields only', async () => {
    const { ws } = await setup()
    const conv = ws.conversations.create({ title: 'Schema', model: { provider: 'p', id: 'm' } })
    const thread = await ws.thread(conv)
    const u = newId()
    thread.commit(msg(u, null, 'user', 'Hi'))
    thread.setLeaf(u)
    const index = new Y.Doc()
    Y.applyUpdateV2(index, await ws.state('index'))
    const conversations = index.getMap('conversations')
    const entry = conversations.get(conv)
    expect(entry).toBeInstanceOf(Y.Map)
    const fields = (entry as Y.Map<unknown>).toJSON()
    expect(fields).toMatchObject({
      id: conv,
      title: 'Schema',
      folder: null,
      persona: null,
      model: { provider: 'p', id: 'm' },
      effort: null,
      leaf: u,
      system: '',
      tools: [],
      pinned: false,
      archived: false,
    })
    expect(typeof fields.startedAt).toBe('number')
    for (const value of Object.values(fields)) expect(value).not.toBeUndefined()

    const shard = new Y.Doc()
    Y.applyUpdateV2(shard, await ws.state((await ws.conversations.shardOf(conv)) as DocId))
    const message = shard.getMap('messages').get(u)
    expect(message).toBeInstanceOf(Y.Map)
    expect((message as Y.Map<unknown>).toJSON()).toMatchObject({
      conv,
      parent: null,
      role: 'user',
      parts: [{ type: 'text', text: 'Hi' }],
      model: null,
      status: 'done',
    })
    expect([...shard.share.keys()]).toEqual(['messages'])
  })
})
