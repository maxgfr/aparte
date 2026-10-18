/*
 * Request planning (web/src/core/contracts/chat.ts, RequestModule): the replay rules of spec/DATA-MODEL.md section 5.
 * The property that matters most is append-only: for any path, the plan of the path extended by new turns starts with
 * the plan of the path itself, so a signed thinking block always sees the prefix it was signed over.
 */
import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import type { Capabilities } from '../contracts/ai.ts'
import type { RequestModule } from '../contracts/chat.ts'
import { InvalidStateError } from '../contracts/crypto.ts'
import type { Conversation, Message, Part } from '../contracts/workspace.ts'
import * as requestImpl from './request.ts'

const Q: RequestModule = requestImpl

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
  webSearch: 'anthropic:web_search_20260209',
  midConversationSystem: true,
  toolChanges: true,
  refusalFallback: 'default',
  contextWindow: 1_000_000,
  maxOutput: 128_000,
  cost: null,
}

const CONV: Conversation = {
  id: 'conv',
  title: '',
  folder: null,
  persona: null,
  model: { provider: 'pa', id: 'claude-opus-5-5' },
  effort: null,
  leaf: null,
  system: 'Be brief.',
  tools: [],
  pinned: false,
  archived: false,
  createdAt: 1,
  updatedAt: 1,
  startedAt: 1,
}

let clock = 100
function m(role: Message['role'], parts: Part[], extra: Partial<Message> = {}): Message {
  clock += 10
  return {
    id: `m${clock}`,
    conv: 'conv',
    parent: null,
    role,
    parts,
    model: role === 'assistant' ? { provider: 'pa', id: 'claude-opus-5-5' } : null,
    createdAt: clock,
    status: 'done',
    ...extra,
  }
}
const text = (t: string): Part => ({ type: 'text', text: t })
const signed = (t: string, signature: string): Part => ({
  type: 'reasoning',
  text: t,
  providerMeta: { anthropic: { type: 'thinking', signature } },
})

/** Chains the messages through `parent`, as a path is. */
function chain(...messages: Message[]): Message[] {
  return messages.map((msg, i) => ({ ...msg, parent: i === 0 ? null : (messages[i - 1] as Message).id }))
}

const plan = (path: Message[], capabilities: Capabilities = CAPS, kind: 'anthropic' | 'openai' = 'anthropic') =>
  Q.planPrompt({ conversation: CONV, path, kind, capabilities })
const shape = (p: ReturnType<typeof plan>) => p.messages.map((x) => [x.role, x.parts])

describe('planPrompt', () => {
  test('sends the frozen system and the path, reasoning with its signature, in order', () => {
    const path = chain(
      m('user', [text('Is 1009 prime?')]),
      m('assistant', [signed('Checking primes up to 31.', 'sig-1'), text('Yes.')]),
      m('user', [text('And 1013?')]),
    )
    const p = plan(path)
    expect(p.system).toBe('Be brief.')
    expect(shape(p)).toEqual([
      ['user', [text('Is 1009 prime?')]],
      ['assistant', [signed('Checking primes up to 31.', 'sig-1'), text('Yes.')]],
      ['user', [text('And 1013?')]],
    ])
    expect(p.messages.map((x) => x.from)).toEqual(path.map((x) => x.id))
  })

  test('leaves out error and refused answers, and deleted messages', () => {
    const path = chain(
      m('user', [text('One')]),
      m('assistant', [text('partial')], { status: 'error', error: { code: 'overloaded', message: 'Overloaded' } }),
      m('user', [text('Two')]),
      m('assistant', [], { status: 'refused', refusal: { category: 'cyber' } }),
      m('user', [text('Three')]),
    )
    expect(shape(plan(path))).toEqual([
      ['user', [text('One')]],
      ['user', [text('Two')]],
      ['user', [text('Three')]],
    ])
  })

  test('a deletion strips the reasoning of the messages created before it, and only those', () => {
    const [u1, a1, u2, a2] = chain(
      m('user', [text('u1')]),
      m('assistant', [signed('r1', 's1'), text('a1')]),
      m('user', [text('u2')]),
      m('assistant', [signed('r2', 's2'), text('a2')]),
    ) as [Message, Message, Message, Message]
    const deletedAt = a2.createdAt + 5
    const u3 = { ...m('user', [text('u3')]), parent: a2.id }
    const a3 = { ...m('assistant', [signed('r3', 's3'), text('a3')]), parent: u3.id }
    const u4 = { ...m('user', [text('u4')]), parent: a3.id }
    expect(u3.createdAt).toBeGreaterThan(deletedAt)
    const path = [u1, { ...a1, deletedAt }, u2, a2, u3, a3, u4]
    expect(shape(plan(path))).toEqual([
      ['user', [text('u1')]],
      ['user', [text('u2')]],
      ['assistant', [text('a2')]],
      ['user', [text('u3')]],
      ['assistant', [signed('r3', 's3'), text('a3')]],
      ['user', [text('u4')]],
    ])
  })

  test('only the target kind sees reasoning and provider blocks', () => {
    const path = chain(
      m('user', [text('One')]),
      m('assistant', [
        signed('anthropic thinking', 'sig'),
        { type: 'reasoning', text: 'openai summary', providerMeta: { openai: { encrypted: 'enc' } } },
        { type: 'reasoning', text: 'display only' },
        {
          type: 'provider',
          provider: 'anthropic',
          block: { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
        },
        text('Two'),
      ]),
      m('user', [text('Three')]),
    )
    expect(plan(path).messages[1]?.parts).toEqual([
      signed('anthropic thinking', 'sig'),
      {
        type: 'provider',
        provider: 'anthropic',
        block: { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
      },
      text('Two'),
    ])
    expect(plan(path, CAPS, 'openai').messages[1]?.parts).toEqual([
      { type: 'reasoning', text: 'openai summary', providerMeta: { openai: { encrypted: 'enc' } } },
      text('Two'),
    ])
  })

  test('a stopped answer keeps its text and drops the tool calls that never ran', () => {
    const path = chain(
      m('user', [text('One')]),
      m('assistant', [text('Let me search'), { type: 'tool-call', callId: 'c1', name: 'search', input: { q: 'x' } }], {
        status: 'stopped',
      }),
      m('user', [text('Never mind')]),
    )
    expect(plan(path).messages[1]?.parts).toEqual([text('Let me search')])
    const empty = chain(
      m('user', [text('One')]),
      m('assistant', [{ type: 'tool-call', callId: 'c1', name: 'search', input: {} }], { status: 'stopped' }),
      m('user', [text('Two')]),
    )
    expect(plan(empty).messages.map((x) => x.role)).toEqual(['user', 'user'])
  })

  test('a system message stays one where supported, and becomes a delimited user turn elsewhere', () => {
    const path = chain(
      m('user', [text('Hi')]),
      m('assistant', [text('Hello.')]),
      m('system', [text('Answer in French.')]),
      m('user', [text('How are you?')]),
    )
    expect(plan(path).messages[2]).toMatchObject({ role: 'system', parts: [text('Answer in French.')] })
    expect(plan(path, { ...CAPS, midConversationSystem: false }).messages[2]).toMatchObject({
      role: 'user',
      parts: [text('<system-update>\nAnswer in French.\n</system-update>')],
    })
  })

  test('media a model cannot read becomes a placeholder', () => {
    const image: Part = { type: 'image', blob: 'b1', mediaType: 'image/jpeg', width: 10, height: 10, name: 'cat.jpg' }
    const pdf: Part = { type: 'file', blob: 'b2', mediaType: 'application/pdf', size: 100, name: 'paper.pdf' }
    const path = chain(m('user', [image, pdf, text('What is this?')]))
    expect(plan(path).messages[0]?.parts).toEqual([image, pdf, text('What is this?')])
    expect(plan(path, { ...CAPS, vision: false, pdf: false }).messages[0]?.parts).toEqual([
      text('[image omitted: cat.jpg]'),
      text('[document omitted: paper.pdf]'),
      text('What is this?'),
    ])
  })

  test('never ends with an assistant message, never empty', () => {
    const path = chain(m('user', [text('Hi')]), m('assistant', [text('Hello.')]))
    expect(() => plan(path)).toThrow(InvalidStateError)
    expect(() => plan([])).toThrow(InvalidStateError)
    expect(() => plan(chain(m('user', [text('x')]), m('assistant', [], { status: 'refused' })).slice(1))).toThrow(
      InvalidStateError,
    )
  })

  test('appending turns only appends to the plan', () => {
    const arbitraryTurn = fc.record({
      user: fc.string({ minLength: 1, maxLength: 20 }),
      status: fc.constantFrom('done', 'stopped', 'error', 'refused') as fc.Arbitrary<Message['status']>,
      reasoning: fc.boolean(),
      deleteUser: fc.boolean(),
      system: fc.option(fc.string({ minLength: 1, maxLength: 10 }), { nil: undefined }),
    })
    fc.assert(
      fc.property(fc.array(arbitraryTurn, { minLength: 1, maxLength: 6 }), fc.boolean(), (turns, midSystem) => {
        const caps = { ...CAPS, midConversationSystem: midSystem }
        const messages: Message[] = []
        let t = 1000
        const add = (msg: Omit<Message, 'parent' | 'createdAt' | 'conv' | 'model'>) => {
          t += 10
          messages.push({
            ...msg,
            conv: 'conv',
            model: null,
            createdAt: t,
            parent: messages.at(-1)?.id ?? null,
          })
        }
        const plans: string[][] = []
        turns.forEach((turn, i) => {
          if (turn.system !== undefined)
            add({ id: `s${i}`, role: 'system', parts: [text(turn.system)], status: 'done' })
          add({ id: `u${i}`, role: 'user', parts: [text(turn.user)], status: 'done' })
          const p = Q.planPrompt({ conversation: CONV, path: messages, kind: 'anthropic', capabilities: caps })
          plans.push(p.messages.map((x) => JSON.stringify([x.role, x.parts])))
          const parts: Part[] = turn.status === 'refused' ? [] : [text(`a${i}`)]
          if (turn.reasoning && turn.status !== 'refused') parts.unshift(signed(`r${i}`, `sig${i}`))
          add({ id: `a${i}`, role: 'assistant', parts, status: turn.status })
          if (turn.deleteUser && i > 0) {
            // A deletion of an earlier message: plans after it may differ, so the comparison restarts from here.
            const target = messages.findIndex((x) => x.id === `u${i - 1}`)
            messages[target] = { ...(messages[target] as Message), deletedAt: t + 1 }
            t += 2
            plans.length = 0
          }
        })
        for (let i = 1; i < plans.length; i++) {
          const before = plans[i - 1] as string[]
          expect((plans[i] as string[]).slice(0, before.length)).toEqual(before)
        }
      }),
    )
  })
})

describe('pickEffort', () => {
  const settings = (defaultEffort: Capabilities['effort']['default']) => ({ defaultEffort })
  test('the conversation, else the synced default, else the model default', () => {
    expect(Q.pickEffort({ effort: 'xhigh' }, settings('low'), CAPS)).toBe('xhigh')
    expect(Q.pickEffort({ effort: null }, settings('low'), CAPS)).toBe('low')
    expect(Q.pickEffort({ effort: null }, settings(null), CAPS)).toBe('medium')
  })

  test('a level the model lacks falls to the highest one below it, else its lowest', () => {
    const noXhigh: Capabilities = { ...CAPS, effort: { levels: ['low', 'medium', 'high', 'max'], default: 'high' } }
    expect(Q.pickEffort({ effort: 'xhigh' }, settings(null), noXhigh)).toBe('high')
    const lmh: Capabilities = { ...CAPS, effort: { levels: ['low', 'medium', 'high'], default: null } }
    expect(Q.pickEffort({ effort: 'none' }, settings(null), lmh)).toBe('low')
    expect(Q.pickEffort({ effort: null }, settings(null), lmh)).toBe('low')
  })

  test('null for a model without effort', () => {
    expect(
      Q.pickEffort({ effort: 'high' }, settings('high'), { ...CAPS, effort: { levels: [], default: null } }),
    ).toBeNull()
  })
})

describe('titleFrom', () => {
  test('the first non-empty line, collapsed, at most 60 characters', () => {
    expect(Q.titleFrom([text('\n\n  How do   I parse\tJSON?  \nsecond line')])).toBe('How do I parse JSON?')
    const long = 'word '.repeat(30)
    const title = Q.titleFrom([text(long)])
    expect([...title].length).toBeLessThanOrEqual(60)
    expect(title.endsWith('…')).toBe(true)
    expect(Q.titleFrom([{ type: 'image', blob: 'b', mediaType: 'image/png', width: 1, height: 1 }])).toBe('')
  })

  test('large parts are stored as blobs above 16 KiB', () => {
    expect(Q.LARGE_PART_BYTES).toBe(16384)
  })
})

describe('tool rounds (rules 7 and 8)', () => {
  const call = (callId: string, name = 'calculator'): Part => ({
    type: 'tool-call',
    callId,
    name,
    input: { expression: '1 + 1' },
  })
  const result = (callId: string, output: unknown = '2', name = 'calculator'): Part => ({
    type: 'tool-result',
    callId,
    name,
    output,
  })
  const interrupted = (callId: string, name = 'calculator'): Part => ({
    type: 'tool-result',
    callId,
    name,
    output: 'Not run: the app closed before this tool ran.',
    isError: true,
    details: { notRun: 'interrupted' },
  })

  test('a round is planned as the answer with its calls, their results, then the next answer', () => {
    const path = chain(
      m('user', [text('1 + 1?')]),
      m('assistant', [signed('Use the tool.', 'sig'), text('Computing.'), call('c1')], { stop: 'tool-calls' }),
      m('tool', [result('c1')]),
      m('assistant', [text('It is 2.')]),
      m('user', [text('Thanks')]),
    )
    expect(shape(plan(path))).toEqual([
      ['user', [text('1 + 1?')]],
      ['assistant', [signed('Use the tool.', 'sig'), text('Computing.'), call('c1')]],
      ['tool', [result('c1')]],
      ['assistant', [text('It is 2.')]],
      ['user', [text('Thanks')]],
    ])
    // The request for the next step ends with the results: never with an assistant message.
    expect(plan(path.slice(0, 3)).messages.at(-1)?.role).toBe('tool')
  })

  test('calls left without a result (the app closed mid-round) get the fixed interrupted result, in call order', () => {
    const path = chain(
      m('user', [text('Two sums')]),
      m('assistant', [call('c1'), call('c2', 'current_time')]),
      m('tool', [result('c2', 'noon', 'current_time')]),
      m('user', [text('Go on')]),
    )
    expect(shape(plan(path))[2]).toEqual(['tool', [result('c2', 'noon', 'current_time'), interrupted('c1')]])
    const none = chain(m('user', [text('One sum')]), m('assistant', [call('c1')]), m('user', [text('Hello?')]))
    expect(shape(plan(none))).toEqual([
      ['user', [text('One sum')]],
      ['assistant', [call('c1')]],
      ['tool', [interrupted('c1')]],
      ['user', [text('Hello?')]],
    ])
  })

  test('results of calls that are not right before them are left out, and so is a duplicate', () => {
    const failed = chain(
      m('user', [text('Sum')]),
      m('assistant', [call('c1')], { status: 'error' }),
      m('tool', [result('c1')]),
      m('user', [text('Again')]),
    )
    expect(plan(failed).messages.map((x) => x.role)).toEqual(['user', 'user'])
    const mixed = chain(
      m('user', [text('Sum')]),
      m('assistant', [call('c1')]),
      m('tool', [result('zz'), result('c1', '2'), result('c1', 'again')]),
    )
    expect(shape(plan(mixed))[2]).toEqual(['tool', [result('c1', '2')]])
  })

  test('appending rounds only appends to the plan', () => {
    const path = chain(
      m('user', [text('Sum')]),
      m('assistant', [signed('t', 's1'), call('c1')]),
      m('tool', [result('c1')]),
      m('assistant', [signed('t2', 's2'), call('c2')]),
      m('tool', [result('c2')]),
      m('assistant', [text('Done.')]),
      m('user', [text('More')]),
    )
    for (const end of [3, 5, 7]) {
      const shorter = shape(plan(path.slice(0, end)))
      expect(shape(plan(path)).slice(0, shorter.length)).toEqual(shorter)
    }
  })
})
