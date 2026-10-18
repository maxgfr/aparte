/*
 * How an MCP tool becomes a tool of the registry (contracts/tools.ts, F6) and how its result becomes what the model
 * reads. Pure functions: no network, no state.
 *
 * Invariants:
 * - Registry names are `<prefix>__<tool>`, the tool's name with every character outside `[A-Za-z0-9_-]` replaced by
 *   `_`; a name too long or taken by another tool of the same server gets a short hash of the MCP name instead. The
 *   mapping depends only on the server's prefix and its tool names, so the same server always gives the same names.
 * - Annotations follow MCP's defaults: a tool is read-only only when it says so; a tool that is not read-only is
 *   destructive unless it says it is not; a tool reaches the open world unless it says it does not. They are the
 *   server's claim: MCP tools always ask before running.
 * - A description is capped at MAX_DESCRIPTION_CHARS and an input schema at MAX_SCHEMA_BYTES of canonical JSON; a
 *   schema that is not a JSON object schema makes the tool invalid (never offered).
 * - A result is capped at MAX_RESULT_CHARS of text for the model, at most MAX_IMAGES images of MAX_IMAGE_BYTES each;
 *   what is cut is said in the text, so the model knows it did not see everything. Content the app cannot pass on
 *   (audio, binary resources) is named, never decoded.
 */
import type { Bytes, JsonValue } from '../contracts/crypto.ts'
import type { InputSchema, ToolAnnotations, ToolContent, ToolResult } from '../contracts/tools.ts'
import { canonicalJson } from '../tools/fingerprint.ts'

export const MAX_DESCRIPTION_CHARS = 8000
export const MAX_SCHEMA_BYTES = 64 * 1024
export const MAX_RESULT_CHARS = 20_000
export const MAX_IMAGES = 4
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024
/** The most tools one server may list; the rest are ignored (and said so in the settings). */
export const MAX_TOOLS = 256

const NAME_MAX = 64
const UNSAFE = /[^A-Za-z0-9_-]/g
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** A tool as `tools/list` describes it (the fields this module reads; everything else is ignored). */
export interface McpToolDefinition {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly inputSchema?: unknown
  readonly annotations?: {
    readonly title?: string
    readonly readOnlyHint?: boolean
    readonly destructiveHint?: boolean
    readonly openWorldHint?: boolean
  }
}

/** A server prefix from its name: lowercase ASCII letters and digits, starting with a letter, unique in `taken`. */
export function prefixFor(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const ascii = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  const start = ascii.replace(/^[0-9]+/, '')
  const base = (start === '' ? 'mcp' : start).slice(0, 14)
  if (!used.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, 16 - String(n).length)}${n}`
    if (!used.has(candidate)) return candidate
  }
}

/** FNV-1a over UTF-16 code units, in base 36: a short, stable tag for a name. */
function shortHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36).padStart(7, '0')
}

/**
 * The registry names of a server's tools, by MCP name. Names are assigned in MCP-name order, so a clash always
 * resolves the same way.
 */
export function registryNames(prefix: string, names: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  const used = new Set<string>()
  for (const name of [...new Set(names)].sort()) {
    const plain = `${prefix}__${name.replace(UNSAFE, '_')}`
    let chosen = plain
    if (plain.length > NAME_MAX || used.has(plain) || name === '') {
      const tag = shortHash(name)
      chosen = `${plain.slice(0, NAME_MAX - tag.length - 1)}_${tag}`
    }
    used.add(chosen)
    out.set(name, chosen)
  }
  return out
}

export function annotationsOf(tool: McpToolDefinition): ToolAnnotations {
  const a = tool.annotations ?? {}
  const readOnly = a.readOnlyHint === true
  return {
    readOnly,
    destructive: readOnly ? false : a.destructiveHint !== false,
    openWorld: a.openWorldHint !== false,
  }
}

/** The input schema as the registry takes it, or a reason it cannot be offered. */
export function inputSchemaOf(
  tool: McpToolDefinition,
): { readonly ok: true; readonly schema: InputSchema } | { readonly ok: false; readonly invalid: string } {
  const schema = tool.inputSchema
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    return { ok: false, invalid: 'The input schema is not an object' }
  }
  const s = schema as Record<string, unknown>
  if (s.type !== undefined && s.type !== 'object')
    return { ok: false, invalid: 'The input schema is not of type object' }
  let text: string
  try {
    text = canonicalJson({ ...s, type: 'object' } as JsonValue)
  } catch {
    return { ok: false, invalid: 'The input schema is not JSON' }
  }
  if (new TextEncoder().encode(text).length > MAX_SCHEMA_BYTES) {
    return { ok: false, invalid: 'The input schema is too large' }
  }
  return { ok: true, schema: JSON.parse(text) as InputSchema }
}

/** What the model reads to decide when to call the tool. */
export function descriptionOf(tool: McpToolDefinition): string {
  const text = (tool.description ?? '').trim() || tool.title?.trim() || tool.annotations?.title?.trim() || tool.name
  return text.length > MAX_DESCRIPTION_CHARS ? text.slice(0, MAX_DESCRIPTION_CHARS) : text
}

/** What the interface calls the tool. */
export function titleOf(tool: McpToolDefinition): string {
  return tool.title?.trim() || tool.annotations?.title?.trim() || tool.name
}

// Results

/** An MCP `CallToolResult`, as far as this module reads it. */
export interface McpCallResult {
  readonly content?: readonly unknown[]
  readonly structuredContent?: unknown
  readonly isError?: boolean
}

function decodeBase64(data: string): Uint8Array | null {
  try {
    const binary = atob(data)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

/** The JSON of a value, or null when it is not JSON (a cycle, a BigInt, a non-finite number). */
function jsonOf(value: unknown): JsonValue | null {
  try {
    return JSON.parse(canonicalJson(value as JsonValue)) as JsonValue
  } catch {
    return null
  }
}

function describe(item: Record<string, unknown>): string {
  const type = typeof item.type === 'string' ? item.type : 'unknown'
  if (type === 'resource') {
    const r = (item.resource ?? {}) as Record<string, unknown>
    const uri = typeof r.uri === 'string' ? r.uri : ''
    if (typeof r.text === 'string') return `[resource ${uri}]\n${r.text}`
    const mime = typeof r.mimeType === 'string' ? r.mimeType : 'application/octet-stream'
    return `[binary resource ${uri} (${mime}), not shown]`
  }
  if (type === 'resource_link') {
    const uri = typeof item.uri === 'string' ? item.uri : ''
    const name = typeof item.name === 'string' ? item.name : uri
    return `[resource link: ${name} <${uri}>]`
  }
  if (type === 'audio') return '[audio content, not shown]'
  if (type === 'image') return '[image content, not shown]'
  return `[${type} content, not supported]`
}

/**
 * What the model reads of an MCP tool result: texts, JSON and images in order, capped (see the invariants). The
 * result is untrusted: it is data for the model, shown as text, never acted on by the app.
 */
export function toToolResult(result: McpCallResult): ToolResult {
  const content: ToolContent[] = []
  let chars = 0
  let total = 0
  let images = 0
  let droppedImages = 0
  const pushText = (text: string) => {
    total += text.length
    const room = MAX_RESULT_CHARS - chars
    if (room <= 0) return
    const kept = text.length > room ? text.slice(0, room) : text
    chars += kept.length
    content.push({ type: 'text', text: kept })
  }
  const items = Array.isArray(result.content) ? result.content : []
  for (const raw of items) {
    if (raw === null || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    if (item.type === 'text' && typeof item.text === 'string') {
      pushText(item.text)
    } else if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
      const bytes = IMAGE_TYPES.has(item.mimeType) && images < MAX_IMAGES ? decodeBase64(item.data) : null
      if (bytes !== null && bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES) {
        images++
        content.push({ type: 'image', data: bytes as Bytes, mediaType: item.mimeType })
      } else {
        droppedImages++
      }
    } else {
      pushText(describe(item))
    }
  }
  if (content.length === 0 && result.structuredContent !== undefined) {
    const value = jsonOf(result.structuredContent)
    if (value !== null) {
      const text = JSON.stringify(value)
      if (text.length <= MAX_RESULT_CHARS) {
        content.push({ type: 'json', value })
        total += text.length
        chars += text.length
      } else pushText(text)
    }
  }
  const notes: string[] = []
  if (total > chars) {
    notes.push(`[Truncated: the tool returned ${total} characters; only the first ${chars} are shown.]`)
  }
  if (droppedImages > 0)
    notes.push(`[${droppedImages} image(s) left out: too many, too large or of an unsupported type.]`)
  for (const note of notes) content.push({ type: 'text', text: note })
  if (content.length === 0) content.push({ type: 'text', text: '' })
  const details: Record<string, JsonValue> = {}
  if (total > chars) details.truncatedFrom = total
  if (droppedImages > 0) details.droppedImages = droppedImages
  return {
    content,
    ...(result.isError === true ? { isError: true } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
  }
}
