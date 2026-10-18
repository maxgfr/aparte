/*
 * Aparté's own conversation file (`aparte-conversation`, version 1): one or more conversations with their whole
 * message tree, every branch, and the blobs they reference, so a file exported here and imported into any vault gives
 * the same conversations back, photos included.
 *
 * Invariants:
 * - Lossless: messages keep their parts verbatim (reasoning signatures included, which only their own provider can
 *   read), statuses, usage, errors, efforts, timestamps and deletions. A `ref` part (a large part stored as a blob) is
 *   written inline as the part it stands for.
 * - Blobs are written as base64url with their media type, under the id they had; importing stores each one again in
 *   the target vault (whose blob ids differ: they are keyed hashes) and rewrites every reference.
 * - Importing never trusts the file: messages are validated by the workspace, ids are fresh, a parent is always
 *   written before its children, and a conversation that does not import is removed again rather than left half.
 * - The file is plaintext: the interface says so before it is saved.
 */

import type { Effort } from '../contracts/ai.ts'
import { InvalidInputError, type Rng } from '../contracts/crypto.ts'
import type {
  BlobPort,
  Id,
  Message,
  ModelRef,
  NewMessage,
  Part,
  ToolSnapshotEntry,
  Workspace,
} from '../contracts/workspace.ts'
import { base32Encode, base64urlDecode, base64urlEncode, fromUtf8 } from '../crypto/bytes.ts'

export const EXPORT_FORMAT = 'aparte-conversation'
export const EXPORT_VERSION = 1

/** A message as written: everything but its conversation id. */
export type ExportedMessage = Omit<Message, 'conv'>

export interface ExportedConversation {
  /** The id it had in the vault it came from; informative only. */
  readonly id: Id
  readonly title: string
  readonly system: string
  readonly tools: readonly ToolSnapshotEntry[]
  readonly model: ModelRef | null
  readonly effort: Effort | null
  readonly pinned: boolean
  readonly archived: boolean
  readonly createdAt: number
  readonly updatedAt: number
  readonly leaf: Id | null
  readonly messages: readonly ExportedMessage[]
}

export interface ExportedBlob {
  readonly mediaType: string
  /** base64url (spec/FORMAT.md section 3.2). */
  readonly data: string
}

export interface ExportDocument {
  readonly format: typeof EXPORT_FORMAT
  readonly version: typeof EXPORT_VERSION
  readonly exportedAt: number
  readonly conversations: readonly ExportedConversation[]
  /** By the blob id the parts reference. */
  readonly blobs: Readonly<Record<string, ExportedBlob>>
  /** Blobs a part references that this device does not hold (yet); their parts are kept as they are. */
  readonly missing: readonly string[]
}

/** A BlobPort, with the manifest's media type when it can tell (core/media/blobs.ts `LocalBlobs`). */
export type ExportBlobs = BlobPort & {
  info?(id: string): Promise<{ readonly mediaType: string; readonly size: number } | null>
}

export interface ExportDeps {
  readonly workspace: Workspace
  readonly blobs: ExportBlobs
  readonly clock: { now(): number }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** The part a `ref` part stores, or the part itself; a ref whose blob is missing stays a ref. */
export async function resolveRef(part: Part, blobs: BlobPort): Promise<Part> {
  if (part.type !== 'ref') return part
  const bytes = await blobs.get(part.blob)
  if (bytes === null) return part
  try {
    const parsed: unknown = JSON.parse(fromUtf8(bytes))
    return isObject(parsed) && typeof parsed.type === 'string' ? (parsed as Part) : part
  } catch {
    return part
  }
}

/** Every `{blob, mediaType?}` reference inside a value (parts nest: a tool result holds image parts). */
function blobRefs(value: unknown, out: Map<string, string | null>): void {
  if (Array.isArray(value)) for (const v of value) blobRefs(v, out)
  else if (isObject(value)) {
    if (typeof value.blob === 'string') {
      const type = typeof value.mediaType === 'string' ? value.mediaType : null
      if (!out.has(value.blob) || out.get(value.blob) === null) out.set(value.blob, type)
    }
    for (const v of Object.values(value)) if (v !== null && typeof v === 'object') blobRefs(v, out)
  }
}

/** The file holding `ids`, with their trees and blobs. */
export async function exportConversations(deps: ExportDeps, ids: readonly Id[]): Promise<ExportDocument> {
  const { workspace: ws, blobs } = deps
  const conversations: ExportedConversation[] = []
  const refs = new Map<string, string | null>()
  for (const id of ids) {
    const c = ws.conversations.get(id)
    if (c === undefined || c.purgedAt !== undefined) throw new InvalidInputError('Unknown conversation')
    const thread = await ws.thread(id)
    const messages: ExportedMessage[] = []
    for (const m of thread.all()) {
      const parts: Part[] = []
      for (const p of m.parts) parts.push(await resolveRef(p, blobs))
      const { conv: _conv, ...rest } = m
      messages.push({ ...rest, parts })
      blobRefs(parts, refs)
    }
    conversations.push({
      id: c.id,
      title: c.title,
      system: c.system,
      tools: c.tools,
      model: c.model,
      effort: c.effort,
      pinned: c.pinned,
      archived: c.archived,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      leaf: c.leaf,
      messages,
    })
  }
  const out: Record<string, ExportedBlob> = {}
  const missing: string[] = []
  for (const [blob, type] of refs) {
    const bytes = await blobs.get(blob)
    if (bytes === null) {
      missing.push(blob)
      continue
    }
    const mediaType = type ?? (await blobs.info?.(blob))?.mediaType ?? 'application/octet-stream'
    out[blob] = { mediaType, data: base64urlEncode(bytes) }
  }
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: deps.clock.now(),
    conversations,
    blobs: out,
    missing,
  }
}

/** Whether `data` is an Aparté conversation file this build reads. */
export function isExportDocument(data: unknown): data is ExportDocument {
  return isObject(data) && data.format === EXPORT_FORMAT && data.version === EXPORT_VERSION
}

export interface ImportDeps {
  readonly workspace: Workspace
  readonly blobs: BlobPort
  readonly rng: Rng
}

/** A copy of `value` with every `blob` reference in `map` replaced. */
function remap(value: unknown, map: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => remap(v, map))
  if (!isObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    out[k] = k === 'blob' && typeof v === 'string' ? (map.get(v) ?? v) : remap(v, map)
  }
  return out
}

const EFFORTS: ReadonlySet<string> = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** Messages ordered so every parent comes before its children; a message whose parent is absent becomes a root. */
function parentsFirst(messages: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const ids = new Set(messages.map((m) => m.id))
  const children = new Map<unknown, Record<string, unknown>[]>()
  for (const m of messages) {
    const parent = typeof m.parent === 'string' && ids.has(m.parent) && m.parent !== m.id ? m.parent : null
    const list = children.get(parent) ?? []
    list.push({ ...m, parent })
    children.set(parent, list)
  }
  const out: Record<string, unknown>[] = []
  const seen = new Set<unknown>()
  const visit = (parent: unknown) => {
    for (const m of children.get(parent) ?? []) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      out.push(m)
      visit(m.id)
    }
  }
  visit(null)
  return out
}

/**
 * Writes the conversations of an Aparté file into the workspace; returns the new conversation ids and how many could
 * not be imported.
 */
export async function importDocument(
  deps: ImportDeps,
  doc: ExportDocument,
): Promise<{ readonly conversations: readonly Id[]; readonly failed: number }> {
  const { workspace: ws, blobs, rng } = deps
  const newId = (): Id => base32Encode(rng.bytes(16))
  const blobMap = new Map<string, string>()
  if (isObject(doc.blobs)) {
    for (const [id, blob] of Object.entries(doc.blobs)) {
      if (!isObject(blob) || typeof blob.data !== 'string' || typeof blob.mediaType !== 'string') continue
      try {
        blobMap.set(id, await blobs.put(base64urlDecode(blob.data), blob.mediaType))
      } catch {
        // A blob that does not decode stays missing: its part shows as unavailable, like one not synced yet.
      }
    }
  }
  const created: Id[] = []
  let failed = 0
  for (const c of Array.isArray(doc.conversations) ? doc.conversations : []) {
    if (!isObject(c)) {
      failed++
      continue
    }
    let id: Id | null = null
    try {
      const model = c.model as ModelRef | null
      const known = isObject(model) && typeof model.provider === 'string' && ws.providers.get(model.provider)
      id = ws.conversations.create({
        title: typeof c.title === 'string' ? c.title : '',
        system: typeof c.system === 'string' ? c.system : '',
        tools: Array.isArray(c.tools) ? (c.tools as ToolSnapshotEntry[]) : [],
        model: known ? model : null,
        effort: typeof c.effort === 'string' && EFFORTS.has(c.effort) ? (c.effort as Effort) : null,
        pinned: c.pinned === true,
      })
      const conversation: Id = id
      if (c.archived === true) ws.conversations.update(conversation, { archived: true })
      const thread = await ws.thread(conversation)
      const ids = new Map<unknown, Id>()
      const raw = Array.isArray(c.messages) ? c.messages.filter(isObject) : []
      const ordered = parentsFirst(raw)
      const deleted: Id[] = []
      ws.batch(() => {
        for (const m of ordered) {
          const mid = newId()
          ids.set(m.id, mid)
          const message: Record<string, unknown> = {
            id: mid,
            parent: m.parent === null ? null : (ids.get(m.parent) ?? null),
            role: m.role,
            parts: remap(Array.isArray(m.parts) ? m.parts : [], blobMap),
            model: isObject(m.model) ? m.model : null,
            status: m.status,
          }
          for (const key of ['usage', 'error', 'stop', 'refusal', 'effort', 'createdAt'] as const) {
            if (m[key] !== undefined) message[key] = m[key]
          }
          thread.commit(message as unknown as NewMessage)
          if (typeof m.deletedAt === 'number') deleted.push(mid)
        }
        for (const mid of deleted) thread.delete(mid)
        const leaf = typeof c.leaf === 'string' ? ids.get(c.leaf) : undefined
        thread.setLeaf(leaf ?? ordered.map((m) => ids.get(m.id)).at(-1) ?? null)
      })
      created.push(conversation)
    } catch {
      failed++
      // Nothing half-imported is left in the list: the conversation goes to the trash.
      if (id !== null) {
        try {
          ws.conversations.trash(id)
        } catch {
          // Already gone.
        }
      }
    }
  }
  return { conversations: created, failed }
}
