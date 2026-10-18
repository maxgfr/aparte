/*
 * Pure pieces of the agent loop (LoopModule in web/src/core/contracts/tools.ts): the step budget an effort buys, and
 * the `tool-result` parts the controller commits, real or standing in for a call that did not run.
 *
 * Invariants:
 * - Every call the model made gets exactly one result, so the next request is always valid for the provider; a call
 *   that did not run gets an error result that says why, in words the model reads.
 * - The text the model reads of a "not run" result is fixed per reason: replaying a conversation always sends the
 *   same bytes.
 */
import type { Effort } from '../contracts/ai.ts'
import type { NotRunReason, ToolResult } from '../contracts/tools.ts'
import type { Part } from '../contracts/workspace.ts'

type ResultPart = Extract<Part, { readonly type: 'tool-result' }>
type BlobPart = Extract<Part, { readonly type: 'image' | 'file' }>

const BUDGET: Readonly<Record<Effort, number>> = {
  none: 2,
  minimal: 2,
  low: 4,
  medium: 8,
  high: 16,
  xhigh: 24,
  max: 32,
}

/** A model that takes no effort runs at the middle of the scale. */
const DEFAULT_BUDGET = 8

export function stepBudget(effort: Effort | null): number {
  return effort === null ? DEFAULT_BUDGET : BUDGET[effort]
}

/** What the model reads of a result: one text as a string, one JSON value as itself, anything else as a list. */
function outputOf(result: ToolResult): unknown {
  const content = result.content.filter((c) => c.type === 'text' || c.type === 'json')
  if (content.length === 0) return ''
  if (content.every((c) => c.type === 'text')) return content.map((c) => c.text).join('\n\n')
  if (content.length === 1 && content[0]?.type === 'json') return content[0].value
  return content.map((c) => (c.type === 'text' ? { type: 'text', text: c.text } : { type: 'json', value: c.value }))
}

export function resultPart(
  call: { readonly callId: string; readonly name: string },
  result: ToolResult,
  parts: readonly BlobPart[] = [],
): ResultPart {
  return {
    type: 'tool-result',
    callId: call.callId,
    name: call.name,
    output: outputOf(result),
    ...(result.isError ? { isError: true as const } : {}),
    ...(parts.length > 0 ? { parts } : {}),
    ...(result.details === undefined ? {} : { details: result.details }),
  }
}

const NOT_RUN: Readonly<Record<NotRunReason, string>> = {
  denied: 'The user declined to run this tool.',
  stopped: 'The user stopped the turn before this tool ran.',
  budget: 'Not run: this turn reached its limit of model calls.',
  undeclared: 'Not run: no tool of this name is available in this conversation.',
  drifted: 'Not run: the definition of this tool changed since this conversation started, so it is not available here.',
  missing: 'Not run: this tool is no longer available.',
  interrupted: 'Not run: the app closed before this tool ran.',
}

export function unansweredResult(
  call: { readonly callId: string; readonly name: string },
  reason: NotRunReason,
): ResultPart {
  return {
    type: 'tool-result',
    callId: call.callId,
    name: call.name,
    output: NOT_RUN[reason],
    isError: true,
    details: { notRun: reason },
  }
}
