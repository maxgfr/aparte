/*
 * Beam over the real workspace with a scripted adapter: one user message answered by several models in parallel,
 * every answer a committed sibling, requests built like a regeneration, a merge committed with its text only, the
 * holds released once everything is saved, and nothing written for a beam that cannot start.
 */
import { describe, expect, test } from 'bun:test'
import type { Capabilities, ChatAdapter, ChatEvent, ChatRequest, ModelDescriptor } from '../contracts/ai.ts'
import { InvalidInputError, InvalidStateError } from '../contracts/crypto.ts'
import type { BlobPort, ModelRef, Part } from '../contracts/workspace.ts'
import { cryptoRng } from '../crypto/rng.ts'
import { eventually, setup } from '../workspace/testkit.ts'
import { type BeamDeps, createBeamEngine, fusionPrompt, MAX_BEAM } from './beam.ts'

const CAPS: Capabilities = {
  vision: true,
  pdf: true,
  tools: true,
  reasoning: true,
  effort: { levels: ['low', 'medium', 'high'], default: 'medium' },
  thinkingDisplay: 'summarized',
  sampling: [],
  prefill: false,
  forcedToolChoice: false,
  webSearch: null,
  midConversationSystem: true,
  toolChanges: true,
  refusalFallback: 'default',
  contextWindow: 200_000,
  maxOutput: 64_000,
  cost: null,
}

const A: ModelRef = { provider: 'pa', id: 'model-a' }
const B: ModelRef = { provider: 'pa', id: 'model-b' }
const C: ModelRef = { provider: 'pa', id: 'model-c' }
const SIGNATURE = 'c2lnbmVkLW92ZXItdGhlLXByZWZpeA'

const finish: ChatEvent = { type: 'finish', stop: 'end', raw: 'end_turn' }

/** Answers by model id; a model listed in `gate` waits until the test opens it. */
class ByModelAdapter implements ChatAdapter {
  readonly kind = 'anthropic' as const
  readonly requests: ChatRequest[] = []
  readonly gates = new Map<string, () => void>()
  constructor(
    private readonly scripts: Record<string, ChatEvent[]>,
    private readonly gated: Set<string> = new Set(),
  ) {}

  async *stream(request: ChatRequest): AsyncIterable<ChatEvent> {
    this.requests.push(request)
    const id = request.model.ref.id
    if (this.gated.has(id)) {
      await new Promise<void>((resolve) => {
        this.gates.set(id, resolve)
        request.signal.addEventListener('abort', () => resolve(), { once: true })
      })
      if (request.signal.aborted) return
    }
    for (const event of this.scripts[id] ?? [{ type: 'text-delta', id: 't', text: `${id} says hi` }, finish]) {
      if (request.signal.aborted) return
      yield event
    }
  }
}

function memoryBlobs(): BlobPort & { readonly map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>()
  return {
    map,
    async put(bytes) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
      const id = [...digest.slice(0, 13)]
        .map((b) => 'abcdefghijklmnopqrstuvwxyz234567'[b % 32])
        .join('')
        .padEnd(26, 'a')
      map.set(id, new Uint8Array(bytes))
      return id
    },
    async get(id) {
      return (map.get(id) as never) ?? null
    },
  }
}

async function context(adapter: ByModelAdapter) {
  const ctx = await setup()
  const holds: string[] = []
  const released: string[] = []
  const resolveModel = (ref: ModelRef): ModelDescriptor | null =>
    ref.id === 'unknown' ? null : { ref, kind: 'anthropic', name: ref.id.toUpperCase(), capabilities: CAPS }
  const deps: BeamDeps = {
    workspace: ctx.ws,
    holdLock: (reason) => {
      holds.push(`lock:${reason}`)
      return () => released.push(`lock:${reason}`)
    },
    holdReload: (reason) => {
      holds.push(`reload:${reason}`)
      return () => released.push(`reload:${reason}`)
    },
    adapter: () => adapter,
    keys: { get: async () => 'test-key', list: async () => [], set: async () => {}, delete: async () => {} },
    resolveModel,
    blobs: memoryBlobs(),
    rng: cryptoRng(),
    clock: ctx.clock,
  }
  const conversation = ctx.ws.conversations.create({ model: A, system: 'Be brief.' })
  return { ...ctx, deps, engine: createBeamEngine(deps), conversation, holds, released }
}

const text = (t: string): Part[] => [{ type: 'text', text: t }]

describe('Beam', () => {
  test('one user message, one committed sibling answer per model, requested like a regeneration', async () => {
    const adapter = new ByModelAdapter({
      'model-a': [
        { type: 'reasoning-delta', id: 'r', text: 'Hmm.' },
        { type: 'reasoning-end', id: 'r', providerMeta: { anthropic: { type: 'thinking', signature: SIGNATURE } } },
        { type: 'text-delta', id: 't', text: 'Paris.' },
        { type: 'usage', usage: { input: 12, output: 3 } },
        finish,
      ],
      'model-b': [{ type: 'text-delta', id: 't', text: 'It is Paris.' }, finish],
    })
    const { ws, engine, conversation, holds, released } = await context(adapter)
    const state = await engine.start(conversation, text('Capital of France?'), [A, B])
    expect(state.candidates.map((c) => c.model.id)).toEqual(['model-a', 'model-b'])
    await eventually(() => engine.state(conversation)?.running === false)

    const thread = await ws.thread(conversation)
    const user = thread.get(state.userMessageId)
    expect(user?.role).toBe('user')
    expect(ws.conversations.get(conversation)?.title).toBe('Capital of France?')
    const answers = thread.children(state.userMessageId)
    expect(answers.map((m) => m.model?.id).sort()).toEqual(['model-a', 'model-b'])
    expect(answers.every((m) => m.role === 'assistant' && m.status === 'done')).toBe(true)
    const a = answers.find((m) => m.model?.id === 'model-a')
    // The reasoning stays with its signature: it was produced over exactly the stored prefix.
    expect(a?.parts[0]).toEqual({
      type: 'reasoning',
      text: 'Hmm.',
      providerMeta: { anthropic: { type: 'thinking', signature: SIGNATURE } },
    })
    expect(a?.usage).toEqual({ input: 12, output: 3 })
    // The leaf moved to one of them; the other is its sibling.
    const leaf = ws.conversations.get(conversation)?.leaf
    expect(answers.map((m) => m.id)).toContain(leaf as string)

    // Both requests are the plain regeneration request: the frozen system, the path to the user message.
    expect(adapter.requests).toHaveLength(2)
    for (const r of adapter.requests) {
      expect(r.system).toBe('Be brief.')
      expect(r.messages.map((m) => m.role)).toEqual(['user'])
      expect(r.messages[0]?.parts).toEqual([{ type: 'text', text: 'Capital of France?' }])
      expect(r.effort).toBe('medium')
    }
    await eventually(() => released.length === 2)
    expect(holds).toEqual(['lock:chat-beam', 'reload:chat-beam'])
  })

  test('a merge is a sibling with its text only, requested with the answers appended to the last user turn', async () => {
    const adapter = new ByModelAdapter({
      'model-a': [{ type: 'text-delta', id: 't', text: 'Answer one.' }, finish],
      'model-b': [{ type: 'text-delta', id: 't', text: 'Answer two.' }, finish],
      'model-c': [
        { type: 'reasoning-delta', id: 'r', text: 'Weighing both.' },
        { type: 'reasoning-end', id: 'r', providerMeta: { anthropic: { type: 'thinking', signature: SIGNATURE } } },
        { type: 'text-delta', id: 't', text: 'The merged answer.' },
        finish,
      ],
    })
    const { ws, engine, conversation } = await context(adapter)
    const state = await engine.start(conversation, text('Question?'), [A, B])
    await eventually(() => engine.state(conversation)?.running === false)
    const merged = await engine.fuse(conversation, C)
    expect(merged.parent).toBe(state.userMessageId)
    expect(merged.model).toEqual(C)
    expect(merged.parts).toEqual([{ type: 'text', text: 'The merged answer.' }])
    expect(ws.conversations.get(conversation)?.leaf).toBe(merged.id)
    const request = adapter.requests.at(-1) as ChatRequest
    expect(request.tools).toEqual([])
    const last = request.messages.at(-1)
    const answers = adapter.requests
      .slice(0, 2)
      .map((r) => (r.model.ref.id === 'model-a' ? 'Answer one.' : 'Answer two.'))
    expect(last?.parts).toEqual([
      { type: 'text', text: 'Question?' },
      { type: 'text', text: fusionPrompt(answers) },
    ])
    expect(engine.state(conversation)?.fusion?.status).toBe('done')
    // Picking another answer moves the branch view there.
    const other = (await ws.thread(conversation)).children(state.userMessageId)[0]
    await engine.pick(conversation, other?.id as string)
    expect(ws.conversations.get(conversation)?.leaf).toBe(other?.id as string)
  })

  test('stop commits the streams as stopped; a merge of fewer than two answers is refused', async () => {
    const adapter = new ByModelAdapter({}, new Set(['model-a', 'model-b']))
    const { ws, engine, conversation } = await context(adapter)
    const state = await engine.start(conversation, text('Wait.'), [A, B])
    await eventually(() => adapter.gates.size === 2)
    await expect(engine.start(conversation, text('Again'), [A])).rejects.toThrow(InvalidStateError)
    engine.stop(conversation)
    await eventually(() => engine.state(conversation)?.running === false)
    const answers = (await ws.thread(conversation)).children(state.userMessageId)
    expect(answers.map((m) => m.status)).toEqual(['stopped', 'stopped'])
    await expect(engine.fuse(conversation, C)).rejects.toThrow(InvalidStateError)
    engine.close(conversation)
    expect(engine.state(conversation)).toBeNull()
  })

  test('nothing is written for a beam that cannot start', async () => {
    const adapter = new ByModelAdapter({})
    const { ws, engine, conversation, holds } = await context(adapter)
    await expect(engine.start(conversation, text('x'), [])).rejects.toThrow(InvalidInputError)
    await expect(engine.start(conversation, text('x'), [A, A])).rejects.toThrow(InvalidInputError)
    const many = Array.from({ length: MAX_BEAM + 1 }, (_, i) => ({ provider: 'pa', id: `m${i}` }))
    await expect(engine.start(conversation, text('x'), many)).rejects.toThrow(InvalidInputError)
    await expect(engine.start(conversation, text('x'), [A, { provider: 'pa', id: 'unknown' }])).rejects.toThrow(
      InvalidInputError,
    )
    await expect(engine.start(conversation, [], [A])).rejects.toThrow(InvalidInputError)
    expect((await ws.thread(conversation)).all()).toEqual([])
    expect(ws.conversations.get(conversation)?.startedAt).toBeUndefined()
    expect(holds).toEqual([])
    expect(adapter.requests).toEqual([])
  })

  test('more answers to a sent question are added as siblings; dispose stops and commits everything', async () => {
    const adapter = new ByModelAdapter({}, new Set(['model-c']))
    const { ws, engine, conversation } = await context(adapter)
    const state = await engine.start(conversation, text('Hello'), [A])
    await eventually(() => engine.state(conversation)?.running === false)
    await engine.answer(conversation, state.userMessageId, [C])
    expect(engine.state(conversation)?.candidates.map((c) => c.model.id)).toEqual(['model-a', 'model-c'])
    await eventually(() => adapter.gates.size === 1)
    await engine.dispose()
    const answers = (await ws.thread(conversation)).children(state.userMessageId)
    // Same timestamp (the test clock stands still): siblings then sort by id, so compare them by model.
    expect(answers.map((m) => [m.model?.id, m.status]).sort()).toEqual([
      ['model-a', 'done'],
      ['model-c', 'stopped'],
    ])
    await expect(engine.start(conversation, text('after'), [A])).rejects.toThrow(InvalidStateError)
  })
})
