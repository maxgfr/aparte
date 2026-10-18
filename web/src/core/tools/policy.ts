/*
 * The approval policy (PolicyModule in web/src/core/contracts/tools.ts): whether a call runs, waits for the user or
 * is refused, and what an answer stores.
 *
 * Invariants:
 * - A call of a tool the conversation does not declare (unknown, drifted, gone, or the provider's own) is refused,
 *   whatever was approved before.
 * - Only a built-in that is read-only, not destructive and not open-world may run unasked, and only when it says so.
 *   Everything else needs an approval stored for its current fingerprint: a changed definition asks again.
 * - A conversation approval is looked up before an "always" one; neither is ever widened to another fingerprint.
 */
import type { PolicyModule, ToolSpec } from '../contracts/tools.ts'

export function autoApproved(spec: ToolSpec): boolean {
  const a = spec.annotations
  return spec.source === 'builtin' && spec.autoApprove === true && a.readOnly && !a.destructive && !a.openWorld
}

export const decideApproval: PolicyModule['decideApproval'] = ({ name, resolved, approvals, conversationId }) => {
  const tool = resolved.declared.find((r) => r.tool.name === name)
  if (tool === undefined) {
    if (resolved.drifted.includes(name)) return { kind: 'refuse', reason: 'drifted' }
    if (resolved.missing.includes(name)) return { kind: 'refuse', reason: 'missing' }
    return { kind: 'refuse', reason: 'undeclared' }
  }
  if (autoApproved(tool.tool)) return { kind: 'run', by: 'auto' }
  if (approvals.get(tool.approvalKey, conversationId)?.fingerprint === tool.fingerprint) {
    return { kind: 'run', by: 'conversation' }
  }
  if (approvals.get(tool.approvalKey, null)?.fingerprint === tool.fingerprint) return { kind: 'run', by: 'always' }
  return { kind: 'ask' }
}

export const recordDecision: PolicyModule['recordDecision'] = ({ decision, tool, approvals, conversationId }) => {
  if (decision === 'conversation') {
    approvals.grant({ approvalKey: tool.approvalKey, fingerprint: tool.fingerprint, conversation: conversationId })
  } else if (decision === 'always') {
    approvals.grant({ approvalKey: tool.approvalKey, fingerprint: tool.fingerprint, conversation: null })
  }
}
