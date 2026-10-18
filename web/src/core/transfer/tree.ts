/*
 * The neutral shape every importer produces, and the tree normalisation they share: the exports of other apps hold
 * messages Aparté does not keep (tool calls, hidden context, empty placeholders), and dropping one must not break the
 * tree. A dropped message's children move up to its nearest kept ancestor, so the branches stay branches.
 *
 * Invariants:
 * - Only `user`, `assistant` and `system` messages with text are kept; everything else is dropped.
 * - The output lists parents before children (it can be committed in order), every `parent` is a kept message, and
 *   `leaf` is a kept message (or null for an empty conversation).
 * - An assistant message whose kept parent is an assistant message with no other kept child is merged into it (the
 *   text of a tool round on either side of a dropped tool call), so a branch never holds two answers in a row.
 * - A system message that is the only root becomes the conversation's system prompt.
 * - Timestamps are safe integers in milliseconds; a missing one takes its parent's, else the conversation's.
 */

import type { Role } from '../contracts/workspace.ts'

/** A message as an importer reads it, before normalisation. */
export interface RawNode {
  readonly key: string
  readonly parent: string | null
  /** The source app's role name. */
  readonly role: string
  readonly text: string
  /** Milliseconds, or null when the export has none. */
  readonly createdAt: number | null
}

export interface ImportedMessage {
  readonly key: string
  readonly parent: string | null
  readonly role: Extract<Role, 'user' | 'assistant' | 'system'>
  readonly text: string
  readonly createdAt: number
}

/** One conversation ready to be written, from any source. */
export interface ImportedConversation {
  readonly title: string
  readonly createdAt: number
  readonly system: string
  /** Parents first. */
  readonly messages: readonly ImportedMessage[]
  readonly leaf: string | null
}

const KEPT: ReadonlySet<string> = new Set(['user', 'assistant', 'system'])

/** Milliseconds from seconds (ChatGPT, Open WebUI) or an ISO date (Claude); null when it is neither. */
export function millis(value: unknown, unit: 'seconds' | 'iso' | 'auto' = 'auto'): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Seconds unless it is clearly milliseconds already (after 2001 in ms is above 1e12).
    const ms = unit === 'seconds' || (unit === 'auto' && value < 1e11) ? value * 1000 : value
    const n = Math.round(ms)
    return Number.isSafeInteger(n) ? n : null
  }
  if (typeof value === 'string' && unit !== 'seconds') {
    const n = Date.parse(value)
    return Number.isSafeInteger(n) && n > 0 ? n : null
  }
  return null
}

/** Text with every lone surrogate replaced, so it is a valid Yjs string. */
export function wellFormedText(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�')
}

/** A title: its first line, trimmed, at most 200 characters. */
export function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') return ''
  return wellFormedText(value.split('\n')[0]?.trim() ?? '').slice(0, 200)
}

interface Node {
  readonly key: string
  parent: string | null
  readonly role: ImportedMessage['role']
  text: string
  createdAt: number
}

/** Normalises the raw messages of one conversation (see the invariants above). */
export function buildTree(
  raw: readonly RawNode[],
  leafKey: string | null,
  conversation: { readonly title: string; readonly createdAt: number },
): ImportedConversation {
  const byKey = new Map<string, RawNode>()
  for (const n of raw) if (!byKey.has(n.key)) byKey.set(n.key, n)
  const keep = (n: RawNode) => KEPT.has(n.role) && n.text.trim() !== ''

  // The nearest kept ancestor of each message (itself excluded), with a guard against cycles in a hostile file.
  const ancestor = new Map<string, string | null>()
  const keptAncestor = (key: string | null): string | null => {
    const seen = new Set<string>()
    let at = key
    while (at !== null) {
      if (seen.has(at)) return null
      seen.add(at)
      const cached = ancestor.get(at)
      if (cached !== undefined) return cached
      const n = byKey.get(at)
      if (n === undefined) return null
      if (keep(n)) return at
      at = n.parent
    }
    return null
  }

  const nodes = new Map<string, Node>()
  for (const n of byKey.values()) {
    if (!keep(n)) continue
    const parent = n.parent === null || n.parent === n.key ? null : keptAncestor(n.parent)
    ancestor.set(n.key, n.key)
    nodes.set(n.key, {
      key: n.key,
      parent,
      role: n.role as ImportedMessage['role'],
      text: wellFormedText(n.text.trim()),
      createdAt: n.createdAt ?? Number.NaN,
    })
  }
  // A parent chain that loops back on itself (only a broken file can have one) is cut at the loop.
  for (const n of nodes.values()) {
    const seen = new Set<string>([n.key])
    for (let at = n.parent; at !== null; at = nodes.get(at)?.parent ?? null) {
      if (seen.has(at)) {
        n.parent = null
        break
      }
      seen.add(at)
    }
  }

  const children = new Map<string | null, Node[]>()
  for (const n of nodes.values()) {
    const list = children.get(n.parent) ?? []
    list.push(n)
    children.set(n.parent, list)
  }

  // Parents first, siblings by time then by their order in the file.
  const order: Node[] = []
  const position = new Map([...byKey.keys()].map((k, i) => [k, i]))
  const visit = (parent: string | null, time: number) => {
    const list = children.get(parent) ?? []
    for (const n of list) if (!Number.isFinite(n.createdAt)) n.createdAt = time
    list.sort((a, b) => a.createdAt - b.createdAt || (position.get(a.key) ?? 0) - (position.get(b.key) ?? 0))
    for (const n of list) {
      order.push(n)
      visit(n.key, n.createdAt)
    }
  }
  visit(null, conversation.createdAt)

  // Merge an answer into the answer before it when that one has no other kept child.
  const alias = new Map<string, string>()
  const resolve = (key: string): string => {
    let at = key
    while (alias.has(at)) at = alias.get(at) as string
    return at
  }
  const out: Node[] = []
  for (const n of order) {
    if (n.parent !== null) n.parent = resolve(n.parent)
    const parent = n.parent === null ? undefined : nodes.get(n.parent)
    const only = n.parent !== null && (children.get(n.parent)?.length ?? 0) === 1
    if (parent !== undefined && only && parent.role === 'assistant' && n.role === 'assistant') {
      parent.text = `${parent.text}\n\n${n.text}`
      alias.set(n.key, parent.key)
      continue
    }
    out.push(n)
  }

  let system = ''
  const roots = out.filter((n) => n.parent === null)
  const first = roots[0]
  if (roots.length === 1 && first !== undefined && first.role === 'system') {
    system = first.text
    out.splice(out.indexOf(first), 1)
    alias.set(first.key, '')
    for (const n of out) if (n.parent === first.key) n.parent = null
  }

  const kept = new Set(out.map((n) => n.key))
  let leaf: string | null = null
  const wanted = leafKey === null ? null : keptAncestor(leafKey)
  if (wanted !== null) {
    const r = resolve(wanted)
    if (kept.has(r)) leaf = r
  }
  if (leaf === null && out.length > 0) {
    // The most recent branch: the latest root, then at each level the latest child.
    const latest = (list: readonly Node[]) => list.reduce((a, b) => (b.createdAt >= a.createdAt ? b : a))
    let at: Node = latest(out.filter((n) => n.parent === null))
    for (;;) {
      const next = out.filter((n) => n.parent === at.key)
      if (next.length === 0) break
      at = latest(next)
    }
    leaf = at.key
  }

  return {
    title: conversation.title,
    createdAt: conversation.createdAt,
    system,
    messages: out.map((n) => ({ key: n.key, parent: n.parent, role: n.role, text: n.text, createdAt: n.createdAt })),
    leaf,
  }
}
