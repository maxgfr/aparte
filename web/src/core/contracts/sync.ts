/*
 * Contract F8 of the sync layer: the RemoteStore a destination implements, the chunk size, the errors a destination
 * reports, and the status and alarms the sync engine shows (spec/FORMAT.md sections 8 and 10). Implemented by
 * web/src/core/sync/engine.ts over the providers of web/src/core/sync/providers.
 *
 * Invariants:
 * - A store only ever holds `aparte/1` objects under their exact names (spec/FORMAT.md section 8.8): the format marker
 *   and the keyslots in clear, everything else as envelopes. Nothing readable leaves the device.
 * - Objects are immutable: `put` of a name that exists writes nothing new. The only deletion is a keyslot the vault
 *   replaced (spec/FORMAT.md section 10.1).
 * - A listing is complete: every object of the store under the prefix, or a RemoteError. A partial answer is never
 *   returned as a listing, so the anti-rollback checks of section 10.3 only ever judge complete listings.
 * - Sync credentials (a token, S3 keys) are device-only local records (purpose `sync-credential`), never in a synced
 *   document, never in the store.
 */

import type { Bytes, DocId } from './crypto.ts'

/** Plaintext bytes of one blob chunk (spec/FORMAT.md section 8.6): a format constant, sized for GitHub's limits. */
export const CHUNK_SIZE = 2_097_152

/** Why a store refused or failed, as the engine and the scheduler branch on it. */
export type RemoteErrorKind =
  /** The credentials are wrong or expired: the user must sign in again or enter a new token. */
  | 'auth'
  /** The credentials are valid but may not do this (a read-only token, a folder whose access was revoked). */
  | 'permission'
  /** The repository, bucket or folder does not exist (or is not visible to these credentials). */
  | 'not-found'
  /** No answer: offline, DNS, a reset connection, a 5xx. Retried with backoff. */
  | 'network'
  /** The browser hid the answer: the server does not allow this origin (S3 CORS rule). */
  | 'cors'
  /** The store is full or refuses the size. */
  | 'quota'
  /** Too many requests: retried after `retryAfterMs`. */
  | 'rate-limited'
  /** The device clock is too far from the server's (S3 signatures). */
  | 'clock-skew'
  /** The store answered with something this build does not read (another format, another vault). */
  | 'incompatible'

export class RemoteError extends Error {
  readonly kind: RemoteErrorKind
  /** How long the store asked to wait before the next request, when it said so. */
  readonly retryAfterMs?: number

  constructor(kind: RemoteErrorKind, message: string, options?: { retryAfterMs?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RemoteError'
    this.kind = kind
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
  }
}

/** One object of a listing. */
export interface RemoteEntry {
  /** The object name relative to the store's root, as spec/FORMAT.md section 8 writes it. */
  readonly name: string
  readonly size?: number
  /** Store-specific id that reads this exact object (a Git blob sha); optional. */
  readonly handle?: string
}

export type DestinationKind = 'github' | 's3' | 'folder' | 'zip' | 'memory'

/** How a store paces its writes, for the ETA of the upload queue. */
export interface WritePace {
  /** Write requests the store still has to send for what `put` accepted and `flush` has not written. */
  readonly queuedWrites: number
  /** Milliseconds per write request at the store's pace (GitHub: one per second). */
  readonly msPerWrite: number
  /** Write requests needed to upload `objects` objects totalling `bytes` bytes, at this store's batching. */
  writesFor(objects: number, bytes: number): number
}

/** What a destination is, apart from the objects: facts the status screen shows. */
export interface StoreInfo {
  /** Total size the host reports, in bytes (GitHub repository size); undefined when unknown. */
  readonly sizeBytes?: number
  /** The store is readable by anyone (a public repository): the names and sizes leak to everyone. */
  readonly isPublic?: boolean
  /** When the credentials expire (a fine-grained token's expiry), Unix milliseconds. */
  readonly credentialsExpireAt?: number
}

/** A sync destination: a Git repository, a bucket, a folder, an archive. */
export interface RemoteStore {
  /** Same destination, same id, on every device (derived from what identifies it, never from a secret). */
  readonly id: string
  readonly kind: DestinationKind
  /** Whether the store keeps every version forever (Git history): a deletion there removes nothing for good. */
  readonly keepsHistory: boolean
  /** Every object whose name starts with `prefix` (all objects for ''), sorted by name. Complete or a RemoteError. */
  list(prefix?: string): Promise<readonly RemoteEntry[]>
  /** The object's bytes, or null only when the store says for sure it does not exist. */
  get(entry: RemoteEntry): Promise<Bytes | null>
  /**
   * Stores an object. Idempotent per name. A batching store (GitHub) may only stage it: `flush` writes what is staged,
   * and nothing staged counts as stored before `flush` resolves.
   */
  put(name: string, bytes: Uint8Array): Promise<void>
  /** Writes what `put` staged; resolves at once on a store that writes immediately. */
  flush(): Promise<void>
  /** Removes an object; used only for a keyslot the vault replaced. */
  delete(name: string): Promise<void>
  /** The store's write pace, when it paces writes (GitHub); absent when writes are not rate limited. */
  readonly pace?: WritePace
  /** Facts about the destination, refreshed by a call that reads them; absent when the store has none. */
  info?(): Promise<StoreInfo>
}

// Status

export type DestState =
  | 'idle'
  | 'syncing'
  /** A failure is retried later (`nextTryAt`). */
  | 'backoff'
  /** The credentials need the user: a new token, a new sign-in. */
  | 'needs-auth'
  /** The browser needs a gesture to give access again (a folder). */
  | 'needs-permission'
  /** Stopped until the user changes something (another vault's store, an unreadable format). */
  | 'error'
  | 'offline'

export interface DestStatus {
  readonly id: string
  readonly kind: DestinationKind
  readonly label: string
  readonly state: DestState
  /** End of the last round that completed. */
  readonly lastOkAt?: number
  readonly nextTryAt?: number
  readonly error?: { readonly kind: RemoteErrorKind | 'internal'; readonly message: string; readonly at: number }
  /** Objects of this device not on the destination yet. */
  readonly queued: number
  readonly queuedBytes: number
  /** Estimated time to upload the queue at the destination's pace; absent when not paced. */
  readonly etaMs?: number
  readonly info?: StoreInfo
}

/**
 * Why the store looks untrustworthy (spec/FORMAT.md section 10.3). Nothing local is ever deleted because of one.
 * - `rollback`: a device's highest listed segment is below what this device saw there (a force push, a restore).
 * - `withheld`: a gap below a listed segment persists across listings at least 10 minutes apart.
 * - `unreturned`: a header names a segment the store does not return, under the same rule.
 * - `fork`: two different segments carry the same (document, device, seq): a cloned device or an attack.
 * - `tampered`: an object does not authenticate or does not match its name.
 */
export type AlarmKind = 'rollback' | 'withheld' | 'unreturned' | 'fork' | 'tampered'

export interface SyncAlarm {
  /** Stable for one finding, so seeing it again does not raise a second alarm. */
  readonly id: string
  readonly kind: AlarmKind
  /** The destination it was found on. */
  readonly dest: string
  readonly doc?: DocId
  /** Technical detail for the status screen (tags and sequence numbers, never content). */
  readonly detail: string
  readonly at: number
}

export interface SyncStatus {
  readonly dests: readonly DestStatus[]
  readonly alarms: readonly SyncAlarm[]
}

export interface RoundResult {
  /** Objects downloaded and accepted. */
  readonly down: number
  /** Objects uploaded. */
  readonly up: number
  /** Objects that had to wait for the next round (a segment whose blob is not confirmed yet). */
  readonly deferred: number
}

export interface SyncEngine {
  /** One sync round with a destination: seal local changes, list, check, download, apply, upload. */
  round(dest: string): Promise<RoundResult>
  status(): SyncStatus
  subscribe(fn: (status: SyncStatus) => void): () => void
  /**
   * Adds a destination; its status starts `idle`. A `transient` one (an archive being exported or imported) keeps no
   * listing marks in the sync state: a later archive is a new store, not a rollback of this one.
   */
  addDestination(store: RemoteStore, label: string, options?: { readonly transient?: boolean }): void
  removeDestination(id: string): void
  destinations(): readonly string[]
  /** Scheduler feedback: the next retry time of a destination in backoff (undefined clears it). */
  noteSchedule(dest: string, nextTryAt: number | undefined): void
  /** Forgets an alarm the user read; the same finding can raise it again only if it changes. */
  dismissAlarm(id: string): Promise<void>
  /** Stops every round; later calls reject with LockedError. */
  close(): void
}

/** What triggers a round. `sealed`, `visible` and `timer` are debounced together. */
export type Trigger = 'startup' | 'sealed' | 'online' | 'visible' | 'timer' | 'manual'

export interface Scheduler {
  start(): void
  stop(): void
  trigger(reason: Trigger): void
}

// Destinations as the device keeps them (local record `sync-credential`, one per destination)

export interface GitHubDestination {
  readonly kind: 'github'
  readonly owner: string
  readonly repo: string
  /** Empty: the repository's default branch. */
  readonly branch?: string
  /** Folder of the repository that holds the store; `aparte` when empty. */
  readonly root?: string
  /** Fine-grained personal access token, limited to the repository, Contents read and write. */
  readonly token: string
}

export interface S3Destination {
  readonly kind: 's3'
  /** Base URL without the bucket (path-style addressing), such as `https://<account>.r2.cloudflarestorage.com`. */
  readonly endpoint: string
  readonly region: string
  readonly bucket: string
  readonly prefix?: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
}

export interface FolderDestination {
  readonly kind: 'folder'
  /** The name the user gave the folder (handles have no path). */
  readonly label: string
}

export type DestinationConfig = GitHubDestination | S3Destination | FolderDestination
