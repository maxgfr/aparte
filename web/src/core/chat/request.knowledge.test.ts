/*
 * Retrieved context in a request (web/src/core/contracts/chat.ts, rule 6): a `knowledge` part of a user message is
 * sent as the delimited passages, in the user turn, and the frozen system prompt never sees it.
 */
import { describe, expect, test } from 'bun:test'
import type { Capabilities } from '../contracts/ai.ts'
import type { Conversation, KnowledgePassage, Message, Part } from '../contracts/workspace.ts'
import { formatPassages } from '../knowledge/context.ts'
import { planPrompt } from './request.ts'

const CAPS = {
  vision: true,
  pdf: true,
  tools: true,
  reasoning: false,
  effort: { levels: [], default: null },
  sampling: [],
  prefill: false,
  forcedToolChoice: false,
  webSearch: null,
  midConversationSystem: false,
  toolChanges: false,
  contextWindow: 100_000,
  maxOutput: 4096,
  cost: null,
} as unknown as Capabilities

const CONV = { id: 'c', system: 'Be brief.', tools: [] } as unknown as Conversation

const passage: KnowledgePassage = {
  id: 'abcdef-1',
  base: 'b',
  document: 'notes.pdf',
  blob: 'abcdefabcdefabcdefabcdefab',
  page: 2,
  text: 'Herons eat fish.',
}

const message = (id: string, role: Message['role'], parts: Part[]): Message => ({
  id,
  conv: 'c',
  parent: null,
  role,
  parts,
  model: null,
  createdAt: Number(id.slice(1)),
  status: 'done',
})

describe('knowledge parts', () => {
  test('a user turn sends its passages as one delimited text before the question; the system prompt is untouched', () => {
    const knowledge: Part = { type: 'knowledge', query: 'What do herons eat?', passages: [passage] }
    const plan = planPrompt({
      conversation: CONV,
      path: [message('m1', 'user', [knowledge, { type: 'text', text: 'What do herons eat?' }])],
      kind: 'anthropic',
      capabilities: CAPS,
    })
    expect(plan.system).toBe('Be brief.')
    expect(plan.messages).toEqual([
      {
        role: 'user',
        from: 'm1',
        parts: [
          { type: 'text', text: formatPassages([passage]) },
          { type: 'text', text: 'What do herons eat?' },
        ],
      },
    ])
  })

  test('a knowledge part anywhere but a user message is never sent', () => {
    const plan = planPrompt({
      conversation: CONV,
      path: [
        message('m1', 'user', [{ type: 'text', text: 'Hi' }]),
        message('m2', 'assistant', [
          { type: 'knowledge', query: 'q', passages: [passage] },
          { type: 'text', text: 'Hello' },
        ]),
        message('m3', 'user', [{ type: 'text', text: 'More' }]),
      ],
      kind: 'openai',
      capabilities: CAPS,
    })
    expect(JSON.stringify(plan)).not.toContain('Herons eat fish.')
  })

  test('the same path always gives the same bytes', () => {
    const path = [
      message('m1', 'user', [
        { type: 'knowledge', query: 'q', passages: [passage] },
        { type: 'text', text: 'q' },
      ]),
    ]
    const a = planPrompt({ conversation: CONV, path, kind: 'google', capabilities: CAPS })
    const b = planPrompt({ conversation: CONV, path: structuredClone(path), kind: 'google', capabilities: CAPS })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})
