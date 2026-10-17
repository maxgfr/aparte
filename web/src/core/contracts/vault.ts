/*
 * Contract of the vault (F3): creation, unlocking, locking, auto-lock, passphrase change and recovery over the
 * keyslots of spec/FORMAT.md section 6. Implemented by web/src/core/vault/vault.ts.
 *
 * State machine:
 *
 *   absent --create--> unlocked
 *   locked --unlock--> unlocking --ok--> unlocked
 *                                \--fail--> locked
 *   unlocked --lock / auto-lock--> locking --holds released, cleanups run--> locked
 *
 * Invariants:
 * - Keys exist only in the `unlocked` and `locking` states, as non-extractable CryptoKeys in memory. Entering `locked`
 *   disposes the LocalStore, runs every `onLock` cleanup (workers, `blob:` URLs, decrypted caches) and drops every
 *   reference to a key; `subkeys()` and `localStore()` then throw LockedError.
 * - A lock never interrupts work that holds it (a response still streaming, a write in flight): `holdLock` defers both
 *   the auto-lock and a non-forced `lock()` until every hold is released. While `locking`, holders keep their keys and
 *   no new hold is granted.
 * - The auto-lock fires after `idleMs` without `touch()`. If a hold is active then, it waits for the last hold to be
 *   released and then for `graceMs` more, so an answer that just finished stays readable; a `touch()` during the grace
 *   period cancels the pending lock.
 * - The master key exists in clear only inside one operation (create, unlock, changePassphrase, addRecoveryKey,
 *   recover) and is zeroed before it returns. Operations that create a slot therefore take a current credential.
 * - A new slot is persisted before any slot is removed, so a crash never leaves a vault without a slot.
 */

import type { Argon2Fn, Argon2Params, Bytes, KeyslotKind, Rng, Subkeys } from './crypto.ts'
import type { LocalDb, LocalStore } from './store.ts'

export type VaultState = 'absent' | 'locked' | 'unlocking' | 'unlocked' | 'locking'

export interface SlotInfo {
  /** base32 slotId. */
  readonly slot: string
  readonly kind: KeyslotKind
  /** Whether a passphrase slot also needs the Secret Key. */
  readonly secretKey: boolean
}

export interface AutoLockPolicy {
  /** Lock after this long without activity; null never auto-locks (refused on the shared origin by the UI). */
  readonly idleMs: number | null
  /** Delay between the release of the last hold and a deferred auto-lock. */
  readonly graceMs: number
}

export type LockReason = 'user' | 'idle' | 'forced'

export type VaultEvent =
  | { readonly type: 'state'; readonly state: VaultState }
  | { readonly type: 'locked'; readonly reason: LockReason }
  /** An auto-lock or lock request is waiting for these holds. */
  | { readonly type: 'lock-deferred'; readonly holds: readonly string[] }

export interface VaultStatus {
  readonly state: VaultState
  /** base32 vaultId; null while absent. */
  readonly vaultId: string | null
  readonly slots: readonly SlotInfo[]
  /** Reasons of the active holds. */
  readonly holds: readonly string[]
  readonly autoLock: AutoLockPolicy
  /** Whether this device remembers the Secret Key (unlocking then needs only the passphrase). */
  readonly secretKeyOnDevice: boolean
}

/** What the user types to unlock. Texts are parsed with parseSecretKey and parseRecoveryKey. */
export type UnlockCredential =
  | {
      readonly kind: 'passphrase'
      readonly passphrase: string
      /** Emergency Kit text; omitted to use the one this device remembers. */
      readonly secretKey?: string
    }
  | { readonly kind: 'recovery'; readonly recoveryKey: string }

export interface CreateVaultInput {
  readonly passphrase: string
  /** Combine the passphrase with a new Secret Key (default true). */
  readonly secretKey?: boolean
  /** Also create a recovery slot (default true). */
  readonly recoveryKey?: boolean
  /** Keep the Secret Key on this device, wrapped by the device key (default true). */
  readonly rememberSecretKey?: boolean
}

/** Shown to the user once, then never again. */
export interface CreatedVault {
  readonly vaultId: string
  /** Emergency Kit text, or null without a Secret Key. */
  readonly secretKey: string | null
  /** Recovery key text, or null without a recovery slot. */
  readonly recoveryKey: string | null
}

export interface Clock {
  now(): number
}

/** Timer port, so tests drive time explicitly. */
export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

export interface VaultDeps {
  readonly db: LocalDb
  readonly rng: Rng
  readonly clock: Clock
  readonly timers: Timers
  /** Argon2 parameters of new passphrase slots; defaults to DEFAULT_ARGON2 (tests pass the small vector ones). */
  readonly argon2Params?: Argon2Params
  /** Argon2 implementation, for a worker-backed one; defaults to argon2.ts. */
  readonly argon2?: Argon2Fn
  /** Defaults to DEFAULT_AUTO_LOCK. */
  readonly autoLock?: AutoLockPolicy
}

export interface KeyslotFile {
  /** `keys/<slot>.json`. */
  readonly name: string
  readonly bytes: Bytes
}

export interface Vault {
  status(): VaultStatus
  /** Returns the unsubscribe function. */
  subscribe(listener: (event: VaultEvent) => void): () => void
  /** absent -> unlocked: a new master key, vault id, device id, passphrase slot and optional recovery slot. */
  create(input: CreateVaultInput): Promise<CreatedVault>
  /**
   * locked -> unlocked. WrongSecretError (state back to locked) when no slot opens; InvalidInputError for a malformed
   * text or a missing Secret Key; InvalidStateError in any state but locked.
   */
  unlock(credential: UnlockCredential): Promise<void>
  /** Locks now when nothing holds the lock; otherwise enters `locking` and waits, unless `force`. */
  lock(options?: { readonly force?: boolean }): Promise<void>
  /** Records user activity: restarts the idle timer and cancels a pending grace period. */
  touch(): void
  /** Defers locking until the returned function is called (idempotent). InvalidStateError while locking. */
  holdLock(reason: string): () => void
  setAutoLock(policy: AutoLockPolicy): void
  /**
   * Adds a passphrase slot for `next` (same Secret Key) after opening a slot with `current`. Both open the vault until
   * `removeSlot(previous)`; the caller removes it once the new slot is confirmed on the remote.
   */
  changePassphrase(input: {
    readonly current: UnlockCredential
    readonly next: string
  }): Promise<{ readonly added: string; readonly previous: string }>
  /** Adds a recovery slot after opening a slot with `current`; the text is shown once. */
  addRecoveryKey(current: UnlockCredential): Promise<{ readonly slot: string; readonly recoveryKey: string }>
  /**
   * locked -> unlocked with a recovery key, adding a passphrase slot for `next`. When this device has no Secret Key, a
   * new one is generated for the new slot and returned (to show as a new Emergency Kit).
   */
  recover(input: {
    readonly recoveryKey: string
    readonly next: string
  }): Promise<{ readonly added: string; readonly secretKey: string | null }>
  /** Removes a slot; InvalidStateError when it would leave no slot other than recovery slots. Needs `unlocked`. */
  removeSlot(slot: string): Promise<void>
  /** The keyslot files, as the sync layer uploads them. */
  keyslotFiles(): Promise<readonly KeyslotFile[]>
  /** Emergency Kit text of the Secret Key this device remembers, or null. Needs `unlocked`. */
  secretKeyText(): Promise<string | null>
  /** LockedError unless unlocked or locking. */
  subkeys(): Subkeys
  /** The record store bound to the current keys; LockedError unless unlocked or locking. */
  localStore(): LocalStore
  /** Registers a cleanup run on every lock; returns the unregister function. */
  onLock(cleanup: () => void | Promise<void>): () => void
}

export interface VaultModule {
  /** 5 minutes idle, 30 seconds of grace. */
  readonly DEFAULT_AUTO_LOCK: AutoLockPolicy
  /** Reads `meta` and returns a vault in state `absent` or `locked`. */
  openVault(deps: VaultDeps): Promise<Vault>
}
