/*
 * Request planning (RequestModule in web/src/core/contracts/chat.ts): the replay rules of spec/DATA-MODEL.md section 5.
 *
 * Invariants:
 * - A plan is a pure function of the conversation's frozen `system`, the committed messages of the path, the target
 *   provider kind and the model's capabilities. Every rule looks only at a message and at the messages before it, so
 *   appending turns to a path only appends to its plan: a signed reasoning block always sees the prefix it was signed
 *   over.
 * - Parts are passed through as the same objects, never copied or reformatted: `providerMeta` reaches the adapter byte
 *   for byte.
 * - A plan never ends with an assistant message (no prefill) and is never empty.
 * - Every tool call of a planned assistant message is answered by the tool message right after it, and a tool message
 *   only carries results of the calls just before it: the request is always one the provider accepts.
 */

import { EFFORTS } from '../ai/effort.ts'
import type { Capabilities, Effort } from '../contracts/ai.ts'
import type { PlanInput, PlannedMessage, PromptPlan } from '../contracts/chat.ts'
import { InvalidStateError } from '../contracts/crypto.ts'
import type { Conversation, Message, Part, ProviderMeta, Settings } from '../contracts/workspace.ts'
import { knowledgeText } from '../knowledge/context.ts'
import { unansweredResult } from '../tools/loop.ts'

/** Parts whose JSON is longer than this many bytes are stored as blobs (spec/DATA-MODEL.md section 4.3). */
export const LARGE_PART_BYTES = 16384 as const

const TITLE_LENGTH = 60

/** Whether `meta` has an entry for the provider kind. */
function hasEntry(meta: ProviderMeta | undefined, kind: string): boolean {
  return meta !== undefined && Object.hasOwn(meta, kind) && meta[kind] !== undefined
}

/** The text of a message's text parts, in order. */
function textOf(parts: readonly Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { readonly type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
}

/** Rules 2 to 6 for one part; null leaves it out. */
function planPart(part: Part, message: Message, input: PlanInput, stripReasoning: boolean): Part | null {
  const { kind, capabilities } = input
  switch (part.type) {
    case 'reasoning':
      if (stripReasoning) return null
      return hasEntry(part.providerMeta, kind) ? part : null
    case 'provider':
      return part.provider === kind ? part : null
    case 'tool-call':
      return message.role === 'assistant' && message.status === 'stopped' ? null : part
    case 'image':
      return capabilities.vision ? part : { type: 'text', text: `[image omitted: ${part.name ?? 'image'}]` }
    case 'file':
      return part.mediaType === 'application/pdf' && !capabilities.pdf
        ? { type: 'text', text: `[document omitted: ${part.name}]` }
        : part
    case 'knowledge':
      // Retrieved passages travel in the user turn, as delimited data (core/knowledge/context.ts).
      return message.role === 'user' ? { type: 'text', text: knowledgeText(part) } : null
    default:
      return part
  }
}

type ResultPart = Extract<Part, { readonly type: 'tool-result' }>

/** The tool calls of a planned assistant message that no later part of the plan answers yet. */
function callsOf(message: PlannedMessage | undefined): { callId: string; name: string }[] {
  if (message === undefined || message.role !== 'assistant') return []
  return message.parts
    .filter((p): p is Extract<Part, { readonly type: 'tool-call' }> => p.type === 'tool-call')
    .map((p) => ({ callId: p.callId, name: p.name }))
}

/**
 * Rules 7 and 8: a tool message keeps the results of the calls of the planned message before it (in its own order),
 * and every call of that message left without one gets the fixed "not run" result (the app closed mid-round).
 * Returns the parts of the tool message to send there, or null when the previous message made no call.
 */
function answer(previous: PlannedMessage | undefined, results: readonly ResultPart[]): ResultPart[] | null {
  const calls = callsOf(previous)
  if (calls.length === 0) return null
  const ids = new Set(calls.map((c) => c.callId))
  const kept: ResultPart[] = []
  const answered = new Set<string>()
  for (const r of results) {
    if (!ids.has(r.callId) || answered.has(r.callId)) continue
    answered.add(r.callId)
    kept.push(r)
  }
  for (const call of calls) if (!answered.has(call.callId)) kept.push(unansweredResult(call, 'interrupted'))
  return kept
}

export function planPrompt(input: PlanInput): PromptPlan {
  const { conversation, path, capabilities } = input
  const messages: PlannedMessage[] = []
  // The latest deletion among the messages already walked: a message created before it lost its signed prefix.
  let deletedBefore = Number.NEGATIVE_INFINITY
  for (const message of path) {
    const stripReasoning = message.createdAt <= deletedBefore
    if (message.deletedAt !== undefined) {
      deletedBefore = Math.max(deletedBefore, message.deletedAt)
      continue
    }
    if (message.role === 'assistant' && (message.status === 'error' || message.status === 'refused')) continue
    const parts: Part[] = []
    for (const part of message.parts) {
      const planned = planPart(part, message, input, stripReasoning)
      if (planned !== null) parts.push(planned)
    }
    if (message.role === 'tool') {
      const results = parts.filter((p): p is ResultPart => p.type === 'tool-result')
      const kept = answer(messages.at(-1), results)
      // Results of calls that are not right before them (their answer was deleted or failed) are never sent.
      if (kept !== null) messages.push({ role: 'tool', parts: kept, from: message.id })
      continue
    }
    if (parts.length === 0) continue
    const pending = answer(messages.at(-1), [])
    if (pending !== null) {
      const last = messages.at(-1) as PlannedMessage
      messages.push({ role: 'tool', parts: pending, from: last.from })
    }
    if (message.role === 'system' && !capabilities.midConversationSystem) {
      messages.push({
        role: 'user',
        parts: [{ type: 'text', text: `<system-update>\n${textOf(parts)}\n</system-update>` }],
        from: message.id,
      })
      continue
    }
    messages.push({ role: message.role, parts, from: message.id })
  }
  const last = messages.at(-1)
  if (last === undefined) throw new InvalidStateError('The path has nothing to send')
  if (last.role === 'assistant') throw new InvalidStateError('A request cannot end with an assistant message')
  return { system: conversation.system, messages }
}

export function pickEffort(
  conversation: Pick<Conversation, 'effort'>,
  settings: Pick<Settings, 'defaultEffort'>,
  capabilities: Capabilities,
): Effort | null {
  const levels = capabilities.effort.levels
  const lowest = levels[0]
  if (lowest === undefined) return null
  const wanted = conversation.effort ?? settings.defaultEffort ?? capabilities.effort.default
  if (wanted === null) return lowest
  if (levels.includes(wanted)) return wanted
  const rank = EFFORTS.indexOf(wanted)
  let below: Effort | null = null
  for (const level of levels) {
    if (EFFORTS.indexOf(level) < rank && (below === null || EFFORTS.indexOf(level) > EFFORTS.indexOf(below))) {
      below = level
    }
  }
  return below ?? lowest
}

export function titleFrom(parts: readonly Part[]): string {
  const line = textOf(parts)
    .split(/\r\n|\r|\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .find((l) => l.length > 0)
  if (line === undefined) return ''
  const chars = [...line]
  if (chars.length <= TITLE_LENGTH) return line
  return `${chars
    .slice(0, TITLE_LENGTH - 1)
    .join('')
    .trimEnd()}…`
}
