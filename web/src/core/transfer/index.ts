/*
 * Imports and exports of conversations (pure TypeScript; the interface is web/src/screens/Transfer and
 * web/src/ui/transfer). What is where:
 *
 *   tree.ts     the neutral shape of an import and the tree normalisation every source shares
 *   sources.ts  ChatGPT, Claude and Open WebUI exports to that shape
 *   aparte.ts   Aparté's own lossless conversation file (export and import, blobs included)
 *   render.ts   one branch as Markdown or as a self-contained HTML file
 *   index.ts    reading a file of any of these (detection, zip), and writing imported conversations
 *
 * Invariants:
 * - A file is untrusted: it is parsed as JSON only, never run; a file over MAX_IMPORT_BYTES is refused.
 * - Writing goes through the workspace (contracts/workspace.ts): a conversation per imported conversation, its
 *   messages committed parents first with their original times, its leaf on the branch the source showed. Imported
 *   answers have no model (the source's model is not one of this vault's providers).
 * - The full encrypted backup is not here: it is the sync archive (core/sync/providers/zip.ts), written and read by
 *   the sync engine, so it holds exactly what the store holds.
 */

import { InvalidInputError, type Rng } from '../contracts/crypto.ts'
import type { Id, Workspace } from '../contracts/workspace.ts'
import { base32Encode, fromUtf8 } from '../crypto/bytes.ts'
import { readZip } from '../sync/providers/zip.ts'
import { type ExportDocument, type ImportDeps, importDocument, isExportDocument } from './aparte.ts'
import { fromChatGpt, fromClaude, fromOpenWebUi } from './sources.ts'
import type { ImportedConversation } from './tree.ts'

export * from './aparte.ts'
export * from './render.ts'
export * from './sources.ts'
export * from './tree.ts'

/** Exports of other apps reach a few hundred megabytes at most; anything larger is refused before parsing. */
export const MAX_IMPORT_BYTES = 512 * 1024 * 1024

export type ImportSource = 'chatgpt' | 'claude' | 'openwebui' | 'aparte'

export type ParsedImport =
  | { readonly source: Exclude<ImportSource, 'aparte'>; readonly conversations: readonly ImportedConversation[] }
  | { readonly source: 'aparte'; readonly document: ExportDocument; readonly count: number }

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Which app wrote `data`, or null. */
export function detectSource(data: unknown): ImportSource | null {
  if (isExportDocument(data)) return 'aparte'
  const items = Array.isArray(data) ? data : isObject(data) ? [data] : []
  const first = items.find(isObject)
  if (first === undefined) return null
  if (isObject(first.mapping)) return 'chatgpt'
  if (Array.isArray(first.chat_messages)) return 'claude'
  const chat = isObject(first.chat) ? first.chat : first
  if (isObject(chat.history) || Array.isArray(chat.messages)) return 'openwebui'
  return null
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]

/**
 * Reads an export file: JSON, or a zip holding `conversations.json` (ChatGPT and Claude ship their exports as one).
 * InvalidInputError when it is none of the known formats.
 */
export async function parseImport(bytes: Uint8Array): Promise<ParsedImport> {
  if (bytes.length > MAX_IMPORT_BYTES) throw new InvalidInputError('The file is too large to import')
  let json = bytes
  if (ZIP_MAGIC.every((b, i) => bytes[i] === b)) {
    const entries = await readZip(bytes)
    const name = [...entries.keys()].find((n) => n === 'conversations.json' || n.endsWith('/conversations.json'))
    const found = name === undefined ? undefined : entries.get(name)
    if (found === undefined) throw new InvalidInputError('The archive holds no conversations.json')
    json = found
  }
  let data: unknown
  try {
    data = JSON.parse(fromUtf8(json))
  } catch (cause) {
    throw new InvalidInputError('The file is not JSON', { cause })
  }
  const source = detectSource(data)
  switch (source) {
    case 'aparte': {
      const document = data as ExportDocument
      return { source, document, count: Array.isArray(document.conversations) ? document.conversations.length : 0 }
    }
    case 'chatgpt':
      return { source, conversations: fromChatGpt(data) }
    case 'claude':
      return { source, conversations: fromClaude(data) }
    case 'openwebui':
      return { source, conversations: fromOpenWebUi(data) }
    default:
      throw new InvalidInputError('This file is not an export this app reads')
  }
}

/** How many conversations an import would write (empty ones are skipped). */
export function importCount(parsed: ParsedImport): number {
  return parsed.source === 'aparte' ? parsed.count : parsed.conversations.filter((c) => c.messages.length > 0).length
}

/** Writes one imported conversation; returns its id. */
export async function writeImported(
  deps: { readonly workspace: Workspace; readonly rng: Rng },
  imported: ImportedConversation,
): Promise<Id> {
  const ws = deps.workspace
  // An empty system prompt is set explicitly: the user's default system prompt must not slip into an old chat.
  const id = ws.conversations.create({ title: imported.title, system: imported.system, model: null })
  try {
    const thread = await ws.thread(id)
    const ids = new Map<string, Id>()
    ws.batch(() => {
      for (const m of imported.messages) {
        const mid = base32Encode(deps.rng.bytes(16))
        ids.set(m.key, mid)
        thread.commit({
          id: mid,
          parent: m.parent === null ? null : (ids.get(m.parent) ?? null),
          role: m.role,
          parts: [{ type: 'text', text: m.text }],
          model: null,
          status: 'done',
          createdAt: m.createdAt,
        })
      }
      const leaf = imported.leaf === null ? undefined : ids.get(imported.leaf)
      thread.setLeaf(leaf ?? null)
    })
  } catch (error) {
    ws.conversations.trash(id)
    throw error
  }
  return id
}

/** Writes every conversation of a parsed import; returns the new ids and how many failed. */
export async function applyImport(
  deps: ImportDeps,
  parsed: ParsedImport,
  onProgress?: (done: number, total: number) => void,
): Promise<{ readonly conversations: readonly Id[]; readonly failed: number }> {
  if (parsed.source === 'aparte') return importDocument(deps, parsed.document)
  const todo = parsed.conversations.filter((c) => c.messages.length > 0)
  const created: Id[] = []
  let failed = 0
  for (const [i, conversation] of todo.entries()) {
    try {
      created.push(await writeImported(deps, conversation))
    } catch {
      failed++
    }
    onProgress?.(i + 1, todo.length)
  }
  return { conversations: created, failed }
}
