/*
 * Contract of the workspace: the vault's 17 Yjs documents (spec/DATA-MODEL.md), their entities, the conversation
 * message tree, and their encrypted persistence on this device. Implemented by web/src/core/workspace/workspace.ts,
 * the only module that touches Yjs.
 *
 * Invariants:
 * - The `index` document is loaded at open; a shard (`c00` to `c15`) is loaded when one of its conversations is first
 *   opened (`thread`), searched or purged. A conversation's shard is `shardOf(subkeys, base32Decode(id))` and never
 *   changes; its messages are written to that shard only.
 * - Nothing readable is stored. Every local Yjs update (v2 encoding) is appended to the LocalStore pending queue of its
 *   document, which seals it as a kind-6 envelope (spec/FORMAT.md section 11). Opening replays the queue. No update is
 *   persisted before every earlier update of the same document has been acknowledged.
 * - Updates applied from the pending queue (origin `replay`) or from another device (origin `remote`) are not
 *   captured again; everything else is (origin `local`).
 * - Secrets never enter a document: a value that holds an API key is refused (keys live in `ProviderKeys`).
 * - Messages are immutable once committed: `parts`, `role`, `parent`, `model`, `status`, `usage`, `error`, `stop` and
 *   `refusal` are written once by `commit`. The only later write to a message is `deletedAt`, and it is final.
 * - Values are Yjs `Any` (spec/DATA-MODEL.md section 2): an optional field that is absent is not set, never
 *   `undefined`; numbers are finite and timestamps are safe integers.
 * - Reads return frozen plain objects, the same object for an entity until it changes (safe for
 *   `useSyncExternalStore`).
 */

import type { Effort, ProviderConfig, StopReason, Usage } from './ai.ts'
import type { Bytes, DocId, Rng, ShardId, Subkeys } from './crypto.ts'
import type { CollectionName, CollectionTypes } from './extras.ts'
import type { McpServers } from './mcp.ts'
import type { LocalStore } from './store.ts'
import type { ToolApprovals, ToolSource } from './tools.ts'
import type { Clock } from './vault.ts'

/** A 26-character base32 id of 16 random bytes (spec/FORMAT.md section 4). */
export type Id = string

/** `{provider: providerId, id: modelId}`. */
export interface ModelRef {
  readonly provider: Id
  readonly id: string
}

export type Role = 'user' | 'assistant' | 'system' | 'tool'

/** Opaque provider data keyed by provider kind, replayed byte for byte to that provider only (DATA-MODEL 4.2). */
export type ProviderMeta = { readonly [kind: string]: unknown }

/** Message content, tagged by `type` (spec/DATA-MODEL.md section 4.2). Unknown members are kept and replayed. */
export type Part =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'reasoning'; readonly text: string; readonly providerMeta?: ProviderMeta }
  | {
      readonly type: 'image'
      readonly blob: string
      readonly mediaType: string
      readonly width: number
      readonly height: number
      readonly name?: string
    }
  | {
      readonly type: 'file'
      readonly blob: string
      readonly mediaType: string
      readonly size: number
      readonly name: string
    }
  | {
      readonly type: 'tool-call'
      readonly callId: string
      readonly name: string
      readonly input: unknown
      readonly providerMeta?: ProviderMeta
    }
  | {
      readonly type: 'tool-result'
      readonly callId: string
      readonly name: string
      readonly output: unknown
      readonly isError?: true
      readonly parts?: readonly Part[]
      /** What the interface shows beside the result; never sent to a model (contracts/tools.ts `ToolResult`). */
      readonly details?: unknown
    }
  | {
      readonly type: 'source'
      readonly sourceType: 'url' | 'document'
      readonly url?: string
      readonly title?: string
      readonly citedText?: string
      readonly documentPart?: number
    }
  | {
      readonly type: 'artifact'
      readonly artifactId: string
      readonly kind: 'html' | 'svg' | 'mermaid' | 'react' | 'code'
      readonly title: string
      readonly blob?: string
      readonly content?: string
    }
  | { readonly type: 'provider'; readonly provider: string; readonly block: unknown }
  | { readonly type: 'ref'; readonly partType: string; readonly blob: string; readonly size: number }

/**
 * One entry of a conversation's tool snapshot (spec/DATA-MODEL.md section 3.2), sorted by `name`. Source `provider` is
 * the provider's own web search (contracts/tools.ts `WEB_SEARCH`).
 */
export interface ToolSnapshotEntry {
  readonly name: string
  readonly source: ToolSource | 'provider'
  readonly origin?: string
  /** contracts/tools.ts `fingerprintOf`: base64url SHA-256 of the canonical JSON of the definition. */
  readonly fingerprint: string
}

export interface EntityMeta {
  readonly id: Id
  readonly createdAt: number
  readonly updatedAt: number
  readonly deletedAt?: number
  readonly purgedAt?: number
}

// Conversations

export interface Conversation extends EntityMeta {
  /** Empty until set; the controller fills it from the first user message. */
  readonly title: string
  readonly folder: Id | null
  readonly persona: Id | null
  /** The model new turns use. */
  readonly model: ModelRef | null
  /** The effort new turns use; null means the synced default. */
  readonly effort: Effort | null
  /** The active branch's last message, or null for an empty conversation. */
  readonly leaf: Id | null
  /** Top-level system prompt; frozen once `startedAt` is set. */
  readonly system: string
  /** Tool snapshot; frozen once `startedAt` is set. */
  readonly tools: readonly ToolSnapshotEntry[]
  readonly pinned: boolean
  readonly archived: boolean
  /** When the first message was appended: from then on `system` and `tools` never change. */
  readonly startedAt?: number
}

export interface NewConversation {
  readonly title?: string
  readonly folder?: Id | null
  readonly persona?: Id | null
  readonly model?: ModelRef | null
  readonly effort?: Effort | null
  /** Defaults to the synced `defaultSystem` setting. */
  readonly system?: string
  readonly tools?: readonly ToolSnapshotEntry[]
  readonly pinned?: boolean
}

/** What `update` may change; `system` and `tools` only before `startedAt` (InvalidStateError afterwards). */
export type ConversationPatch = {
  readonly [K in 'title' | 'folder' | 'model' | 'effort' | 'pinned' | 'archived' | 'system' | 'tools']?: Conversation[K]
}

export interface ConversationFilter {
  /** Default false: the trash is listed only on request. */
  readonly trashed?: boolean
  /** Default false. Ignored when `trashed`. */
  readonly archived?: boolean
  /** Only this folder; null for the root (no folder). Absent: every folder. */
  readonly folder?: Id | null
}

export interface Conversations {
  /** Never-purged conversations matching `filter`: pinned first, then by `updatedAt` descending, then by id. */
  list(filter?: ConversationFilter): readonly Conversation[]
  /** Includes trashed and purged ones (a purged one keeps only `id`, `createdAt`, `purgedAt`). */
  get(id: Id): Conversation | undefined
  create(input?: NewConversation): Id
  /** InvalidInputError for an unknown id; InvalidStateError for `system`/`tools` after `startedAt` or when purged. */
  update(id: Id, patch: ConversationPatch): void
  /** Sets `deletedAt`. */
  trash(id: Id): void
  /** Removes `deletedAt`. */
  restore(id: Id): void
  /**
   * Empties a trashed conversation for good (spec/DATA-MODEL.md section 3.1): every field but `id`, `createdAt` and
   * `purgedAt` is removed, and its messages are removed from its shard (loading it). InvalidStateError unless trashed.
   */
  purge(id: Id): Promise<void>
  /** The conversation's shard. */
  shardOf(id: Id): Promise<ShardId>
}

// Folders, settings and providers in the index

export interface Folder extends EntityMeta {
  readonly name: string
  readonly parent: Id | null
  /** Fractional index among siblings. */
  readonly order: string
}

export interface Folders {
  list(options?: { readonly trashed?: boolean }): readonly Folder[]
  get(id: Id): Folder | undefined
  create(input: { readonly name: string; readonly parent?: Id | null; readonly order?: string }): Id
  /** InvalidInputError for a parent inside the folder's own subtree. */
  update(id: Id, patch: { readonly name?: string; readonly parent?: Id | null; readonly order?: string }): void
  /** Trashing a folder moves its conversations to the root; it never trashes them. */
  trash(id: Id): void
  restore(id: Id): void
}

/** Synced preferences (`settings` map of the index). */
export interface Settings {
  readonly defaultModel: ModelRef | null
  readonly defaultEffort: Effort | null
  /** The system prompt new conversations start with. */
  readonly defaultSystem: string
}

export interface SettingsRepo {
  get<K extends keyof Settings>(key: K): Settings[K]
  set<K extends keyof Settings>(key: K, value: Settings[K]): void
}

export type NewProvider = Omit<ProviderConfig, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>

export interface Providers {
  /** Not trashed, by label then id. */
  list(): readonly ProviderConfig[]
  get(id: Id): ProviderConfig | undefined
  /** InvalidInputError when a field looks like a secret (any `key`, `apiKey`, `token` or `secret` value but the id). */
  create(input: NewProvider): Id
  update(id: Id, patch: Partial<NewProvider>): void
  trash(id: Id): void
}

// Collections (contracts/extras.ts, spec/DATA-MODEL.md section 3.6)

/** An entity of a collection as read: its fields, frozen, with the entity metadata. */
export type Entity<T> = T & EntityMeta

/** A patch of a collection entity: `undefined` removes an optional field. */
export type EntityPatch<T> = { readonly [K in keyof T]?: T[K] | undefined }

export interface Collection<T> {
  /** Never-purged entities, not trashed (or only the trashed ones), by `createdAt` then id. */
  list(options?: { readonly trashed?: boolean }): readonly Entity<T>[]
  /** Includes trashed ones. */
  get(id: Id): Entity<T> | undefined
  /**
   * Stores a new entity. With `id` (an Id no entity of the collection has), the entity takes it: the per-chat options
   * live under their conversation's id. InvalidInputError when a value is not `Any` or looks like a secret.
   */
  create(fields: T, options?: { readonly id?: Id }): Id
  /** InvalidInputError for an unknown id or a value that is not `Any`. */
  update(id: Id, patch: EntityPatch<T>): void
  trash(id: Id): void
  restore(id: Id): void
}

// Messages

export type MessageStatus = 'done' | 'stopped' | 'error' | 'refused'

export interface MessageError {
  /** A ChatErrorCode, or a workspace code (`blob-missing`). */
  readonly code: string
  readonly message: string
}

export interface Message {
  readonly id: Id
  readonly conv: Id
  readonly parent: Id | null
  readonly role: Role
  readonly parts: readonly Part[]
  /** The model that produced an assistant message; null otherwise. */
  readonly model: ModelRef | null
  readonly createdAt: number
  readonly status: MessageStatus
  readonly usage?: Usage
  readonly error?: MessageError
  /** Why an assistant response ended. */
  readonly stop?: StopReason
  readonly refusal?: { readonly category: string | null; readonly explanation?: string }
  /** The effort the response was produced with. */
  readonly effort?: Effort
  readonly deletedAt?: number
}

/** What `commit` writes; `id` is allocated by the caller so a stream knows its message id from the start. */
export type NewMessage = Omit<Message, 'conv' | 'createdAt' | 'deletedAt'> & { readonly createdAt?: number }

/** The message tree of one conversation, over its loaded shard. */
export interface Thread {
  readonly conversationId: Id
  /** Every message of the conversation, deleted ones included, by `createdAt` then id. */
  all(): readonly Message[]
  get(id: Id): Message | undefined
  /**
   * The branch from the root to `leaf` (default: the conversation's leaf), oldest first, deleted messages included
   * (the view hides them; the request builder applies spec/DATA-MODEL.md section 5). Empty for a null leaf.
   * CorruptError when a parent is missing or the chain has a cycle.
   */
  path(leaf?: Id | null): readonly Message[]
  /** Messages whose parent is `parent` (null: the roots), by `createdAt` then id: the `< 2/3 >` siblings. */
  children(parent: Id | null): readonly Message[]
  /** `id` and its siblings (same parent), in `children` order, with the index of `id`. */
  siblings(id: Id): { readonly messages: readonly Message[]; readonly index: number }
  /**
   * The leaf reached from `id` by following, at each level, the most recently created child: what switching to the
   * sibling `id` selects.
   */
  descend(id: Id): Id
  /**
   * Writes a complete message once. InvalidInputError when the id exists, when `parent` is not a message of this
   * conversation, or when a part is not `Any`. Sets the conversation's `startedAt` with the first message and bumps
   * its `updatedAt`, in the same `batch`. Does not move the leaf. `createdAt` defaults to the clock.
   */
  commit(message: NewMessage): void
  /**
   * Moves the conversation's leaf. InvalidInputError for an id outside the conversation; null empties the view.
   * With `ifLeaf`, moves only when the current leaf equals it and returns whether it moved.
   */
  setLeaf(id: Id | null, options?: { readonly ifLeaf: Id | null }): boolean
  /** Sets `deletedAt` (final). The leaf is unchanged; the view hides deleted messages. */
  delete(id: Id): void
}

// Workspace

/** Transaction origins (the cursus log's REMOTE / TAB / REPLAY scheme). */
export type Origin = 'local' | 'replay' | 'remote'

/** What `subscribe` listens to. */
export type Scope =
  | 'conversations'
  | 'folders'
  | 'settings'
  | 'providers'
  /** The stored tool approvals. */
  | 'toolApprovals'
  /** The MCP servers' configuration. */
  | 'mcp'
  /** The messages and leaf of one conversation. */
  | { readonly conversation: Id }
  /** One collection of contracts/extras.ts. */
  | CollectionName

export interface PersistenceStatus {
  /** Local updates captured but not yet acknowledged by the pending queue. */
  readonly unsaved: number
  /** An append failed and is waiting for its retry ("not saved on this device"). */
  readonly blocked: boolean
}

export interface Workspace {
  readonly conversations: Conversations
  readonly folders: Folders
  readonly settings: SettingsRepo
  readonly providers: Providers
  /** Tool approvals that outlive a call (contracts/tools.ts): "always" and "for this conversation". */
  readonly toolApprovals: ToolApprovals
  /** MCP servers (contracts/mcp.ts): configuration only; their secrets are device-only local records. */
  readonly mcp: McpServers
  /** A collection of the index added after the fixed entities (contracts/extras.ts). */
  collection<N extends CollectionName>(name: N): Collection<CollectionTypes[N]>
  /** Loads the conversation's shard (once) and returns its tree; InvalidInputError for an unknown or purged id. */
  thread(conversationId: Id): Promise<Thread>
  /** Runs `fn` as one transaction per touched document (one update each). */
  batch<T>(fn: () => T): T
  /** Calls `fn` after each change of `scope`, from any origin; returns the unsubscribe function. */
  subscribe(scope: Scope, fn: () => void): () => void
  /** Resolves once every captured update is acknowledged by the pending queue; rejects while blocked. */
  flush(): Promise<void>
  persistence(): PersistenceStatus
  /** Calls `fn` when `persistence()` changes; returns the unsubscribe function. */
  onPersistence(fn: () => void): () => void
  /** Full state of a loaded document as one v2 update (sync and tests); loads a shard first. */
  state(docId: DocId): Promise<Bytes>
  /** Applies an update from another device (origin `remote`, not captured); loads a shard first. */
  applyRemote(docId: DocId, update: Uint8Array): Promise<void>
  /** Whether a document is in memory or loading (the index always is once open; a shard once used). */
  isLoaded(docId: DocId): boolean
  /**
   * Replaces a document's pending queue by one merged update (appended first, then the older positions dropped, so a
   * crash in between only leaves duplicates, which Yjs ignores).
   */
  compact(docId: DocId): Promise<void>
  /** Stops capturing, drops every document from memory; later calls throw LockedError. Idempotent. */
  close(): void
}

export interface WorkspaceDeps {
  readonly store: LocalStore
  readonly subkeys: Subkeys
  /** Ids. */
  readonly rng: Rng
  readonly clock: Clock
  /** Backoff before retry `attempt` of a failed append; defaults to min(60 s, 1 s * 2^(attempt-1)). */
  readonly retryDelayMs?: (attempt: number) => number
  /**
   * What this device holds of a document beyond its pending queue: the segments and checkpoints the sync layer keeps
   * in the object mirror (spec/FORMAT.md section 11.1), already authenticated. Applied with origin `remote` when the
   * document loads, before the queue. Absent: nothing but the queue.
   */
  readonly base?: (docId: DocId) => Promise<readonly Uint8Array[]>
}

export interface WorkspaceModule {
  /** Opens the index (replaying its pending queue) and starts capturing. */
  openWorkspace(deps: WorkspaceDeps): Promise<Workspace>
}

// Blobs

/**
 * Encrypted content-addressed blobs (spec/DATA-MODEL.md section 4.4, FORMAT.md section 8.6). The chat stores images,
 * files and parts over 16 KiB through it. Implemented with the sync layer; tests use an in-memory fake.
 */
export interface BlobPort {
  /** Stores the bytes and returns the manifest id; storing the same bytes twice returns the same id. */
  put(bytes: Uint8Array, mediaType: string): Promise<string>
  /** The bytes, or null when this device does not have the blob (yet). */
  get(id: string): Promise<Bytes | null>
}
