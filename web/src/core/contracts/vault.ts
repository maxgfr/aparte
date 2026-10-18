/*
 * Contract of the vault (F3): creation, unlocking, locking, auto-lock, passphrase change and recovery over the
 * keyslots of spec/FORMAT.md section 6, and the device slot of section 17. Implemented by
 * web/src/core/vault/vault.ts.
 *
 * State machine:
 *
 *   absent --create / createDevice--> unlocked
 *   locked --unlock--> unlocking --ok--> unlocked
 *                                \--fail--> locked
 *   unlocked --lock / auto-lock--> locking --holds released, cleanups run--> locked
 *
 * Protection, orthogonal to the state:
 *
 *   device     --protect-->   passphrase
 *   passphrase --unprotect--> device
 *
 * A `device` vault opens with the device slot alone, a key this device keeps and the browser refuses to export: no
 * prompt, and no auto-lock. A `passphrase` vault opens with a keyslot only: whenever `meta` holds a passphrase (or
 * passkey) slot the device slot is ignored, so an entry another page of the origin plants cannot open a vault the user
 * protected.
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
 * - A new slot is persisted before any slot is removed, so a crash never leaves a vault without a slot. Protecting and
 *   unprotecting swap the slots in one transaction.
 */

import type { Argon2Fn, Argon2Params, Bytes, KeyslotKind, Rng, Subkeys } from './crypto.ts'
import type { LocalDb, LocalStore } from './store.ts'

export type VaultState = 'absent' | 'locked' | 'unlocking' | 'unlocked' | 'locking'

/** What opens the vault: the device slot alone, or a passphrase (spec/FORMAT.md section 17). */
export type Protection = 'device' | 'passphrase'

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
  /** The keyslots or the protection changed, here or (after `refresh`) in another page. */
  | { readonly type: 'changed' }

export interface VaultStatus {
  readonly state: VaultState
  /** base32 vaultId; null while absent. */
  readonly vaultId: string | null
  readonly slots: readonly SlotInfo[]
  /**
   * `passphrase` when a passphrase (or passkey) slot opens the vault, otherwise `device`; null while absent. A
   * `device` vault never auto-locks.
   */
  readonly protection: Protection | null
  /** Reasons of the active holds. */
  readonly holds: readonly string[]
  readonly autoLock: AutoLockPolicy
  /**
   * Whether this device remembers the Secret Key (unlocking then needs only the passphrase). Turns false once the
   * stored copy fails to unwrap; unlocking with the Secret Key typed in then stores it again.
   */
  readonly secretKeyOnDevice: boolean
}

/** What the user types to unlock. Texts are parsed with parseSecretKey and parseRecoveryKey. */
export type UnlockCredential =
  | {
      readonly kind: 'passphrase'
      readonly passphrase: string
      /** Emergency Kit text; omitted to use the one this device remembers. */
      readonly secretKey?: string
      /**
       * Keep the Secret Key typed in on this device, wrapped by the device key, so later unlocks need only the
       * passphrase (default false; a device that joined a vault from its sync store asks for it).
       */
      readonly rememberSecretKey?: boolean
    }
  | { readonly kind: 'recovery'; readonly recoveryKey: string }
  /** The device slot of a vault that no passphrase protects. */
  | { readonly kind: 'device' }

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
  /**
   * Proof that this vault showed a kit for its recovery slot, for the pending-kit marker the app keeps until the user
   * confirms the kit (`unlockAndRenewKit`); null without a recovery slot. base64url of `iv || AES-GCM(K_local
   * ("kit-pending"), iv, slotId, "aparte/1|kit-pending|" || vault)`: only an open vault can make one, so a marker
   * another page of the origin wrote cannot ask for a renewal.
   */
  readonly kitProof: string | null
}

/** A kit renewed by `unlockAndRenewKit`. */
export interface RenewedKit {
  /** The Secret Key of the slot that opened, or null. */
  readonly secretKey: string | null
  readonly recoveryKey: string
  /** The proof for the new recovery slot (as `CreatedVault.kitProof`). */
  readonly kitProof: string
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
  /**
   * absent -> unlocked: a new master key, vault id, device id, passphrase slot and optional recovery slot.
   * InvalidStateError, with nothing written, when the device already holds a vault (another page created it); the
   * vault is then `locked`.
   */
  create(input: CreateVaultInput): Promise<CreatedVault>
  /**
   * absent -> unlocked: a new master key, vault id and device id, opened by a device slot alone (protection
   * `device`, spec/FORMAT.md section 17). InvalidStateError, with nothing written, when the device already holds a
   * vault; the vault is then `locked`.
   */
  createDevice(): Promise<void>
  /**
   * absent -> locked: this device takes a vault that exists elsewhere, from the keyslot files its sync store holds
   * (spec/FORMAT.md section 10.4). Every file must parse, carry its own name and belong to `vault`, and one at least
   * must not be a recovery slot (InvalidInputError, or the parse error, with nothing written). Only `fmt`, `vault`
   * and the keyslots are written, in one transaction; unlocking then needs the passphrase and the Secret Key of the
   * Emergency Kit. InvalidStateError when the device already holds a vault.
   *
   * With `replaceDevice`, a `device` vault this device holds (unlocked or locked) is replaced: its keys are dropped,
   * the cleanups run, and everything it stored is deleted in the same transaction that writes the joined vault. Still
   * InvalidStateError for a vault a passphrase protects, which is never replaced.
   */
  join(
    input: { readonly vault: string; readonly keyslots: readonly KeyslotFile[] },
    options?: { readonly replaceDevice?: boolean },
  ): Promise<void>
  /**
   * locked -> unlocked, for a `device` vault whose device slot no longer opens (CorruptError or TamperedError from
   * `unlock`): replaces it with a new, empty `device` vault, deleting everything this device held of the old one.
   * InvalidStateError in any other state or for a vault a passphrase protects.
   */
  reset(): Promise<void>
  /**
   * Adds the keyslot files of this vault that another device created (read from the sync store) and this device does
   * not have; files of another vault or that do not parse are skipped. Returns the slots added.
   */
  importKeyslots(files: readonly KeyslotFile[]): Promise<readonly string[]>
  /**
   * locked -> unlocked. WrongSecretError (state back to locked) when no slot opens; InvalidInputError for a malformed
   * text or a missing Secret Key; InvalidStateError in any state but locked. With the `device` credential:
   * InvalidStateError when a passphrase protects the vault, CorruptError when the device slot or its key is missing
   * or malformed, TamperedError when it does not unwrap.
   */
  unlock(credential: UnlockCredential): Promise<void>
  /**
   * Unlocks as `unlock` does and, in the same step, replaces every recovery slot with a new one: for an Emergency Kit
   * that was never confirmed. Returns the new kit texts (the Secret Key of the slot that opened, or null). The
   * renewal happens only when `kitProof` is one this vault made (`CreatedVault.kitProof`, `RenewedKit.kitProof`) for
   * a recovery slot it still holds; otherwise this only unlocks and returns null.
   */
  unlockAndRenewKit(credential: UnlockCredential, kitProof: string): Promise<RenewedKit | null>
  /**
   * Re-reads `meta`, for a change made by another page of this device: a vault created (absent -> locked), or
   * keyslots added or removed. Unlocking and slot changes re-read the keyslots on their own.
   */
  refresh(): Promise<void>
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
  /**
   * device -> passphrase: opens the device slot and, in one transaction, writes a passphrase slot (with a new Secret
   * Key unless `secretKey` is false), a recovery slot (unless `recoveryKey` is false), the device-wrapped Secret Key
   * (unless `rememberSecretKey` is false), and deletes the device slot and its key. The vault stays unlocked, and the
   * auto-lock starts. Returns the kit as `create` does. Needs `unlocked`; InvalidStateError when a passphrase already
   * protects the vault.
   */
  protect(input: CreateVaultInput): Promise<CreatedVault>
  /**
   * passphrase -> device: opens a slot with `current` (a passphrase) and, in one transaction, writes a new device slot
   * and its key and deletes every keyslot and the device-wrapped Secret Key. The vault stays unlocked and stops
   * auto-locking. Needs `unlocked`; InvalidStateError for a `device` vault, InvalidInputError for another credential.
   */
  unprotect(current: UnlockCredential): Promise<void>
  /** Adds a recovery slot after opening a slot with `current`; the text is shown once. */
  addRecoveryKey(current: UnlockCredential): Promise<{ readonly slot: string; readonly recoveryKey: string }>
  /**
   * locked -> unlocked with a recovery key, adding a passphrase slot for `next`. When this device has no usable Secret
   * Key (none kept, or a stored copy that no longer unwraps), a new one is generated for the new slot and returned (to
   * show as a new Emergency Kit). With `replace`, every other passphrase slot is removed once the new one is persisted
   * (spec/FORMAT.md section 6.10): the forgotten passphrase stops opening the vault on this device.
   */
  recover(input: {
    readonly recoveryKey: string
    readonly next: string
    readonly replace?: boolean
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
