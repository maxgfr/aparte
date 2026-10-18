/*
 * The workspace (web/src/core/contracts/workspace.ts): the vault's 17 Yjs documents, their entities, the message tree
 * of each conversation, and their encrypted persistence on this device. The only module that touches Yjs.
 *
 * Invariants kept here:
 * - Shared types are `Y.Map` only (a top-level map per entity kind, one nested map per entity); every leaf value goes
 *   through `toAny`, so a document never holds `undefined`, a non-finite number, a lone surrogate or a class instance.
 * - Every transaction this module opens has origin `local`; queue replay and cross-tab catch-up apply with origin
 *   `replay`, `applyRemote` with origin `remote`, and only `local` updates are captured into the pending queue.
 * - Messages are written once by `commit`; the only later write to a message is `deletedAt`, once. A purge removes
 *   them.
 * - The other tabs of this device learn of a change through BroadcastChannel `aparte-workspace`, whose messages carry
 *   only `{type: 'changed', doc}`: never content. They then read the change from the encrypted pending queue.
 * - Nothing readable outlives `close()`: documents are destroyed, caches and listeners dropped.
 */

import * as Y from 'yjs'
import type { Effort, ProviderConfig, ProviderKind, StopReason } from '../contracts/ai.ts'
import {
  type Bytes,
  CorruptError,
  type DocId,
  InvalidInputError,
  InvalidStateError,
  LockedError,
  type ShardId,
} from '../contracts/crypto.ts'
import { COLLECTIONS, type CollectionName, type CollectionTypes } from '../contracts/extras.ts'
import type { McpServerConfig, McpServerPatch, McpServers, McpToolChoice, NewMcpServer } from '../contracts/mcp.ts'
import type { ToolApproval, ToolApprovals } from '../contracts/tools.ts'
import type {
  Collection,
  Conversation,
  ConversationFilter,
  ConversationPatch,
  Conversations,
  EmbedderRef,
  Entity,
  Folder,
  Folders,
  Id,
  KnowledgeBase,
  KnowledgeBases,
  KnowledgeDocument,
  Message,
  MessageStatus,
  ModelRef,
  NewConversation,
  NewMessage,
  NewProvider,
  PersistenceStatus,
  Providers,
  Role,
  Scope,
  Settings,
  SettingsRepo,
  Thread,
  ToolSnapshotEntry,
  Workspace,
  WorkspaceDeps,
} from '../contracts/workspace.ts'
import { base32Decode, base32Encode } from '../crypto/bytes.ts'
import { shardOf as shardOfBytes } from '../crypto/names.ts'
import { deepFreeze, frozenCopy, toAny, wellFormed } from './any.ts'
import { type Capture, captureUpdates } from './capture.ts'
import { keyAfter } from './order.ts'

// Constants of the schema (spec/DATA-MODEL.md sections 3 and 4)

export const CHANNEL_NAME = 'aparte-workspace'

/** A document whose queue reaches this many records is compacted into one. */
export const COMPACT_AT = 64

const SHARDS: readonly ShardId[] = Array.from({ length: 16 }, (_, i) => `c${String(i).padStart(2, '0')}` as ShardId)
const DOC_IDS: ReadonlySet<string> = new Set<string>(['index', ...SHARDS])

const EFFORTS: ReadonlySet<string> = new Set<Effort>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const ROLES: ReadonlySet<string> = new Set<Role>(['user', 'assistant', 'system', 'tool'])
const STATUSES: ReadonlySet<string> = new Set<MessageStatus>(['done', 'stopped', 'error', 'refused'])
const STOPS: ReadonlySet<string> = new Set<StopReason>([
  'end',
  'length',
  'tool-calls',
  'stop-sequence',
  'refusal',
  'content-filter',
  'pause',
  'other',
])
const TOOL_SOURCES: ReadonlySet<string> = new Set(['builtin', 'mcp', 'skill', 'sandbox', 'provider'])
const PROVIDER_KINDS: ReadonlySet<string> = new Set<ProviderKind>([
  'anthropic',
  'openai',
  'google',
  'mistral',
  'openrouter',
  'openai-compatible',
  'webllm',
  'chrome-ai',
])
const USAGE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const
const SETTINGS_DEFAULTS: Settings = { defaultModel: null, defaultEffort: null, defaultSystem: '' }

const PROVIDER_FIELDS: ReadonlySet<string> = new Set([
  'kind',
  'label',
  'baseUrl',
  'preset',
  'models',
  'defaultModel',
  'syncKey',
  'secret',
  'overrides',
])
const PROVIDER_OPTIONAL: ReadonlySet<string> = new Set([
  'baseUrl',
  'preset',
  'models',
  'defaultModel',
  'secret',
  'overrides',
])

/**
 * Strings shaped like the API keys and tokens of the supported providers. A provider configuration is synced in
 * clear to every device of the vault (inside the encrypted index), so a key pasted into a label or an override is
 * refused rather than synced: keys live in `ProviderKeys`.
 */
const SECRET_SHAPED =
  /(?:^|[^A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{16,}|sk_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{30,}|xai-[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|pplx-[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{20,}|r8_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|Bearer\s+\S{16,})/
const SECRET_NAME = /key|token|secret|password|passwd|auth|credential|bearer/i

const ID = /^[a-z2-7]{26}$/

const MCP_FIELDS: ReadonlySet<string> = new Set(['name', 'prefix', 'transport', 'url', 'auth', 'enabled', 'tools'])
const MCP_PATCHABLE: ReadonlySet<string> = new Set(['name', 'transport', 'url', 'auth', 'enabled', 'tools'])
const MCP_TRANSPORTS: ReadonlySet<string> = new Set(['http', 'sse'])
const MCP_AUTHS: ReadonlySet<string> = new Set(['none', 'oauth', 'bearer', 'headers'])
const MCP_PREFIX = /^[a-z][a-z0-9]{0,15}$/
/** The most tool choices a server keeps; a server listing more is refused by the manager first. */
const MCP_MAX_TOOLS = 512

export const isId = (value: unknown): value is Id => typeof value === 'string' && ID.test(value)

/** Extras the contract leaves out: injectable for tests and for hosts without the browser APIs. */
export interface WorkspaceOptions {
  /** Opens the cross-tab channel; null disables it. Defaults to BroadcastChannel `aparte-workspace` when present. */
  readonly channel?: (() => ChannelLike) | null
  /**
   * Runs `fn` holding an exclusive lock shared by the tabs of this device, so two tabs never take the same queue
   * position. Defaults to the Web Locks API when present; null runs `fn` directly.
   */
  readonly lock?: (<T>(name: string, fn: () => Promise<T>) => Promise<T>) | null
  /** Queue length that triggers a compaction; defaults to COMPACT_AT. */
  readonly compactAt?: number
}

export interface ChannelLike {
  postMessage(message: unknown): void
  onmessage: ((event: { readonly data: unknown }) => void) | null
  close(): void
}

interface Loaded {
  readonly id: DocId
  readonly doc: Y.Doc
  readonly capture: Capture
  /** Queue positions this instance applied or wrote: catching up from the queue skips them. */
  known: Set<number>
  /** Records in the queue, as last seen. */
  records: number
  compacting: Promise<void> | null
  syncing: boolean
  syncAgain: boolean
}

interface ShardState {
  readonly messages: Y.Map<Y.Map<unknown>>
  /** Message ids by conversation. */
  readonly byConv: Map<Id, Set<Id>>
  /** Conversation of each message, to unindex a removed one. */
  readonly convOf: Map<Id, Id>
}

interface ConvCache {
  all?: readonly Message[]
  children?: Map<Id | null, readonly Message[]>
  paths?: Map<string, readonly Message[]>
}

type Listener = () => void

const defaultChannel = (): ChannelLike | null => {
  if (typeof BroadcastChannel === 'undefined') return null
  const channel = new BroadcastChannel(CHANNEL_NAME) as BroadcastChannel & { unref?: () => void }
  // Outside a browser a channel would keep the process alive; nothing waits on it there.
  channel.unref?.()
  return channel as unknown as ChannelLike
}

const defaultLock = (): (<T>(name: string, fn: () => Promise<T>) => Promise<T>) | null => {
  const locks = typeof navigator === 'undefined' ? undefined : (navigator as Navigator | undefined)?.locks
  if (!locks) return null
  return <T>(name: string, fn: () => Promise<T>) => locks.request(name, fn) as Promise<T>
}

const safeTime = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new InvalidStateError('The clock gave an invalid timestamp')
  return value
}

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)
const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const bool = (value: unknown): boolean => value === true
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined

function isModelRef(value: unknown): value is ModelRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  return typeof v.provider === 'string' && v.provider !== '' && typeof v.id === 'string' && v.id !== ''
}

function checkText(value: unknown, what: string): string {
  if (typeof value !== 'string' || !wellFormed(value)) throw new InvalidInputError(`${what} must be a string`)
  return value
}

function checkModel(value: unknown, what = 'model'): ModelRef | null {
  if (value === null) return null
  if (!isModelRef(value)) throw new InvalidInputError(`${what} must be {provider, id} or null`)
  return { provider: checkText(value.provider, `${what}.provider`), id: checkText(value.id, `${what}.id`) }
}

function checkEffort(value: unknown): Effort | null {
  if (value === null) return null
  if (typeof value !== 'string' || !EFFORTS.has(value)) throw new InvalidInputError('Unknown effort')
  return value as Effort
}

function checkBool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new InvalidInputError(`${what} must be a boolean`)
  return value
}

function checkTools(value: unknown): ToolSnapshotEntry[] {
  if (!Array.isArray(value)) throw new InvalidInputError('tools must be an array')
  const out = value.map((entry, i): ToolSnapshotEntry => {
    if (entry === null || typeof entry !== 'object') throw new InvalidInputError(`tools[${i}] must be an object`)
    const e = entry as Record<string, unknown>
    const name = checkText(e.name, `tools[${i}].name`)
    if (typeof e.source !== 'string' || !TOOL_SOURCES.has(e.source)) throw new InvalidInputError('Bad tool source')
    const fingerprint = checkText(e.fingerprint, `tools[${i}].fingerprint`)
    const base = { name, source: e.source as ToolSnapshotEntry['source'], fingerprint }
    return e.origin === undefined ? base : { ...base, origin: checkText(e.origin, `tools[${i}].origin`) }
  })
  // The snapshot is sorted by name (spec/DATA-MODEL.md section 3.2): the same set always serialises the same way.
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** The 26-character manifest id of a blob (spec/FORMAT.md section 8.6). */
const BLOB_ID = /^[a-z2-7]{26}$/

/** Knowledge base ids, deduplicated, in the order given. */
function checkKnowledgeIds(value: unknown): Id[] {
  if (!Array.isArray(value)) throw new InvalidInputError('knowledge must be an array of knowledge base ids')
  const out: Id[] = []
  for (const id of value) {
    if (!isId(id)) throw new InvalidInputError('knowledge must be an array of knowledge base ids')
    if (!out.includes(id)) out.push(id)
  }
  return out
}

function checkEmbedder(value: unknown): EmbedderRef | null {
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidInputError('embedder must be an object or null')
  }
  const v = value as Record<string, unknown>
  const model = checkText(v.model, 'embedder.model')
  if (model === '') throw new InvalidInputError('embedder.model is empty')
  if (v.kind === 'local') return { kind: 'local', model }
  if (v.kind === 'provider') {
    if (!isId(v.provider)) throw new InvalidInputError('embedder.provider must be a provider id')
    return { kind: 'provider', provider: v.provider, model }
  }
  throw new InvalidInputError('Unknown embedder kind')
}

function checkKnowledgeDocument(value: unknown): KnowledgeDocument {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidInputError('A document must be an object')
  }
  const v = value as Record<string, unknown>
  if (typeof v.blob !== 'string' || !BLOB_ID.test(v.blob)) throw new InvalidInputError('document.blob is a blob id')
  const out: Record<string, unknown> = {
    blob: v.blob,
    name: checkText(v.name, 'document.name'),
    mediaType: checkText(v.mediaType, 'document.mediaType'),
  }
  if (v.index !== undefined) {
    if (typeof v.index !== 'string' || !BLOB_ID.test(v.index))
      throw new InvalidInputError('document.index is a blob id')
    out.index = v.index
  }
  for (const key of ['size', 'chunks', 'addedAt'] as const) {
    const n = v[key]
    if (n === undefined) continue
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new InvalidInputError(`document.${key}`)
    out[key] = n
  }
  return out as unknown as KnowledgeDocument
}

/** The documents of a stored base that read as documents; anything else is skipped, never repaired in place. */
function readDocuments(value: unknown): KnowledgeDocument[] {
  if (!Array.isArray(value)) return []
  const out: KnowledgeDocument[] = []
  for (const item of value) {
    try {
      out.push(checkKnowledgeDocument(item))
    } catch {
      // A document a newer build wrote in a shape this one does not know is left out of the view.
    }
  }
  return out
}

function readEmbedder(value: unknown): EmbedderRef | null {
  try {
    return checkEmbedder(value ?? null)
  } catch {
    return null
  }
}

function checkDocId(docId: unknown): DocId {
  if (typeof docId !== 'string' || !DOC_IDS.has(docId)) throw new InvalidInputError('Unknown document')
  return docId as DocId
}

/** Ids touched by a deep-observer batch on `root`, a map of entity maps. */
/** What `changedKeys` reads of a Yjs event; structural, so it accepts the events of any map's `observeDeep`. */
interface DeepEvent {
  readonly target: unknown
  readonly path: readonly (string | number)[]
  readonly changes: { readonly keys: ReadonlyMap<string, unknown> }
}

function changedKeys(events: readonly DeepEvent[], root: unknown): Set<string> {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.target === root) for (const key of event.changes.keys.keys()) ids.add(key)
    else {
      const first = event.path[0]
      if (typeof first === 'string') ids.add(first)
    }
  }
  return ids
}

const byCreated = (a: Message, b: Message): number =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

function checkSecretFree(value: unknown, path: string): void {
  if (typeof value === 'string') {
    if (SECRET_SHAPED.test(value)) throw new InvalidInputError(`${path} looks like an API key`)
  } else if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) checkSecretFree(item, `${path}[${i}]`)
  } else if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_NAME.test(key)) throw new InvalidInputError(`${path}.${key} looks like a secret`)
      checkSecretFree(item, `${path}.${key}`)
    }
  }
}

function checkBaseUrl(value: unknown): string {
  const text = checkText(value, 'baseUrl')
  let url: URL
  try {
    url = new URL(text)
  } catch (cause) {
    throw new InvalidInputError('baseUrl is not a URL', { cause })
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new InvalidInputError('baseUrl must be https (http only on the loopback)')
  }
  // Credentials in a URL would sync with the configuration: they belong in ProviderKeys.
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new InvalidInputError('baseUrl must not carry credentials, a query or a fragment')
  }
  return text.replace(/\/+$/, '')
}

/** An MCP endpoint: https (http on the loopback), no credentials, query or fragment (tokens go in device secrets). */
function checkMcpUrl(value: unknown): string {
  const text = checkText(value, 'url')
  let url: URL
  try {
    url = new URL(text)
  } catch (cause) {
    throw new InvalidInputError('url is not a URL', { cause })
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new InvalidInputError('url must be https (http only on the loopback)')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new InvalidInputError('url must not carry credentials, a query or a fragment')
  }
  return url.href
}

function checkMcpTools(value: unknown): McpToolChoice[] {
  if (!Array.isArray(value)) throw new InvalidInputError('tools must be an array')
  if (value.length > MCP_MAX_TOOLS) throw new InvalidInputError('Too many tools')
  const seen = new Set<string>()
  const out = value.map((entry, i): McpToolChoice => {
    if (entry === null || typeof entry !== 'object') throw new InvalidInputError(`tools[${i}] must be an object`)
    const e = entry as Record<string, unknown>
    const name = checkText(e.name, `tools[${i}].name`)
    if (name === '' || seen.has(name)) throw new InvalidInputError(`tools[${i}].name is empty or repeated`)
    seen.add(name)
    return {
      name,
      enabled: checkBool(e.enabled, `tools[${i}].enabled`),
      fingerprint: checkText(e.fingerprint, `tools[${i}].fingerprint`),
    }
  })
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** Validates MCP server fields; every field is required on create, none on update (and `prefix` never changes). */
function checkMcp(input: Record<string, unknown>, partial: boolean): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const [field, value] of Object.entries(input)) {
    if (value === undefined) continue
    if (!(partial ? MCP_PATCHABLE : MCP_FIELDS).has(field)) {
      if (SECRET_NAME.test(field))
        throw new InvalidInputError(`An MCP server never holds a ${field}: secrets are device-only`)
      throw new InvalidInputError(`Unknown or fixed MCP server field ${field}`)
    }
    switch (field) {
      case 'name': {
        const name = checkText(value, 'name').trim()
        if (name === '') throw new InvalidInputError('name is empty')
        out.set(field, name)
        break
      }
      case 'prefix':
        if (typeof value !== 'string' || !MCP_PREFIX.test(value)) throw new InvalidInputError('Invalid prefix')
        out.set(field, value)
        break
      case 'transport':
        if (typeof value !== 'string' || !MCP_TRANSPORTS.has(value)) throw new InvalidInputError('Unknown transport')
        out.set(field, value)
        break
      case 'auth':
        if (typeof value !== 'string' || !MCP_AUTHS.has(value)) throw new InvalidInputError('Unknown auth')
        out.set(field, value)
        break
      case 'url':
        out.set(field, checkMcpUrl(value))
        break
      case 'enabled':
        out.set(field, checkBool(value, field))
        break
      case 'tools':
        out.set(field, toAny(checkMcpTools(value), 'tools'))
        break
    }
    checkSecretFree(out.get(field), field)
  }
  if (!partial) {
    for (const field of ['name', 'prefix', 'transport', 'url', 'auth'])
      if (!out.has(field)) throw new InvalidInputError(`${field} missing`)
    if (!out.has('enabled')) out.set('enabled', true)
    out.set('tools', [])
  }
  return out
}

function readMcp(id: Id, m: Y.Map<unknown>): McpServerConfig {
  // Unknown fields (a newer build's) are kept: a reader never drops what it does not understand.
  const out: Record<string, unknown> = {}
  for (const [key, value] of m.entries()) if (value !== undefined) out[key] = value
  out.id = id
  out.name = str(out.name)
  out.prefix = str(out.prefix)
  out.transport = MCP_TRANSPORTS.has(str(out.transport)) ? out.transport : 'http'
  out.url = str(out.url)
  out.auth = MCP_AUTHS.has(str(out.auth)) ? out.auth : 'none'
  out.enabled = bool(out.enabled)
  out.tools = Array.isArray(out.tools)
    ? (out.tools as unknown[]).filter(
        (t): t is McpToolChoice =>
          t !== null &&
          typeof t === 'object' &&
          typeof (t as McpToolChoice).name === 'string' &&
          typeof (t as McpToolChoice).enabled === 'boolean' &&
          typeof (t as McpToolChoice).fingerprint === 'string',
      )
    : []
  out.createdAt = num(out.createdAt) ?? 0
  out.updatedAt = num(out.updatedAt) ?? out.createdAt
  const deletedAt = num(out.deletedAt)
  if (deletedAt === undefined) delete out.deletedAt
  else out.deletedAt = deletedAt
  return frozenCopy<McpServerConfig>(out)
}

/** Validates provider fields; returns the Any values to write, `undefined` meaning "remove this optional field". */
function checkProvider(input: Record<string, unknown>, partial: boolean): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const [field, value] of Object.entries(input)) {
    if (!PROVIDER_FIELDS.has(field)) {
      if (SECRET_NAME.test(field))
        throw new InvalidInputError(`A provider never holds a ${field}: keys are device-only`)
      throw new InvalidInputError(`Unknown provider field ${field}`)
    }
    if (value === undefined) {
      if (!partial || !PROVIDER_OPTIONAL.has(field)) throw new InvalidInputError(`${field} is required`)
      out.set(field, undefined)
      continue
    }
    switch (field) {
      case 'kind':
        if (typeof value !== 'string' || !PROVIDER_KINDS.has(value)) throw new InvalidInputError('Unknown kind')
        out.set(field, value)
        break
      case 'label':
      case 'preset':
      case 'defaultModel':
        out.set(field, checkText(value, field))
        break
      case 'baseUrl':
        out.set(field, checkBaseUrl(value))
        break
      case 'models':
        if (!Array.isArray(value)) throw new InvalidInputError('models must be an array')
        out.set(
          field,
          value.map((m, i) => checkText(m, `models[${i}]`)),
        )
        break
      case 'syncKey':
        out.set(field, checkBool(value, field))
        break
      case 'secret':
        // `secret` is the id of a synced secret, never the key itself.
        if (!isId(value)) throw new InvalidInputError('secret must be a secret id')
        out.set(field, value)
        break
      case 'overrides': {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new InvalidInputError('overrides must be an object')
        }
        out.set(field, toAny(value, 'overrides'))
        break
      }
    }
    if (field !== 'secret') checkSecretFree(out.get(field), field)
  }
  if (!partial) {
    for (const field of ['kind', 'label', 'syncKey'])
      if (!out.has(field)) throw new InvalidInputError(`${field} missing`)
  }
  return out
}

function validateMessage(input: NewMessage): Map<string, unknown> {
  if (input === null || typeof input !== 'object') throw new InvalidInputError('A message must be an object')
  const fields = new Map<string, unknown>()
  if (input.parent !== null && !isId(input.parent)) throw new InvalidInputError('parent must be a message id or null')
  fields.set('parent', input.parent)
  if (typeof input.role !== 'string' || !ROLES.has(input.role)) throw new InvalidInputError('Unknown role')
  fields.set('role', input.role)
  if (!Array.isArray(input.parts)) throw new InvalidInputError('parts must be an array')
  input.parts.forEach((part, i) => {
    if (part === null || typeof part !== 'object' || typeof (part as { type?: unknown }).type !== 'string') {
      throw new InvalidInputError(`parts[${i}] must be an object with a type`)
    }
  })
  fields.set('parts', toAny(input.parts, 'parts'))
  fields.set('model', checkModel(input.model))
  if (typeof input.status !== 'string' || !STATUSES.has(input.status)) throw new InvalidInputError('Unknown status')
  fields.set('status', input.status)
  if (input.usage !== undefined) {
    const usage = input.usage as Record<string, unknown>
    if (usage === null || typeof usage !== 'object') throw new InvalidInputError('usage must be an object')
    const clean: Record<string, number> = {}
    for (const [key, value] of Object.entries(usage)) {
      if (value === undefined) continue
      if (!(USAGE_KEYS as readonly string[]).includes(key)) throw new InvalidInputError(`Unknown usage field ${key}`)
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new InvalidInputError(`usage.${key} must be a token count`)
      }
      clean[key] = value
    }
    fields.set('usage', clean)
  }
  if (input.error !== undefined) {
    const e = input.error
    if (e === null || typeof e !== 'object') throw new InvalidInputError('error must be an object')
    fields.set('error', { code: checkText(e.code, 'error.code'), message: checkText(e.message, 'error.message') })
  }
  if (input.stop !== undefined) {
    if (typeof input.stop !== 'string' || !STOPS.has(input.stop)) throw new InvalidInputError('Unknown stop reason')
    fields.set('stop', input.stop)
  }
  if (input.refusal !== undefined) {
    const r = input.refusal
    if (r === null || typeof r !== 'object') throw new InvalidInputError('refusal must be an object')
    if (r.category !== null && typeof r.category !== 'string') throw new InvalidInputError('Bad refusal category')
    const refusal: Record<string, unknown> = {
      category: r.category === null ? null : checkText(r.category, 'category'),
    }
    if (r.explanation !== undefined) refusal.explanation = checkText(r.explanation, 'refusal.explanation')
    fields.set('refusal', refusal)
  }
  if (input.effort !== undefined) {
    if (typeof input.effort !== 'string' || !EFFORTS.has(input.effort)) throw new InvalidInputError('Unknown effort')
    fields.set('effort', input.effort)
  }
  if (input.createdAt !== undefined) {
    if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) throw new InvalidInputError('Bad createdAt')
    fields.set('createdAt', input.createdAt)
  }
  return fields
}

function readMessage(id: Id, m: Y.Map<unknown>): Message {
  const parts = m.get('parts')
  const out: Record<string, unknown> = {
    id,
    conv: str(m.get('conv')),
    parent: strOrNull(m.get('parent')),
    role: ROLES.has(str(m.get('role'))) ? m.get('role') : 'user',
    parts: Array.isArray(parts) ? parts : [],
    model: isModelRef(m.get('model')) ? m.get('model') : null,
    createdAt: num(m.get('createdAt')) ?? 0,
    status: STATUSES.has(str(m.get('status'))) ? m.get('status') : 'done',
  }
  for (const key of ['usage', 'error', 'refusal'] as const) {
    const value = m.get(key)
    if (value !== null && typeof value === 'object') out[key] = value
  }
  const stop = m.get('stop')
  if (typeof stop === 'string' && STOPS.has(stop)) out.stop = stop
  const effort = m.get('effort')
  if (typeof effort === 'string' && EFFORTS.has(effort)) out.effort = effort
  const deletedAt = num(m.get('deletedAt'))
  if (deletedAt !== undefined) out.deletedAt = deletedAt
  return frozenCopy<Message>(out)
}

function readConversation(id: Id, m: Y.Map<unknown>): Conversation {
  const createdAt = num(m.get('createdAt')) ?? 0
  const purgedAt = num(m.get('purgedAt'))
  if (purgedAt !== undefined) return deepFreeze({ id, createdAt, purgedAt } as unknown as Conversation)
  const effort = m.get('effort')
  const tools = m.get('tools')
  const out: Record<string, unknown> = {
    id,
    title: str(m.get('title')),
    folder: strOrNull(m.get('folder')),
    persona: strOrNull(m.get('persona')),
    model: isModelRef(m.get('model')) ? m.get('model') : null,
    effort: typeof effort === 'string' && EFFORTS.has(effort) ? effort : null,
    leaf: strOrNull(m.get('leaf')),
    system: str(m.get('system')),
    tools: Array.isArray(tools) ? tools : [],
    pinned: bool(m.get('pinned')),
    archived: bool(m.get('archived')),
    createdAt,
    updatedAt: num(m.get('updatedAt')) ?? createdAt,
  }
  const startedAt = num(m.get('startedAt'))
  if (startedAt !== undefined) out.startedAt = startedAt
  const deletedAt = num(m.get('deletedAt'))
  if (deletedAt !== undefined) out.deletedAt = deletedAt
  const knowledge = m.get('knowledge')
  if (Array.isArray(knowledge)) out.knowledge = knowledge.filter(isId)
  return frozenCopy<Conversation>(out)
}

function readFolder(id: Id, m: Y.Map<unknown>): Folder {
  const createdAt = num(m.get('createdAt')) ?? 0
  const out: Record<string, unknown> = {
    id,
    name: str(m.get('name')),
    parent: strOrNull(m.get('parent')),
    order: str(m.get('order')),
    createdAt,
    updatedAt: num(m.get('updatedAt')) ?? createdAt,
  }
  for (const key of ['deletedAt', 'purgedAt'] as const) {
    const value = num(m.get(key))
    if (value !== undefined) out[key] = value
  }
  return frozenCopy<Folder>(out)
}

function readKnowledge(id: Id, m: Y.Map<unknown>): KnowledgeBase {
  const createdAt = num(m.get('createdAt')) ?? 0
  const out: Record<string, unknown> = {
    id,
    name: str(m.get('name')),
    documents: readDocuments(m.get('documents')),
    embedder: readEmbedder(m.get('embedder')),
    createdAt,
    updatedAt: num(m.get('updatedAt')) ?? createdAt,
  }
  for (const key of ['deletedAt', 'purgedAt'] as const) {
    const value = num(m.get(key))
    if (value !== undefined) out[key] = value
  }
  return frozenCopy<KnowledgeBase>(out)
}

function readProvider(id: Id, m: Y.Map<unknown>): ProviderConfig {
  // Unknown fields (a newer build's) are kept: a reader never drops what it does not understand.
  const out: Record<string, unknown> = {}
  for (const [key, value] of m.entries()) if (value !== undefined) out[key] = value
  out.id = id
  out.kind = str(out.kind)
  out.label = str(out.label)
  out.syncKey = bool(out.syncKey)
  out.createdAt = num(out.createdAt) ?? 0
  out.updatedAt = num(out.updatedAt) ?? out.createdAt
  return frozenCopy<ProviderConfig>(out)
}

/** Fields every entity has, which a collection write never sets directly. */
const META_FIELDS: ReadonlySet<string> = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt', 'purgedAt'])

function readEntity<T>(id: Id, m: Y.Map<unknown>): Entity<T> {
  // Unknown fields (a newer build's) are kept, as for providers.
  const out: Record<string, unknown> = {}
  for (const [key, value] of m.entries()) if (value !== undefined) out[key] = value
  out.id = id
  out.createdAt = num(out.createdAt) ?? 0
  out.updatedAt = num(out.updatedAt) ?? out.createdAt
  for (const key of ['deletedAt', 'purgedAt'] as const) {
    if (out[key] !== undefined && num(out[key]) === undefined) delete out[key]
  }
  return frozenCopy<Entity<T>>(out)
}

/** Validates the fields of a collection write; `undefined` (partial writes only) means "remove this field". */
function checkEntityFields(name: string, input: unknown, partial: boolean): Map<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvalidInputError(`A ${name} entity must be an object`)
  }
  const out = new Map<string, unknown>()
  for (const [field, value] of Object.entries(input)) {
    if (META_FIELDS.has(field)) throw new InvalidInputError(`${field} is set by the workspace`)
    if (!wellFormed(field)) throw new InvalidInputError('A field name is not well-formed Unicode')
    if (SECRET_NAME.test(field)) throw new InvalidInputError(`A ${name} entity never holds a ${field}`)
    if (value === undefined) {
      if (partial) out.set(field, undefined)
      continue
    }
    const clean = toAny(value, field)
    checkSecretFree(clean, field)
    out.set(field, clean)
  }
  return out
}

const sortConversations = (a: Conversation, b: Conversation): number =>
  Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export async function openWorkspace(deps: WorkspaceDeps & WorkspaceOptions): Promise<Workspace> {
  const { store, subkeys, rng, clock } = deps
  const compactAt = Math.max(2, deps.compactAt ?? COMPACT_AT)
  const lock = deps.lock === undefined ? defaultLock() : deps.lock
  const withLock = <T>(docId: DocId, fn: () => Promise<T>): Promise<T> =>
    lock ? lock(`aparte-pending:${docId}`, fn) : fn()

  let closed = false
  const live = (): void => {
    if (closed) throw new LockedError('The workspace is closed')
  }

  // Documents, persistence and cross-tab notices

  const loading = new Map<DocId, Promise<Loaded>>()
  const loaded = new Map<DocId, Loaded>()
  const persistenceListeners = new Set<Listener>()
  let status: PersistenceStatus = Object.freeze({ unsaved: 0, blocked: false })

  const persistenceChanged = (): void => {
    let unsaved = 0
    let blocked = false
    for (const l of loaded.values()) {
      unsaved += l.capture.unsaved()
      blocked ||= l.capture.blocked()
    }
    if (unsaved === status.unsaved && blocked === status.blocked) return
    status = Object.freeze({ unsaved, blocked })
    for (const fn of [...persistenceListeners]) fn()
  }

  let channel: ChannelLike | null = null
  const notify = (docId: DocId): void => {
    try {
      channel?.postMessage({ type: 'changed', doc: docId })
    } catch {
      // A notice is only a hint: the other tabs also catch up when they next load the document.
    }
  }

  /** Applies the queue records another tab wrote; serialised per document, repeated while notices keep coming. */
  const catchUp = async (l: Loaded): Promise<void> => {
    if (l.syncing) {
      l.syncAgain = true
      return
    }
    l.syncing = true
    try {
      do {
        l.syncAgain = false
        const queue = await store.pending.list(l.id)
        if (closed) return
        Y.transact(
          l.doc,
          () => {
            for (const record of queue) if (!l.known.has(record.n)) Y.applyUpdateV2(l.doc, record.update)
          },
          'replay',
        )
        l.known = new Set(queue.map((record) => record.n))
        l.records = queue.length
      } while (l.syncAgain && !closed)
    } catch {
      // Catching up is retried on the next notice; the local state stays valid meanwhile.
    } finally {
      l.syncing = false
    }
  }

  const compactDoc = (docId: DocId): Promise<void> =>
    withLock(docId, async () => {
      const queue = await store.pending.list(docId)
      const last = queue.at(-1)
      if (queue.length <= 1 || last === undefined) return
      // Only the queue is merged, never the in-memory state: updates received from other devices are already stored
      // as segments and must not come back as this device's own changes.
      const merged = Y.mergeUpdatesV2(queue.map((record) => record.update))
      const n = await store.pending.append(docId, merged)
      await store.pending.drop(docId, last.n)
      const l = loaded.get(docId)
      if (l) {
        // Records appended meanwhile (by this tab or another) survive the drop; only the ones this instance already
        // applied stay known, so a catch-up still applies the others.
        const after = await store.pending.list(docId)
        const positions = new Set(after.map((record) => record.n))
        l.known = new Set([...l.known].filter((p) => positions.has(p)))
        l.known.add(n)
        l.records = after.length
      }
    })

  const scheduleCompaction = (l: Loaded): void => {
    if (l.compacting || l.records < compactAt || closed) return
    l.compacting = compactDoc(l.id).then(
      () => {
        l.compacting = null
        // Appends that landed during the compaction may have reached the threshold again.
        scheduleCompaction(l)
      },
      () => {
        // A failed compaction leaves the queue as it was (longer, never shorter than the state); the next append
        // tries again.
        l.compacting = null
      },
    )
  }

  const loadDoc = (docId: DocId): Promise<Loaded> => {
    const existing = loading.get(docId)
    if (existing) return existing
    const promise = (async (): Promise<Loaded> => {
      const [extra, queue] = await Promise.all([deps.base ? deps.base(docId) : [], store.pending.list(docId)])
      if (closed) throw new LockedError('The workspace is closed')
      const doc = new Y.Doc()
      Y.transact(
        doc,
        () => {
          for (const update of extra) {
            try {
              Y.applyUpdateV2(doc, update)
            } catch {
              // One mirrored update that does not apply must not keep the rest of the document from opening.
            }
          }
        },
        'remote',
      )
      try {
        Y.transact(
          doc,
          () => {
            for (const record of queue) Y.applyUpdateV2(doc, record.update)
          },
          'replay',
        )
      } catch (cause) {
        doc.destroy()
        throw new CorruptError(`The pending queue of ${docId} does not apply`, { cause })
      }
      const l: Loaded = {
        id: docId,
        doc,
        capture: undefined as unknown as Capture,
        known: new Set(queue.map((record) => record.n)),
        records: queue.length,
        compacting: null,
        syncing: false,
        syncAgain: false,
      }
      const append = (update: Uint8Array): Promise<void> =>
        withLock(docId, async () => {
          const n = await store.pending.append(docId, update)
          l.known.add(n)
          l.records++
        }).then(() => {
          notify(docId)
          scheduleCompaction(l)
        })
      ;(l as { capture: Capture }).capture = captureUpdates(doc, append, {
        onChange: persistenceChanged,
        ...(deps.retryDelayMs ? { retryDelayMs: deps.retryDelayMs } : {}),
      })
      loaded.set(docId, l)
      if (docId === 'index') attachIndex(doc)
      else attachShard(docId as ShardId, doc)
      scheduleCompaction(l)
      return l
    })()
    loading.set(docId, promise)
    promise.catch(() => loading.delete(docId))
    return promise
  }

  // Subscriptions

  const listeners = new Map<string, Set<Listener>>()
  const scopeKey = (scope: Scope): string => {
    if (typeof scope === 'string') {
      if (
        !['conversations', 'folders', 'settings', 'providers', 'toolApprovals', 'mcp', 'knowledge'].includes(scope) &&
        !(COLLECTIONS as readonly string[]).includes(scope)
      ) {
        throw new InvalidInputError('Unknown scope')
      }
      return scope
    }
    if (scope === null || typeof scope !== 'object' || typeof scope.conversation !== 'string') {
      throw new InvalidInputError('Unknown scope')
    }
    return `conv:${scope.conversation}`
  }
  const emit = (keys: Iterable<string>): void => {
    for (const key of keys) {
      const set = listeners.get(key)
      if (!set) continue
      for (const fn of [...set]) {
        try {
          fn()
        } catch (error) {
          // A failing listener must not abort the Yjs transaction that notified it, nor the other listeners.
          queueMicrotask(() => {
            throw error
          })
        }
      }
    }
  }

  // Index document

  let conversationsMap: Y.Map<Y.Map<unknown>>
  let foldersMap: Y.Map<Y.Map<unknown>>
  let settingsMap: Y.Map<unknown>
  let providersMap: Y.Map<Y.Map<unknown>>
  let approvalsMap: Y.Map<unknown>
  let knowledgeMap: Y.Map<Y.Map<unknown>>
  let approvalList: readonly ToolApproval[] | null = null
  const knowledgeCache = new Map<Id, KnowledgeBase>()
  const knowledgeLists = new Map<string, readonly KnowledgeBase[]>()
  const convCache = new Map<Id, Conversation>()
  const convLists = new Map<string, readonly Conversation[]>()
  const folderCache = new Map<Id, Folder>()
  const folderLists = new Map<string, readonly Folder[]>()
  const providerCache = new Map<Id, ProviderConfig>()
  let providerList: readonly ProviderConfig[] | null = null
  let mcpMap: Y.Map<Y.Map<unknown>>
  const mcpCache = new Map<Id, McpServerConfig>()
  let mcpList: readonly McpServerConfig[] | null = null
  const settingsCache = new Map<string, unknown>()
  const threadCaches = new Map<Id, ConvCache>()
  const collectionMaps = new Map<CollectionName, Y.Map<Y.Map<unknown>>>()
  /** Entities read, by `<collection>|<id>`. */
  const entityCache = new Map<string, Entity<unknown>>()
  /** Sorted lists, by `<collection>|<trashed>`. */
  const entityLists = new Map<string, readonly Entity<unknown>[]>()

  const attachIndex = (doc: Y.Doc): void => {
    conversationsMap = doc.getMap('conversations')
    foldersMap = doc.getMap('folders')
    settingsMap = doc.getMap('settings')
    providersMap = doc.getMap('providers')
    approvalsMap = doc.getMap('toolApprovals')
    mcpMap = doc.getMap('mcp')
    mcpMap.observeDeep((events) => {
      for (const id of changedKeys(events, mcpMap)) mcpCache.delete(id)
      mcpList = null
      emit(['mcp'])
    })
    knowledgeMap = doc.getMap('knowledge')
    knowledgeMap.observeDeep((events) => {
      for (const id of changedKeys(events, knowledgeMap)) knowledgeCache.delete(id)
      knowledgeLists.clear()
      emit(['knowledge'])
    })
    approvalsMap.observe(() => {
      approvalList = null
      emit(['toolApprovals'])
    })
    conversationsMap.observeDeep((events) => {
      const ids = changedKeys(events, conversationsMap)
      for (const id of ids) {
        convCache.delete(id)
        threadCaches.delete(id)
      }
      convLists.clear()
      emit(['conversations', ...[...ids].map((id) => `conv:${id}`)])
    })
    foldersMap.observeDeep((events) => {
      for (const id of changedKeys(events, foldersMap)) folderCache.delete(id)
      folderLists.clear()
      emit(['folders'])
    })
    settingsMap.observe(() => {
      settingsCache.clear()
      emit(['settings'])
    })
    providersMap.observeDeep((events) => {
      for (const id of changedKeys(events, providersMap)) providerCache.delete(id)
      providerList = null
      emit(['providers'])
    })
    for (const name of COLLECTIONS) {
      const map = doc.getMap<Y.Map<unknown>>(name)
      collectionMaps.set(name, map)
      map.observeDeep((events) => {
        for (const id of changedKeys(events, map)) entityCache.delete(`${name}|${id}`)
        entityLists.delete(`${name}|true`)
        entityLists.delete(`${name}|false`)
        emit([name])
      })
    }
  }

  // Shard documents

  const shards = new Map<ShardId, ShardState>()
  const messageCache = new Map<Id, Message>()

  const attachShard = (shardId: ShardId, doc: Y.Doc): void => {
    const messages = doc.getMap<Y.Map<unknown>>('messages')
    const state: ShardState = { messages, byConv: new Map(), convOf: new Map() }
    const index = (id: Id, conv: unknown): void => {
      if (typeof conv !== 'string') return
      state.convOf.set(id, conv)
      let set = state.byConv.get(conv)
      if (!set) {
        set = new Set()
        state.byConv.set(conv, set)
      }
      set.add(id)
    }
    for (const [id, m] of messages.entries()) if (m instanceof Y.Map) index(id, m.get('conv'))
    messages.observeDeep((events) => {
      const convs = new Set<Id>()
      for (const id of changedKeys(events, messages)) {
        messageCache.delete(id)
        const before = state.convOf.get(id)
        if (before !== undefined) {
          convs.add(before)
          state.byConv.get(before)?.delete(id)
          state.convOf.delete(id)
        }
        const m = messages.get(id)
        if (m instanceof Y.Map) {
          const conv = m.get('conv')
          index(id, conv)
          if (typeof conv === 'string') convs.add(conv)
        }
      }
      for (const conv of convs) threadCaches.delete(conv)
      emit([...convs].map((conv) => `conv:${conv}`))
    })
    shards.set(shardId, state)
  }

  // Writes

  const local = <T>(doc: Y.Doc, fn: () => T): T => {
    let out: T | undefined
    doc.transact(() => {
      out = fn()
    }, 'local')
    return out as T
  }
  const indexDoc = (): Y.Doc => (loaded.get('index') as Loaded).doc
  const now = (): number => safeTime(clock.now())
  const newId = (): Id => base32Encode(rng.bytes(16))

  const batch = <T>(fn: () => T): T => {
    live()
    const docs = [...loaded.values()].map((l) => l.doc)
    // Nested transactions on every loaded document: each one ends as a single transaction, hence a single update.
    const run = (i: number): T => {
      const doc = docs[i]
      return doc === undefined ? fn() : local(doc, () => run(i + 1))
    }
    return run(0)
  }

  // Conversations

  const convEntity = (id: Id): Y.Map<unknown> => {
    const m = typeof id === 'string' ? conversationsMap.get(id) : undefined
    if (!(m instanceof Y.Map)) throw new InvalidInputError('Unknown conversation')
    return m
  }
  const liveConvEntity = (id: Id): Y.Map<unknown> => {
    const m = convEntity(id)
    if (m.has('purgedAt')) throw new InvalidStateError('The conversation was purged')
    return m
  }
  const getConversation = (id: Id): Conversation | undefined => {
    const cached = convCache.get(id)
    if (cached) return cached
    const m = conversationsMap.get(id)
    if (!(m instanceof Y.Map)) return undefined
    const value = readConversation(id, m)
    convCache.set(id, value)
    return value
  }

  const checkFolderRef = (value: unknown): Id | null => {
    if (value === null) return null
    const m = typeof value === 'string' ? foldersMap.get(value) : undefined
    if (!(m instanceof Y.Map) || m.has('deletedAt') || m.has('purgedAt')) {
      throw new InvalidInputError('Unknown folder')
    }
    return value as Id
  }

  const shardIds = new Map<Id, ShardId>()
  const shardOf = async (id: Id): Promise<ShardId> => {
    live()
    const cached = shardIds.get(id)
    if (cached) return cached
    if (!isId(id)) throw new InvalidInputError('Not a conversation id')
    const shard = await shardOfBytes(subkeys, base32Decode(id))
    shardIds.set(id, shard)
    return shard
  }

  const conversations: Conversations = {
    list(filter: ConversationFilter = {}) {
      live()
      const trashed = filter.trashed === true
      const archived = filter.archived === true
      const folder = filter.folder
      const key = `${trashed}|${archived}|${folder === undefined ? '*' : String(folder)}`
      const cached = convLists.get(key)
      if (cached) return cached
      const out: Conversation[] = []
      for (const id of conversationsMap.keys()) {
        const c = getConversation(id)
        if (!c || c.purgedAt !== undefined) continue
        if (trashed ? c.deletedAt === undefined : c.deletedAt !== undefined || c.archived !== archived) continue
        if (folder !== undefined && c.folder !== folder) continue
        out.push(c)
      }
      const list = Object.freeze(out.sort(sortConversations))
      convLists.set(key, list)
      return list
    },
    get(id) {
      live()
      return getConversation(id)
    },
    create(input: NewConversation = {}) {
      live()
      const t = now()
      const fields: Record<string, unknown> = {
        title: input.title === undefined ? '' : checkText(input.title, 'title'),
        folder: input.folder === undefined ? null : checkFolderRef(input.folder),
        persona: input.persona === undefined || input.persona === null ? null : checkText(input.persona, 'persona'),
        model: input.model === undefined ? null : checkModel(input.model),
        effort: input.effort === undefined ? null : checkEffort(input.effort),
        leaf: null,
        system: input.system === undefined ? settings.get('defaultSystem') : checkText(input.system, 'system'),
        tools: input.tools === undefined ? [] : checkTools(input.tools),
        pinned: input.pinned === undefined ? false : checkBool(input.pinned, 'pinned'),
        archived: false,
        createdAt: t,
        updatedAt: t,
      }
      if (input.knowledge !== undefined) {
        const knowledge = checkKnowledgeIds(input.knowledge)
        if (knowledge.length > 0) fields.knowledge = knowledge
      }
      const id = newId()
      const entity = new Y.Map<unknown>(
        Object.entries({ id, ...fields }).map(([k, v]) => [k, toAny(v, k)] as [string, unknown]),
      )
      local(indexDoc(), () => conversationsMap.set(id, entity))
      return id
    },
    update(id, patch: ConversationPatch) {
      live()
      const m = liveConvEntity(id)
      if (patch === null || typeof patch !== 'object') throw new InvalidInputError('A patch must be an object')
      const writes: [string, unknown][] = []
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue
        switch (key) {
          case 'title':
            writes.push([key, checkText(value, key)])
            break
          case 'folder':
            writes.push([key, checkFolderRef(value)])
            break
          case 'model':
            writes.push([key, checkModel(value)])
            break
          case 'effort':
            writes.push([key, checkEffort(value)])
            break
          case 'pinned':
          case 'archived':
            writes.push([key, checkBool(value, key)])
            break
          case 'knowledge':
            // Attached bases feed user messages, never the frozen prefix: they may change at any time.
            writes.push([key, checkKnowledgeIds(value)])
            break
          case 'system':
          case 'tools':
            // The prefix a provider signed over never changes (spec/DATA-MODEL.md section 5, rules 1 and 2).
            if (m.has('startedAt')) throw new InvalidStateError(`${key} is frozen once the conversation started`)
            writes.push([key, key === 'system' ? checkText(value, key) : checkTools(value)])
            break
          default:
            throw new InvalidInputError(`${key} cannot be updated`)
        }
      }
      const t = now()
      local(indexDoc(), () => {
        for (const [key, value] of writes) m.set(key, toAny(value, key))
        m.set('updatedAt', t)
      })
    },
    trash(id) {
      live()
      const m = liveConvEntity(id)
      if (m.has('deletedAt')) return
      const t = now()
      local(indexDoc(), () => m.set('deletedAt', t))
    },
    restore(id) {
      live()
      const m = liveConvEntity(id)
      if (!m.has('deletedAt')) return
      local(indexDoc(), () => m.delete('deletedAt'))
    },
    async purge(id) {
      live()
      const m = liveConvEntity(id)
      if (!m.has('deletedAt')) throw new InvalidStateError('Only a trashed conversation can be purged')
      const shard = await shardOf(id)
      await loadDoc(shard)
      live()
      const state = shards.get(shard) as ShardState
      const entity = liveConvEntity(id)
      const t = now()
      batch(() => {
        for (const messageId of [...(state.byConv.get(id) ?? [])]) state.messages.delete(messageId)
        for (const key of [...entity.keys()]) if (key !== 'id' && key !== 'createdAt') entity.delete(key)
        entity.set('purgedAt', t)
      })
    },
    shardOf,
  }

  // Folders

  const getFolder = (id: Id): Folder | undefined => {
    const cached = folderCache.get(id)
    if (cached) return cached
    const m = foldersMap.get(id)
    if (!(m instanceof Y.Map)) return undefined
    const value = readFolder(id, m)
    folderCache.set(id, value)
    return value
  }
  const folderEntity = (id: Id): Y.Map<unknown> => {
    const m = typeof id === 'string' ? foldersMap.get(id) : undefined
    if (!(m instanceof Y.Map) || m.has('purgedAt')) throw new InvalidInputError('Unknown folder')
    return m
  }
  const lastOrder = (parent: Id | null): string | null => {
    let last: string | null = null
    for (const id of foldersMap.keys()) {
      const f = getFolder(id)
      if (f && f.parent === parent && f.purgedAt === undefined && (last === null || f.order > last)) last = f.order
    }
    return last
  }

  const folders: Folders = {
    list(options = {}) {
      live()
      const trashed = options.trashed === true
      const key = String(trashed)
      const cached = folderLists.get(key)
      if (cached) return cached
      const out: Folder[] = []
      for (const id of foldersMap.keys()) {
        const f = getFolder(id)
        if (f && f.purgedAt === undefined && (f.deletedAt !== undefined) === trashed) out.push(f)
      }
      out.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const list = Object.freeze(out)
      folderLists.set(key, list)
      return list
    },
    get(id) {
      live()
      return getFolder(id)
    },
    create(input) {
      live()
      if (input === null || typeof input !== 'object') throw new InvalidInputError('A folder needs a name')
      const name = checkText(input.name, 'name')
      const parent = input.parent === undefined ? null : checkFolderRef(input.parent)
      const order = input.order === undefined ? keyAfter(lastOrder(parent)) : checkText(input.order, 'order')
      const t = now()
      const id = newId()
      const entity = new Y.Map<unknown>([
        ['id', id],
        ['name', name],
        ['parent', parent],
        ['order', order],
        ['createdAt', t],
        ['updatedAt', t],
      ])
      local(indexDoc(), () => foldersMap.set(id, entity))
      return id
    },
    update(id, patch) {
      live()
      const m = folderEntity(id)
      const writes: [string, unknown][] = []
      if (patch.name !== undefined) writes.push(['name', checkText(patch.name, 'name')])
      if (patch.order !== undefined) writes.push(['order', checkText(patch.order, 'order')])
      if (patch.parent !== undefined) {
        const parent = checkFolderRef(patch.parent)
        // Walking up from the new parent must never reach the folder itself, or the tree would get a cycle.
        const seen = new Set<Id>()
        for (let at: Id | null = parent; at !== null; at = getFolder(at)?.parent ?? null) {
          if (at === id) throw new InvalidInputError('A folder cannot move inside its own subtree')
          if (seen.has(at)) break
          seen.add(at)
        }
        writes.push(['parent', parent])
      }
      const t = now()
      local(indexDoc(), () => {
        for (const [key, value] of writes) m.set(key, value)
        m.set('updatedAt', t)
      })
    },
    trash(id) {
      live()
      const m = folderEntity(id)
      if (m.has('deletedAt')) return
      const parent = strOrNull(m.get('parent'))
      const t = now()
      local(indexDoc(), () => {
        m.set('deletedAt', t)
        // Trashing never trashes content: the conversations go to the root, the subfolders up one level.
        for (const c of conversationsMap.values())
          if (c instanceof Y.Map && c.get('folder') === id) c.set('folder', null)
        for (const f of foldersMap.values()) if (f instanceof Y.Map && f.get('parent') === id) f.set('parent', parent)
      })
    },
    restore(id) {
      live()
      const m = folderEntity(id)
      if (!m.has('deletedAt')) return
      local(indexDoc(), () => m.delete('deletedAt'))
    },
  }

  // Settings

  const settings: SettingsRepo = {
    get(key) {
      live()
      if (!(key in SETTINGS_DEFAULTS)) throw new InvalidInputError('Unknown setting')
      if (settingsCache.has(key)) return settingsCache.get(key) as Settings[typeof key]
      const raw = settingsMap.get(key)
      let value: unknown = SETTINGS_DEFAULTS[key]
      if (key === 'defaultModel' && isModelRef(raw)) value = frozenCopy(raw)
      else if (key === 'defaultEffort' && typeof raw === 'string' && EFFORTS.has(raw)) value = raw
      else if (key === 'defaultSystem' && typeof raw === 'string') value = raw
      settingsCache.set(key, value)
      return value as Settings[typeof key]
    },
    set(key, value) {
      live()
      let clean: unknown
      if (key === 'defaultModel') clean = checkModel(value, 'defaultModel')
      else if (key === 'defaultEffort') clean = checkEffort(value)
      else if (key === 'defaultSystem') clean = checkText(value, 'defaultSystem')
      else throw new InvalidInputError('Unknown setting')
      local(indexDoc(), () => settingsMap.set(key, clean))
    },
  }

  // Tool approvals (spec/DATA-MODEL.md section 3.4): one key per approval, so two devices granting different tools
  // never overwrite each other.

  const approvalKeyFor = (approvalKey: string, conversation: Id | null): string =>
    conversation === null ? `always|${approvalKey}` : `conversation|${conversation}|${approvalKey}`
  const readApproval = (raw: unknown): ToolApproval | undefined => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const v = raw as Record<string, unknown>
    if (typeof v.approvalKey !== 'string' || typeof v.fingerprint !== 'string') return undefined
    const conversation = v.conversation === null ? null : isId(v.conversation) ? v.conversation : undefined
    if (conversation === undefined) return undefined
    return frozenCopy<ToolApproval>({
      approvalKey: v.approvalKey,
      fingerprint: v.fingerprint,
      conversation,
      grantedAt: num(v.grantedAt) ?? 0,
    })
  }

  const toolApprovals: ToolApprovals = {
    list() {
      live()
      if (approvalList) return approvalList
      const out: ToolApproval[] = []
      for (const value of approvalsMap.values()) {
        const a = readApproval(value)
        if (a) out.push(a)
      }
      out.sort(
        (a, b) =>
          Number(a.conversation !== null) - Number(b.conversation !== null) ||
          (a.approvalKey < b.approvalKey ? -1 : a.approvalKey > b.approvalKey ? 1 : 0) ||
          ((a.conversation ?? '') < (b.conversation ?? '') ? -1 : 1),
      )
      approvalList = Object.freeze(out)
      return approvalList
    },
    get(approvalKey, conversation) {
      live()
      const a = readApproval(approvalsMap.get(approvalKeyFor(approvalKey, conversation)))
      return a !== undefined && a.approvalKey === approvalKey && a.conversation === conversation ? a : undefined
    },
    grant(input) {
      live()
      const approvalKey = checkText(input.approvalKey, 'approvalKey')
      const fingerprint = checkText(input.fingerprint, 'fingerprint')
      if (approvalKey === '' || fingerprint === '')
        throw new InvalidInputError('An approval needs a key and a fingerprint')
      const conversation = input.conversation
      if (conversation !== null && !isId(conversation)) throw new InvalidInputError('Unknown conversation')
      const value = { approvalKey, fingerprint, conversation, grantedAt: now() }
      local(indexDoc(), () => approvalsMap.set(approvalKeyFor(approvalKey, conversation), toAny(value, 'approval')))
    },
    revoke(approvalKey, conversation) {
      live()
      const key = approvalKeyFor(approvalKey, conversation)
      if (!approvalsMap.has(key)) return
      local(indexDoc(), () => approvalsMap.delete(key))
    },
  }

  // Knowledge bases (spec/DATA-MODEL.md section 3)

  const getKnowledge = (id: Id): KnowledgeBase | undefined => {
    const cached = knowledgeCache.get(id)
    if (cached) return cached
    const m = knowledgeMap.get(id)
    if (!(m instanceof Y.Map)) return undefined
    const value = readKnowledge(id, m)
    knowledgeCache.set(id, value)
    return value
  }
  const knowledgeEntity = (id: Id): Y.Map<unknown> => {
    const m = typeof id === 'string' ? knowledgeMap.get(id) : undefined
    if (!(m instanceof Y.Map) || m.has('purgedAt')) throw new InvalidInputError('Unknown knowledge base')
    return m
  }
  const writeDocuments = (m: Y.Map<unknown>, documents: readonly KnowledgeDocument[]): void => {
    const t = now()
    local(indexDoc(), () => {
      m.set('documents', toAny(documents, 'documents'))
      m.set('updatedAt', t)
    })
  }

  const knowledge: KnowledgeBases = {
    list(options = {}) {
      live()
      const trashed = options.trashed === true
      const key = String(trashed)
      const cached = knowledgeLists.get(key)
      if (cached) return cached
      const out: KnowledgeBase[] = []
      for (const id of knowledgeMap.keys()) {
        const k = getKnowledge(id)
        if (k && k.purgedAt === undefined && (k.deletedAt !== undefined) === trashed) out.push(k)
      }
      out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const list = Object.freeze(out)
      knowledgeLists.set(key, list)
      return list
    },
    get(id) {
      live()
      return getKnowledge(id)
    },
    create(input) {
      live()
      if (input === null || typeof input !== 'object') throw new InvalidInputError('A knowledge base needs a name')
      const name = checkText(input.name, 'name')
      const embedder = input.embedder === undefined ? null : checkEmbedder(input.embedder)
      const t = now()
      const id = newId()
      const entity = new Y.Map<unknown>([
        ['id', id],
        ['name', name],
        ['documents', []],
        ['embedder', toAny(embedder, 'embedder')],
        ['createdAt', t],
        ['updatedAt', t],
      ])
      local(indexDoc(), () => knowledgeMap.set(id, entity))
      return id
    },
    update(id, patch) {
      live()
      const m = knowledgeEntity(id)
      if (patch === null || typeof patch !== 'object') throw new InvalidInputError('A patch must be an object')
      const writes: [string, unknown][] = []
      if (patch.name !== undefined) writes.push(['name', checkText(patch.name, 'name')])
      if (patch.embedder !== undefined) writes.push(['embedder', toAny(checkEmbedder(patch.embedder), 'embedder')])
      const t = now()
      local(indexDoc(), () => {
        for (const [key, value] of writes) m.set(key, value)
        m.set('updatedAt', t)
      })
    },
    addDocument(id, document) {
      live()
      const m = knowledgeEntity(id)
      const doc = checkKnowledgeDocument(document)
      const documents = readDocuments(m.get('documents'))
      const at = documents.findIndex((d) => d.blob === doc.blob)
      if (at >= 0) documents[at] = doc
      else documents.push(doc)
      writeDocuments(m, documents)
    },
    removeDocument(id, blob) {
      live()
      const m = knowledgeEntity(id)
      const documents = readDocuments(m.get('documents'))
      const kept = documents.filter((d) => d.blob !== blob)
      if (kept.length !== documents.length) writeDocuments(m, kept)
    },
    trash(id) {
      live()
      const m = knowledgeEntity(id)
      if (m.has('deletedAt')) return
      const t = now()
      local(indexDoc(), () => m.set('deletedAt', t))
    },
    restore(id) {
      live()
      const m = knowledgeEntity(id)
      if (!m.has('deletedAt')) return
      local(indexDoc(), () => m.delete('deletedAt'))
    },
  }

  // Providers

  const getProvider = (id: Id): ProviderConfig | undefined => {
    const cached = providerCache.get(id)
    if (cached) return cached
    const m = providersMap.get(id)
    if (!(m instanceof Y.Map)) return undefined
    const value = readProvider(id, m)
    providerCache.set(id, value)
    return value
  }
  const providerEntity = (id: Id): Y.Map<unknown> => {
    const m = typeof id === 'string' ? providersMap.get(id) : undefined
    if (!(m instanceof Y.Map)) throw new InvalidInputError('Unknown provider')
    return m
  }

  const providers: Providers = {
    list() {
      live()
      if (providerList) return providerList
      const out: ProviderConfig[] = []
      for (const id of providersMap.keys()) {
        const p = getProvider(id)
        if (p && p.deletedAt === undefined) out.push(p)
      }
      out.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      providerList = Object.freeze(out)
      return providerList
    },
    get(id) {
      live()
      return getProvider(id)
    },
    create(input: NewProvider) {
      live()
      if (input === null || typeof input !== 'object') throw new InvalidInputError('A provider must be an object')
      const fields = checkProvider(input as unknown as Record<string, unknown>, false)
      const t = now()
      const id = newId()
      const entity = new Y.Map<unknown>([['id', id], ...fields.entries(), ['createdAt', t], ['updatedAt', t]])
      local(indexDoc(), () => providersMap.set(id, entity))
      return id
    },
    update(id, patch) {
      live()
      const m = providerEntity(id)
      if (patch === null || typeof patch !== 'object') throw new InvalidInputError('A patch must be an object')
      const fields = checkProvider(patch as Record<string, unknown>, true)
      const t = now()
      local(indexDoc(), () => {
        for (const [key, value] of fields) {
          if (value === undefined) m.delete(key)
          else m.set(key, value)
        }
        m.set('updatedAt', t)
      })
    },
    trash(id) {
      live()
      const m = providerEntity(id)
      if (m.has('deletedAt')) return
      const t = now()
      local(indexDoc(), () => m.set('deletedAt', t))
    },
  }

  // MCP servers

  const getMcp = (id: Id): McpServerConfig | undefined => {
    const cached = mcpCache.get(id)
    if (cached) return cached
    const m = mcpMap.get(id)
    if (!(m instanceof Y.Map)) return undefined
    const value = readMcp(id, m)
    mcpCache.set(id, value)
    return value
  }
  const mcpEntity = (id: Id): Y.Map<unknown> => {
    const m = typeof id === 'string' ? mcpMap.get(id) : undefined
    if (!(m instanceof Y.Map)) throw new InvalidInputError('Unknown MCP server')
    return m
  }

  const mcp: McpServers = {
    list() {
      live()
      if (mcpList) return mcpList
      const out: McpServerConfig[] = []
      for (const id of mcpMap.keys()) {
        const server = getMcp(id)
        if (server && server.deletedAt === undefined) out.push(server)
      }
      out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      mcpList = Object.freeze(out)
      return mcpList
    },
    get(id) {
      live()
      return getMcp(id)
    },
    create(input: NewMcpServer) {
      live()
      if (input === null || typeof input !== 'object') throw new InvalidInputError('A server must be an object')
      const fields = checkMcp(input as unknown as Record<string, unknown>, false)
      if (mcp.list().some((s) => s.prefix === fields.get('prefix'))) {
        throw new InvalidInputError('This prefix is taken by another server')
      }
      const t = now()
      const id = newId()
      const entity = new Y.Map<unknown>([['id', id], ...fields.entries(), ['createdAt', t], ['updatedAt', t]])
      local(indexDoc(), () => mcpMap.set(id, entity))
      return id
    },
    update(id, patch: McpServerPatch) {
      live()
      const m = mcpEntity(id)
      if (patch === null || typeof patch !== 'object') throw new InvalidInputError('A patch must be an object')
      const fields = checkMcp(patch as Record<string, unknown>, true)
      if (fields.size === 0) return
      const t = now()
      local(indexDoc(), () => {
        for (const [key, value] of fields) m.set(key, value)
        m.set('updatedAt', t)
      })
    },
    trash(id) {
      live()
      const m = mcpEntity(id)
      if (m.has('deletedAt')) return
      const t = now()
      local(indexDoc(), () => m.set('deletedAt', t))
    },
  }

  // Collections (contracts/extras.ts)

  const collections = new Map<CollectionName, Collection<unknown>>()

  const makeCollection = <T>(name: CollectionName): Collection<T> => {
    const map = (): Y.Map<Y.Map<unknown>> => collectionMaps.get(name) as Y.Map<Y.Map<unknown>>
    const read = (id: Id): Entity<T> | undefined => {
      const key = `${name}|${id}`
      const cached = entityCache.get(key)
      if (cached) return cached as Entity<T>
      const m = typeof id === 'string' ? map().get(id) : undefined
      if (!(m instanceof Y.Map)) return undefined
      const value = readEntity<T>(id, m)
      entityCache.set(key, value as Entity<unknown>)
      return value
    }
    const entity = (id: Id): Y.Map<unknown> => {
      const m = typeof id === 'string' ? map().get(id) : undefined
      if (!(m instanceof Y.Map) || m.has('purgedAt')) throw new InvalidInputError(`Unknown ${name} entity`)
      return m
    }
    return {
      list(options = {}) {
        live()
        const trashed = options.trashed === true
        const key = `${name}|${trashed}`
        const cached = entityLists.get(key)
        if (cached) return cached as readonly Entity<T>[]
        const out: Entity<T>[] = []
        for (const id of map().keys()) {
          const e = read(id)
          if (e && e.purgedAt === undefined && (e.deletedAt !== undefined) === trashed) out.push(e)
        }
        out.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        const list = Object.freeze(out)
        entityLists.set(key, list as readonly Entity<unknown>[])
        return list
      },
      get(id) {
        live()
        return read(id)
      },
      create(fields, options = {}) {
        live()
        const clean = checkEntityFields(name, fields, false)
        let id: Id
        if (options.id === undefined) id = newId()
        else {
          if (!isId(options.id)) throw new InvalidInputError('An entity id is 26 base32 characters')
          if (map().has(options.id)) throw new InvalidInputError(`This ${name} entity exists`)
          id = options.id
        }
        const t = now()
        const m = new Y.Map<unknown>([['id', id], ...clean.entries(), ['createdAt', t], ['updatedAt', t]])
        local(indexDoc(), () => map().set(id, m))
        return id
      },
      update(id, patch) {
        live()
        const m = entity(id)
        const clean = checkEntityFields(name, patch, true)
        const t = now()
        local(indexDoc(), () => {
          for (const [key, value] of clean) {
            if (value === undefined) m.delete(key)
            else m.set(key, value)
          }
          m.set('updatedAt', t)
        })
      },
      trash(id) {
        live()
        const m = entity(id)
        if (m.has('deletedAt')) return
        const t = now()
        local(indexDoc(), () => m.set('deletedAt', t))
      },
      restore(id) {
        live()
        const m = entity(id)
        if (!m.has('deletedAt')) return
        local(indexDoc(), () => m.delete('deletedAt'))
      },
    }
  }

  const collection = <N extends CollectionName>(name: N): Collection<CollectionTypes[N]> => {
    live()
    if (!(COLLECTIONS as readonly string[]).includes(name)) throw new InvalidInputError('Unknown collection')
    let c = collections.get(name)
    if (!c) {
      c = makeCollection<unknown>(name)
      collections.set(name, c)
    }
    return c as Collection<CollectionTypes[N]>
  }

  // Threads

  const threads = new Map<Id, Thread>()

  const makeThread = (conversationId: Id, state: ShardState): Thread => {
    const cache = (): ConvCache => {
      let c = threadCaches.get(conversationId)
      if (!c) {
        c = {}
        threadCaches.set(conversationId, c)
      }
      return c
    }
    const get = (id: Id): Message | undefined => {
      live()
      if (typeof id !== 'string') return undefined
      let message = messageCache.get(id)
      if (!message) {
        const m = state.messages.get(id)
        if (!(m instanceof Y.Map)) return undefined
        message = readMessage(id, m)
        messageCache.set(id, message)
      }
      return message.conv === conversationId ? message : undefined
    }
    const all = (): readonly Message[] => {
      live()
      const c = cache()
      if (c.all) return c.all
      const out: Message[] = []
      for (const id of state.byConv.get(conversationId) ?? []) {
        const m = get(id)
        if (m) out.push(m)
      }
      c.all = Object.freeze(out.sort(byCreated))
      return c.all
    }
    const children = (parent: Id | null): readonly Message[] => {
      const c = cache()
      const list = all()
      c.children ??= new Map()
      const cached = c.children.get(parent)
      if (cached) return cached
      const out = Object.freeze(list.filter((m) => m.parent === parent))
      c.children.set(parent, out)
      return out
    }
    const own = (id: Id): Message => {
      const m = get(id)
      if (!m) throw new InvalidInputError('Not a message of this conversation')
      return m
    }

    return {
      conversationId,
      all,
      get,
      path(leaf) {
        live()
        const target = leaf === undefined ? (getConversation(conversationId)?.leaf ?? null) : leaf
        if (target === null) return Object.freeze([])
        const c = cache()
        c.paths ??= new Map()
        const cached = c.paths.get(target)
        if (cached) return cached
        const out: Message[] = []
        const seen = new Set<Id>()
        for (let at: Id | null = target; at !== null; ) {
          if (seen.has(at)) throw new CorruptError('The message tree has a cycle')
          seen.add(at)
          const m = get(at)
          if (!m) throw new CorruptError('A message of the branch is missing')
          out.push(m)
          at = m.parent
        }
        const path = Object.freeze(out.reverse())
        c.paths.set(target, path)
        return path
      },
      children(parent) {
        live()
        return children(parent)
      },
      siblings(id) {
        live()
        const m = own(id)
        const messages = children(m.parent)
        return Object.freeze({ messages, index: messages.indexOf(m) })
      },
      descend(id) {
        live()
        own(id)
        const seen = new Set<Id>()
        let at = id
        for (;;) {
          seen.add(at)
          const next = children(at).at(-1)
          if (!next || seen.has(next.id)) return at
          at = next.id
        }
      },
      commit(message) {
        live()
        const entity = liveConvEntity(conversationId)
        const fields = validateMessage(message)
        if (!isId(message.id)) throw new InvalidInputError('A message id is 26 base32 characters')
        if (state.messages.has(message.id)) throw new InvalidInputError('This message id exists')
        if (message.parent !== null) own(message.parent)
        const t = now()
        if (!fields.has('createdAt')) fields.set('createdAt', t)
        const ordered = new Map<string, unknown>([['conv', conversationId], ...fields])
        batch(() => {
          state.messages.set(message.id, new Y.Map<unknown>([...ordered.entries()]))
          if (!entity.has('startedAt')) entity.set('startedAt', t)
          entity.set('updatedAt', t)
        })
      },
      setLeaf(id, options) {
        live()
        const entity = liveConvEntity(conversationId)
        if (id !== null) own(id)
        const current = strOrNull(entity.get('leaf'))
        if (options && current !== options.ifLeaf) return false
        if (current !== id) local(indexDoc(), () => entity.set('leaf', id))
        return true
      },
      delete(id) {
        live()
        own(id)
        const m = state.messages.get(id) as Y.Map<unknown>
        if (m.has('deletedAt')) return
        const t = now()
        local(m.doc as Y.Doc, () => m.set('deletedAt', t))
      },
    }
  }

  // Open

  await loadDoc('index')
  channel = (deps.channel === undefined ? defaultChannel : (deps.channel ?? (() => null)))()
  if (channel) {
    channel.onmessage = (event) => {
      const data = event.data as { type?: unknown; doc?: unknown } | null
      if (closed || data === null || typeof data !== 'object' || data.type !== 'changed') return
      if (typeof data.doc !== 'string' || !DOC_IDS.has(data.doc)) return
      void loading
        .get(data.doc as DocId)
        ?.then(catchUp)
        .catch(() => {})
    }
  }

  const workspace: Workspace = {
    conversations,
    folders,
    settings,
    providers,
    toolApprovals,
    mcp,
    collection,
    knowledge,
    async thread(conversationId) {
      live()
      const m = convEntity(conversationId)
      if (m.has('purgedAt')) throw new InvalidInputError('The conversation was purged')
      const shard = await shardOf(conversationId)
      await loadDoc(shard)
      live()
      if (conversationsMap.get(conversationId)?.has('purgedAt')) {
        throw new InvalidInputError('The conversation was purged')
      }
      let thread = threads.get(conversationId)
      if (!thread) {
        thread = makeThread(conversationId, shards.get(shard) as ShardState)
        threads.set(conversationId, thread)
      }
      return thread
    },
    batch,
    subscribe(scope, fn) {
      live()
      const key = scopeKey(scope)
      let set = listeners.get(key)
      if (!set) {
        set = new Set()
        listeners.set(key, set)
      }
      const entry = (): void => fn()
      set.add(entry)
      return () => {
        listeners.get(key)?.delete(entry)
      }
    },
    async flush() {
      live()
      for (;;) {
        const captures = [...loaded.values()].map((l) => l.capture)
        await Promise.all(captures.map((c) => c.settled()))
        live()
        const blocked = captures.find((c) => c.blocked())
        if (blocked) {
          const cause = blocked.lastError()
          throw cause instanceof Error ? cause : new InvalidStateError('Not saved on this device', { cause })
        }
        if (captures.every((c) => c.unsaved() === 0) && loaded.size === captures.length) return
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    },
    persistence() {
      live()
      return status
    },
    onPersistence(fn) {
      live()
      const entry = (): void => fn()
      persistenceListeners.add(entry)
      return () => {
        persistenceListeners.delete(entry)
      }
    },
    async state(docId) {
      live()
      const l = await loadDoc(checkDocId(docId))
      live()
      return new Uint8Array(Y.encodeStateAsUpdateV2(l.doc)) as Bytes
    },
    async applyRemote(docId, update) {
      live()
      if (!(update instanceof Uint8Array)) throw new InvalidInputError('An update is bytes')
      const l = await loadDoc(checkDocId(docId))
      live()
      try {
        Y.applyUpdateV2(l.doc, update, 'remote')
      } catch (cause) {
        throw new CorruptError('The update does not apply', { cause })
      }
    },
    isLoaded(docId) {
      live()
      // A document still loading counts: an update applied to it now waits for the load, so none is missed.
      return loading.has(checkDocId(docId))
    },
    async compact(docId) {
      live()
      const id = checkDocId(docId)
      const l = loaded.get(id)
      // Captured updates are written first, so the merged record covers them.
      if (l) await l.capture.settled()
      live()
      if (l?.compacting) await l.compacting
      await compactDoc(id)
    },
    close() {
      if (closed) return
      closed = true
      if (channel) {
        channel.onmessage = null
        try {
          channel.close()
        } catch {
          // Closing a channel that is already closed is harmless.
        }
      }
      channel = null
      for (const l of loaded.values()) {
        l.capture.stop()
        l.doc.destroy()
      }
      loaded.clear()
      loading.clear()
      shards.clear()
      threads.clear()
      messageCache.clear()
      threadCaches.clear()
      convCache.clear()
      convLists.clear()
      folderCache.clear()
      folderLists.clear()
      providerCache.clear()
      providerList = null
      mcpCache.clear()
      mcpList = null
      approvalList = null
      knowledgeCache.clear()
      knowledgeLists.clear()
      settingsCache.clear()
      entityCache.clear()
      entityLists.clear()
      collections.clear()
      collectionMaps.clear()
      shardIds.clear()
      listeners.clear()
      persistenceListeners.clear()
      status = Object.freeze({ unsaved: 0, blocked: false })
    },
  }
  return workspace
}
