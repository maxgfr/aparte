/*
 * The chat controller (web/src/core/contracts/chat.ts, ControllerModule) over the real workspace and LocalStore, with a
 * scripted adapter whose streams can pause until the test releases them. Pinned here: one commit per response, its
 * status and parts for each outcome, the leaf rules, the queue, regenerate and edit as new siblings, the lock and
 * reload holds, nothing written for a turn that cannot start, and large parts stored as blobs.
 */
import { describe, expect, test } from 'bun:test'
import type {
  Capabilities,
  ChatAdapter,
  ChatEvent,
  ChatRequest,
  ModelDescriptor,
  ProviderKeys,
} from '../contracts/ai.ts'
import type { ChatController, ChatDeps, ControllerModule } from '../contracts/chat.ts'
import {
  type BytesModule,
  InvalidInputError,
  InvalidStateError,
  type KeysModule,
  type RngModule,
} from '../contracts/crypto.ts'
import type { LocalStoreModule } from '../contracts/store.ts'
import type { Clock } from '../contracts/vault.ts'
import type { BlobPort, Id, Message, ModelRef, Part, Workspace, WorkspaceModule } from '../contracts/workspace.ts'
import * as bytesImpl from '../crypto/bytes.ts'
import * as keysImpl from '../crypto/keys.ts'
import * as rngImpl from '../crypto/rng.ts'
import * as storeImpl from '../store/localStore.ts'
import * as workspaceImpl from '../workspace/workspace.ts'
import * as controllerImpl from './controller.ts'

const B: BytesModule = bytesImpl
const K: KeysModule = keysImpl
const R: RngModule = rngImpl
const S: LocalStoreModule = storeImpl
const W: WorkspaceModule = workspaceImpl
const CC: ControllerModule = controllerImpl

const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  mk: string
  vaultId: string
}
const subkeys = await K.deriveSubkeys(B.fromHex(inputs.mk), B.fromHex(inputs.vaultId))

const CAPS: Capabilities = {
  vision: true,
  pdf: true,
  tools: true,
  reasoning: true,
  effort: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' },
  thinkingDisplay: 'summarized',
  sampling: [],
  prefill: false,
  forcedToolChoice: false,
  webSearch: null,
  midConversationSystem: true,
  toolChanges: true,
  refusalFallback: 'default',
  contextWindow: 1_000_000,
  maxOutput: 128_000,
  cost: null,
}
const MODEL: ModelRef = { provider: 'pa', id: 'claude-opus-5-5' }
const SIGNATURE = 'EqRjehDKyWXShDu1xHA+CFjvnfMnMgBfL0kSXEeKOVwMdKZjmIqbH78OXUWmfKI0Hfd45lTIoIJ0i15aumMAX'

/** Marks the point where a scripted stream waits for `release()` or the abort. */
const PAUSE = Symbol('pause')
type Step = ChatEvent | typeof PAUSE

const finish: ChatEvent = { type: 'finish', stop: 'end', raw: 'end_turn' }
const answer = (text: string): Step[] => [
  { type: 'reasoning-delta', id: 'r', text: 'Thinking it over.' },
  { type: 'reasoning-end', id: 'r', providerMeta: { anthropic: { type: 'thinking', signature: SIGNATURE } } },
  { type: 'text-delta', id: 't', text: text.slice(0, 3) },
  PAUSE,
  { type: 'text-delta', id: 't', text: text.slice(3) },
  { type: 'usage', usage: { input: 20, output: 7 } },
  finish,
]

class ScriptedAdapter implements ChatAdapter {
  readonly kind = 'anthropic' as const
  readonly requests: ChatRequest[] = []
  readonly scripts: Step[][] = []
  private releases: (() => void)[] = []
  private waiting: (() => void)[] = []

  async *stream(request: ChatRequest): AsyncIterable<ChatEvent> {
    this.requests.push(request)
    const script = this.scripts.shift() ?? [{ type: 'text-delta', id: 't', text: 'ok' }, finish]
    for (const step of script) {
      if (request.signal.aborted) return
      if (step === PAUSE) {
        await new Promise<void>((resolve) => {
          this.releases.push(resolve)
          request.signal.addEventListener('abort', () => resolve(), { once: true })
          for (const w of this.waiting.splice(0)) w()
        })
        if (request.signal.aborted) return
        continue
      }
      yield step
    }
  }

  /** Resolves once a stream is paused. */
  paused(): Promise<void> {
    if (this.releases.length > 0) return Promise.resolve()
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  release(): void {
    this.releases.shift()?.()
  }
}

class FakeClock implements Clock {
  t = 1_760_000_000_000
  now(): number {
    this.t += 1
    return this.t
  }
}

class FakeBlobs implements BlobPort {
  readonly stored = new Map<string, Uint8Array>()
  async put(bytes: Uint8Array): Promise<string> {
    const id = B.base32Encode((await K.sha256(bytes)).slice(0, 16))
    this.stored.set(id, bytes.slice())
    return id
  }
  async get(id: string) {
    const b = this.stored.get(id)
    return b ? b.slice() : null
  }
}

class Holds {
  readonly active: string[] = []
  readonly taken: string[] = []
  locking = false
  hold = (reason: string) => {
    if (this.locking) throw new InvalidStateError('locking')
    this.active.push(reason)
    this.taken.push(reason)
    let done = false
    return () => {
      if (done) return
      done = true
      this.active.splice(this.active.indexOf(reason), 1)
    }
  }
}

/** Holds the workspace's saves while `held` is set: a run then stays between its commit and its end. */
class FlushGate {
  private gate: PromiseWithResolvers<void> | null = null
  hold(): void {
    this.gate = Promise.withResolvers<void>()
  }
  open(): void {
    this.gate?.resolve()
    this.gate = null
  }
  wrap(ws: Workspace): Workspace {
    return new Proxy(ws, {
      get: (target, key, receiver) => {
        if (key !== 'flush') return Reflect.get(target, key, receiver)
        return async () => {
          await this.gate?.promise
          return target.flush()
        }
      },
    })
  }
}

/** Resolves at the next answer committed in `conv`. */
const nextCommit = (chat: ChatController, conv: Id) =>
  new Promise<void>((resolve) => {
    const stop = chat.subscribe((event, id) => {
      if (event !== 'commit' || id !== conv) return
      stop()
      resolve()
    })
  })

let count = 0
async function setup(options: { key?: string | null; flushes?: FlushGate } = {}) {
  const db = await S.openLocalDb({ name: `chat-${++count}-${crypto.randomUUID()}` })
  const store = S.createLocalStore({ db, subkeys, rng: R.cryptoRng() })
  const clock = new FakeClock()
  const opened: Workspace = await W.openWorkspace({ store, subkeys, rng: R.cryptoRng(), clock })
  const ws = options.flushes ? options.flushes.wrap(opened) : opened
  const adapter = new ScriptedAdapter()
  const lock = new Holds()
  const reload = new Holds()
  const blobs = new FakeBlobs()
  const key = options.key === undefined ? 'sk-ant-test' : options.key
  const keys: ProviderKeys = {
    get: async (id) => (id === 'pa' ? key : null),
    set: async () => {},
    delete: async () => {},
    list: async () => (key ? ['pa'] : []),
  }
  const descriptor: ModelDescriptor = { ref: MODEL, kind: 'anthropic', name: 'Claude Opus 5.5', capabilities: CAPS }
  const deps: ChatDeps = {
    workspace: ws,
    holdLock: lock.hold,
    holdReload: reload.hold,
    adapter: () => adapter,
    keys,
    resolveModel: (ref) => (ref.provider === MODEL.provider && ref.id === MODEL.id ? descriptor : null),
    blobs,
    rng: R.cryptoRng(),
    clock,
  }
  const chat: ChatController = CC.createChatController(deps)
  const conv = ws.conversations.create({ model: MODEL, system: 'Be brief.' })
  return { ws, adapter, lock, reload, blobs, chat, conv, store }
}

const text = (t: string): Extract<Part, { type: 'text' }> => ({ type: 'text', text: t })
const leafOf = (ws: Workspace, conv: Id) => ws.conversations.get(conv)?.leaf ?? null

describe('a turn', () => {
  test('commits the user message at once, streams in memory, then commits the answer once', async () => {
    const { ws, adapter, chat, conv, lock, reload } = await setup()
    adapter.scripts.push(answer('Yes, it is.'))
    const turn = await chat.send(conv, [text('Is 1009 prime?')])
    const thread = await ws.thread(conv)
    const userId = turn.userMessageId as Id
    expect(thread.get(userId)).toMatchObject({
      role: 'user',
      parent: null,
      parts: [text('Is 1009 prime?')],
      status: 'done',
    })
    expect(leafOf(ws, conv)).toBe(userId)
    expect(ws.conversations.get(conv)?.title).toBe('Is 1009 prime?')

    await adapter.paused()
    const live = chat.stream(conv)
    expect(live).toMatchObject({ conversationId: conv, parentId: userId, model: MODEL, effort: 'medium', queued: 0 })
    expect(live?.parts).toEqual([
      {
        type: 'reasoning',
        text: 'Thinking it over.',
        providerMeta: { anthropic: { type: 'thinking', signature: SIGNATURE } },
      },
      text('Yes'),
    ])
    expect(thread.get(live?.messageId as Id)).toBeUndefined()
    expect(chat.streaming()).toEqual([conv])
    expect(lock.active).toEqual(['chat-stream'])
    expect(reload.active).toEqual(['chat-stream'])

    adapter.release()
    const committed = (await turn.done) as Message
    expect(committed.id).toBe(live?.messageId as Id)
    expect(committed).toMatchObject({
      role: 'assistant',
      parent: userId,
      model: MODEL,
      status: 'done',
      stop: 'end',
      effort: 'medium',
      usage: { input: 20, output: 7 },
    })
    expect(committed.parts).toEqual([
      {
        type: 'reasoning',
        text: 'Thinking it over.',
        providerMeta: { anthropic: { type: 'thinking', signature: SIGNATURE } },
      },
      text('Yes, it is.'),
    ])
    expect(leafOf(ws, conv)).toBe(committed.id)
    expect(chat.stream(conv)).toBeNull()
    expect(lock.active).toEqual([])
    expect(reload.active).toEqual([])
    expect(ws.persistence().unsaved).toBe(0)
  })

  test('the request carries the frozen system, the key, the explicit effort and the planned path', async () => {
    const { adapter, chat, conv, ws } = await setup()
    ws.conversations.update(conv, { effort: 'xhigh' })
    const turn = await chat.send(conv, [text('Hello')])
    await turn.done
    const request = adapter.requests[0] as ChatRequest
    expect(request.system).toBe('Be brief.')
    expect(request.apiKey).toBe('sk-ant-test')
    expect(request.effort).toBe('xhigh')
    expect(request.model.ref).toEqual(MODEL)
    expect(request.messages).toEqual([{ role: 'user', parts: [text('Hello')] }])
    expect(request.tools).toEqual([])
  })

  test('the second turn replays the first answer, reasoning and signature included', async () => {
    const { adapter, chat, conv } = await setup()
    adapter.scripts.push(answer('Yes, it is.'))
    const first = await chat.send(conv, [text('Is 1009 prime?')])
    await adapter.paused()
    adapter.release()
    await first.done
    await (await chat.send(conv, [text('And 1013?')])).done
    expect((adapter.requests[1] as ChatRequest).messages).toEqual([
      { role: 'user', parts: [text('Is 1009 prime?')] },
      {
        role: 'assistant',
        parts: [
          {
            type: 'reasoning',
            text: 'Thinking it over.',
            providerMeta: { anthropic: { type: 'thinking', signature: SIGNATURE } },
          },
          text('Yes, it is.'),
        ],
      },
      { role: 'user', parts: [text('And 1013?')] },
    ])
  })
})

describe('outcomes', () => {
  test('a refusal commits no parts, with its category, and is left out of the next request', async () => {
    const { ws, adapter, chat, conv } = await setup()
    adapter.scripts.push([
      { type: 'text-delta', id: 't', text: 'Here is how the first stage' },
      { type: 'finish', stop: 'refusal', raw: 'refusal', refusal: { category: 'cyber', explanation: 'Declined.' } },
    ])
    const m = (await (await chat.send(conv, [text('Something risky')])).done) as Message
    expect(m).toMatchObject({
      status: 'refused',
      parts: [],
      stop: 'refusal',
      refusal: { category: 'cyber', explanation: 'Declined.' },
    })
    expect(leafOf(ws, conv)).toBe(m.id)
    await (await chat.send(conv, [text('Something else')])).done
    expect((adapter.requests[1] as ChatRequest).messages.map((x) => x.role)).toEqual(['user', 'user'])
  })

  test('an error keeps the partial parts and the error code', async () => {
    const { adapter, chat, conv, lock } = await setup()
    adapter.scripts.push([
      { type: 'text-delta', id: 't', text: 'Let me walk through' },
      { type: 'error', error: { code: 'overloaded', message: 'Overloaded', retryable: true } },
    ])
    const m = (await (await chat.send(conv, [text('Explain')])).done) as Message
    expect(m).toMatchObject({
      status: 'error',
      parts: [text('Let me walk through')],
      error: { code: 'overloaded', message: 'Overloaded' },
    })
    expect(lock.active).toEqual([])
  })

  test('stop commits what arrived so far as stopped and releases the holds', async () => {
    const { adapter, chat, conv, lock, reload } = await setup()
    adapter.scripts.push(answer('Yes, it is.'))
    const turn = await chat.send(conv, [text('Is 1009 prime?')])
    await adapter.paused()
    chat.stop(conv)
    const m = (await turn.done) as Message
    expect(m.status).toBe('stopped')
    expect(m.parts.at(-1)).toEqual(text('Yes'))
    expect(lock.active).toEqual([])
    expect(reload.active).toEqual([])
    chat.stop(conv)
  })

  test('a stream that ends without finish or error commits as an error', async () => {
    const { adapter, chat, conv } = await setup()
    adapter.scripts.push([{ type: 'text-delta', id: 't', text: 'cut' }])
    const m = (await (await chat.send(conv, [text('Go')])).done) as Message
    expect(m.status).toBe('error')
    expect(m.error?.code).toBe('truncated')
  })

  test('a branch switch during the stream wins over the commit', async () => {
    const { ws, adapter, chat, conv } = await setup()
    const first = await chat.send(conv, [text('One')])
    await first.done
    const firstUser = first.userMessageId as Id
    adapter.scripts.push(answer('Two, then.'))
    await chat.send(conv, [text('Two')])
    await adapter.paused()
    const thread = await ws.thread(conv)
    thread.setLeaf(firstUser)
    adapter.release()
    await new Promise((resolve) => chat.subscribe((event) => event === 'commit' && resolve(null)))
    expect(leafOf(ws, conv)).toBe(firstUser)
  })

  test('dispose stops every stream and resolves once all are committed', async () => {
    const { ws, adapter, chat, conv } = await setup()
    const other = ws.conversations.create({ model: MODEL })
    adapter.scripts.push(answer('aaaa'), answer('bbbb'))
    const t1 = await chat.send(conv, [text('one')])
    const t2 = await chat.send(other, [text('two')])
    await adapter.paused()
    await chat.dispose()
    expect(((await t1.done) as Message).status).toBe('stopped')
    expect(((await t2.done) as Message).status).toBe('stopped')
    expect(chat.streaming()).toEqual([])
  })
})

describe('queue, regenerate and edit', () => {
  test('a message sent during a stream waits, then follows the committed answer', async () => {
    const { ws, adapter, chat, conv } = await setup()
    adapter.scripts.push(answer('First answer'))
    const first = await chat.send(conv, [text('First')])
    await adapter.paused()
    const second = await chat.send(conv, [text('Second')])
    expect(chat.stream(conv)?.queued).toBe(1)
    expect(adapter.requests).toHaveLength(1)
    adapter.release()
    const a1 = (await first.done) as Message
    const a2 = (await second.done) as Message
    const thread = await ws.thread(conv)
    expect(thread.get(second.userMessageId as Id)?.parent).toBe(a1.id)
    expect(a2.parent).toBe(second.userMessageId as Id)
    expect((adapter.requests[1] as ChatRequest).messages.map((x) => x.role)).toEqual(['user', 'assistant', 'user'])
  })

  test('a message sent while the committed answer is saving starts once it is saved, never queued unseen', async () => {
    const flushes = new FlushGate()
    const { ws, chat, conv } = await setup({ flushes })
    flushes.hold()
    const committed = nextCommit(chat, conv)
    const first = await chat.send(conv, [text('First')])
    await committed
    // The answer is in the thread and no stream shows: the conversation looks idle while the run waits for the save.
    expect(chat.stream(conv)).toBeNull()
    const sending = chat.send(conv, [text('Second')])
    flushes.open()
    const second = await sending
    const thread = await ws.thread(conv)
    // When `send` resolves, the message is on the thread and its answer streams: nothing waits out of sight.
    expect(thread.get(second.userMessageId as Id)?.parent).toBe(((await first.done) as Message).id)
    expect(chat.stream(conv)).toMatchObject({ parentId: second.userMessageId as Id, queued: 0 })
    await second.done
  })

  test('regenerate and edit while the committed answer is saving wait for it instead of refusing', async () => {
    const flushes = new FlushGate()
    const { chat, conv } = await setup({ flushes })
    flushes.hold()
    let committed = nextCommit(chat, conv)
    const first = await chat.send(conv, [text('Q')])
    await committed
    const regenerating = chat.regenerate(conv, first.userMessageId as Id)
    flushes.open()
    const a1 = (await first.done) as Message
    const again = await regenerating
    const a2 = (await again.done) as Message
    expect(a2.parent).toBe(a1.parent as Id)

    flushes.hold()
    committed = nextCommit(chat, conv)
    const retry = await chat.regenerate(conv, a2.id)
    await committed
    const editing = chat.edit(conv, first.userMessageId as Id, [text('Q, edited')])
    flushes.open()
    await retry.done
    const edited = await editing
    expect(((await edited.done) as Message).parent).toBe(edited.userMessageId as Id)
  })

  test('stop cancels the queued turns', async () => {
    const { ws, adapter, chat, conv } = await setup()
    adapter.scripts.push(answer('First answer'))
    await chat.send(conv, [text('First')])
    await adapter.paused()
    const queued = await chat.send(conv, [text('Second')])
    chat.stop(conv)
    expect(await queued.done).toBeNull()
    const thread = await ws.thread(conv)
    expect(thread.get(queued.userMessageId as Id)).toBeUndefined()
  })

  test('regenerate adds a sibling answer and sends the path up to the user message', async () => {
    const { ws, adapter, chat, conv } = await setup()
    const turn = await chat.send(conv, [text('Q')])
    const a1 = (await turn.done) as Message
    const again = await chat.regenerate(conv, a1.id)
    expect(again.userMessageId).toBeNull()
    const a2 = (await again.done) as Message
    expect(a2.parent).toBe(a1.parent as Id)
    expect(a2.id).not.toBe(a1.id)
    const thread = await ws.thread(conv)
    expect(thread.siblings(a2.id).messages.map((m) => m.id)).toEqual([a1.id, a2.id])
    expect(leafOf(ws, conv)).toBe(a2.id)
    expect((adapter.requests[1] as ChatRequest).messages).toEqual([{ role: 'user', parts: [text('Q')] }])
  })

  test('regenerate refuses while a stream runs', async () => {
    const { adapter, chat, conv } = await setup()
    const a1 = (await (await chat.send(conv, [text('Q')])).done) as Message
    adapter.scripts.push(answer('Again'))
    await chat.regenerate(conv, a1.id)
    await adapter.paused()
    await expect(chat.regenerate(conv, a1.id)).rejects.toBeInstanceOf(InvalidStateError)
    adapter.release()
  })

  test('edit creates a sibling user message on a new branch; the old branch is not sent', async () => {
    const { ws, adapter, chat, conv } = await setup()
    const first = await chat.send(conv, [text('Original question')])
    await first.done
    const edited = await chat.edit(conv, first.userMessageId as Id, [text('Edited question')])
    await edited.done
    const thread = await ws.thread(conv)
    expect(thread.get(edited.userMessageId as Id)?.parent).toBeNull()
    expect(thread.siblings(edited.userMessageId as Id).index).toBe(1)
    expect(thread.get(first.userMessageId as Id)?.parts).toEqual([text('Original question')])
    expect(JSON.stringify((adapter.requests[1] as ChatRequest).messages)).not.toContain('Original question')
  })
})

describe('turns that cannot start write nothing', () => {
  test.each([
    ['no model', InvalidStateError, { model: null }],
    ['an unknown model', InvalidInputError, { model: { provider: 'pa', id: 'nope' } }],
    ['an unknown provider', InvalidInputError, { model: { provider: 'zz', id: 'claude-opus-5-5' } }],
  ] as const)('%s', async (_, error, patch) => {
    const { ws, chat, conv, adapter } = await setup()
    ws.conversations.update(conv, patch)
    await expect(chat.send(conv, [text('Hi')])).rejects.toBeInstanceOf(error)
    expect((await ws.thread(conv)).all()).toEqual([])
    expect(adapter.requests).toEqual([])
  })

  test('no key, empty parts, a locking vault', async () => {
    const noKey = await setup({ key: null })
    await expect(noKey.chat.send(noKey.conv, [text('Hi')])).rejects.toBeInstanceOf(InvalidInputError)
    expect((await noKey.ws.thread(noKey.conv)).all()).toEqual([])
    const { ws, chat, conv, lock } = await setup()
    await expect(chat.send(conv, [])).rejects.toBeInstanceOf(InvalidInputError)
    lock.locking = true
    await expect(chat.send(conv, [text('Hi')])).rejects.toBeInstanceOf(InvalidStateError)
    expect((await ws.thread(conv)).all()).toEqual([])
  })
})

describe('system changes and large parts', () => {
  test('appendSystem edits the prompt before the first message, appends a system message after', async () => {
    const { ws, adapter, chat, conv } = await setup()
    expect(await chat.appendSystem(conv, 'You are a pirate.')).toBeNull()
    expect(ws.conversations.get(conv)?.system).toBe('You are a pirate.')
    await (await chat.send(conv, [text('Hi')])).done
    const id = (await chat.appendSystem(conv, 'Now answer in French.')) as Id
    const thread = await ws.thread(conv)
    expect(thread.get(id)).toMatchObject({ role: 'system', parts: [text('Now answer in French.')] })
    expect(leafOf(ws, conv)).toBe(id)
    expect(ws.conversations.get(conv)?.system).toBe('You are a pirate.')
    await (await chat.send(conv, [text('Hello?')])).done
    const request = adapter.requests[1] as ChatRequest
    expect(request.system).toBe('You are a pirate.')
    expect(request.messages.map((x) => x.role)).toEqual(['user', 'assistant', 'system', 'user'])
  })

  test('a part over 16 KiB is committed as a ref to a blob and sent in full', async () => {
    const { ws, adapter, chat, conv, blobs } = await setup()
    const long = 'x'.repeat(20_000)
    adapter.scripts.push([{ type: 'text-delta', id: 't', text: long }, finish])
    const m = (await (await chat.send(conv, [text('Write a lot')])).done) as Message
    expect(m.parts).toHaveLength(1)
    const ref = m.parts[0] as Extract<Part, { type: 'ref' }>
    expect(ref.type).toBe('ref')
    expect(ref.partType).toBe('text')
    const stored = blobs.stored.get(ref.blob) as Uint8Array
    expect(ref.size).toBe(stored.length)
    expect(JSON.parse(B.fromUtf8(stored))).toEqual(text(long))
    const state = await ws.state(await ws.conversations.shardOf(conv))
    expect(state.length).toBeLessThan(10_000)
    await (await chat.send(conv, [text('Thanks')])).done
    expect((adapter.requests[1] as ChatRequest).messages[1]).toEqual({ role: 'assistant', parts: [text(long)] })
  })
})
