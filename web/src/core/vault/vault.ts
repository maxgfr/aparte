/*
 * The vault state machine of web/src/core/contracts/vault.ts over the keyslots of spec/FORMAT.md section 6 and the
 * device store of section 11.
 *
 * Invariants:
 * - The subkeys and the record store exist only while `unlocked`, and while `locking` until the last hold is released
 *   or the lock is forced. A lock that proceeds drops both at once, before any cleanup runs, so a cleanup that never
 *   settles cannot keep a key alive.
 * - Raw secrets (the master key, the Secret Key, a recovery key, the device id) live only inside the operation that
 *   needs them and are zeroed before it returns, on success and on failure.
 * - A slot is persisted before any other is removed, and creation writes every `meta` entry in one transaction that
 *   first checks that no vault exists, so an interrupted creation reads back as `absent`, a page that loaded before
 *   another page created the vault cannot create a second one over it, and an interrupted slot change leaves every
 *   earlier slot in place.
 * - Several pages of one device (tabs, the installed app) each hold a Vault over the same database. Every operation
 *   that opens a slot re-reads the keyslots first, so a slot another page added or removed is seen at once.
 */

import {
  AparteError,
  type Bytes,
  type BytesModule,
  CorruptError,
  InvalidInputError,
  InvalidStateError,
  type Keyslot,
  type KeyslotModule,
  type KeysModule,
  LockedError,
  type NamesModule,
  type RecoveryModule,
  type Rng,
  type SecretKeyModule,
  type SlotSecret,
  type Subkeys,
  UnsupportedFormatError,
  WrongSecretError,
} from '../contracts/crypto.ts'
import type { LocalMeta, LocalStore } from '../contracts/store.ts'
import type {
  AutoLockPolicy,
  CreatedVault,
  CreateVaultInput,
  KeyslotFile,
  LockReason,
  RenewedKit,
  SlotInfo,
  UnlockCredential,
  Vault,
  VaultDeps,
  VaultEvent,
  VaultState,
  VaultStatus,
} from '../contracts/vault.ts'
import * as bytesImpl from '../crypto/bytes.ts'
import * as keysImpl from '../crypto/keys.ts'
import * as keyslotImpl from '../crypto/keyslot.ts'
import * as namesImpl from '../crypto/names.ts'
import * as recoveryImpl from '../crypto/recovery.ts'
import * as secretKeyImpl from '../crypto/secretKey.ts'
import { createLocalMeta, createLocalStore } from '../store/localStore.ts'

const B: BytesModule = bytesImpl
const K: KeysModule = keysImpl
const KS: KeyslotModule = keyslotImpl
const N: NamesModule = namesImpl
const RK: RecoveryModule = recoveryImpl
const SK: SecretKeyModule = secretKeyImpl

/** 5 minutes idle, 30 seconds of grace. */
export const DEFAULT_AUTO_LOCK: AutoLockPolicy = Object.freeze({ idleMs: 300_000, graceMs: 30_000 })

const FMT = 'aparte/1\n'
const MK_BYTES = 32
const ID_BYTES = 16
const IV_BYTES = 12

/** A keyslot of this vault as `meta` holds it: the parsed file and its canonical bytes. */
interface Slot {
  readonly id: string
  readonly keyslot: Keyslot
  readonly bytes: Bytes
}

/** The result of opening one slot; the caller zeroes both byte strings. */
interface Opened {
  readonly mk: Bytes
  readonly slot: Slot
  /** The Secret Key the opened slot combined with the passphrase, or null. */
  readonly secretKey: Bytes | null
}

function checkPolicy(policy: AutoLockPolicy): AutoLockPolicy {
  const { idleMs, graceMs } = policy
  if (idleMs !== null && !(Number.isFinite(idleMs) && idleMs > 0)) {
    throw new InvalidInputError('The idle delay is a positive number of milliseconds or null')
  }
  if (!(Number.isFinite(graceMs) && graceMs >= 0)) {
    throw new InvalidInputError('The grace delay is a non-negative number of milliseconds')
  }
  return Object.freeze({ idleMs, graceMs })
}

/** AAD of the device-wrapped Secret Key (spec/FORMAT.md section 11.2). */
const deviceSecretAad = (vault: string): Bytes => B.utf8(`aparte/1|device-secret-key|${vault}`)

/**
 * The pending-kit proof (CreatedVault.kitProof): web-only, kept in localStorage beside the marker, never in a store.
 * `kit-pending` is not a 26-character local record name, so its K_local is used for nothing else (as `inbox-key`).
 */
const KIT_PROOF_NAME = 'kit-pending'
const kitProofAad = (vault: string): Bytes => B.utf8(`aparte/1|kit-pending|${vault}`)
const KIT_PROOF_BYTES = IV_BYTES + ID_BYTES + 16

/** Proof that the vault `vault` showed a kit for the recovery slot `slot`. */
async function makeKitProof(subkeys: Subkeys, vault: string, slot: string, rng: Rng): Promise<string> {
  const iv = rng.bytes(IV_BYTES)
  const key = await K.localKey(subkeys, KIT_PROOF_NAME)
  return B.base64urlEncode(B.concat(iv, await K.aesGcmEncrypt(key, iv, B.base32Decode(slot), kitProofAad(vault))))
}

/** The recovery slot a proof names, or null when it is not one this vault made. */
async function openKitProof(subkeys: Subkeys, vault: string, proof: string): Promise<string | null> {
  try {
    const bytes = B.base64urlDecode(proof)
    if (bytes.length !== KIT_PROOF_BYTES) return null
    const key = await K.localKey(subkeys, KIT_PROOF_NAME)
    const slot = await K.aesGcmDecrypt(key, bytes.subarray(0, IV_BYTES), bytes.subarray(IV_BYTES), kitProofAad(vault))
    return B.base32Encode(slot)
  } catch {
    return null
  }
}

/** Reports an error thrown by a listener or a cleanup without letting it stop the state machine. */
function report(error: unknown): void {
  queueMicrotask(() => {
    throw error
  })
}

class VaultImpl implements Vault {
  private readonly deps: VaultDeps
  private readonly meta: LocalMeta
  private state: VaultState
  private vaultId: Bytes | null
  private vaultText: string | null
  private readonly slots = new Map<string, Slot>()
  private secretKeyStored: boolean
  /** The stored Secret Key failed to unwrap; a Secret Key typed in at the next unlock replaces it. */
  private secretKeyDamaged = false
  private keys: Subkeys | null = null
  private store: LocalStore | null = null
  private policy: AutoLockPolicy
  private lastActivity: number
  private idleTimer: unknown = null
  private graceTimer: unknown = null
  /** An auto-lock came due while holds were active; it runs once they are released and the grace period ends. */
  private idlePending = false
  private readonly holds = new Map<number, string>()
  private holdSeq = 0
  /** An explicit lock waiting in `locking` for the holds. */
  private lockRequest: {
    readonly reason: LockReason
    readonly resolve: () => void
    readonly done: Promise<void>
  } | null = null
  private finalizing: Promise<void> | null = null
  private unlocking: Promise<unknown> | null = null
  private unlockAborted = false
  private creating = false
  private exclusiveTail: Promise<unknown> = Promise.resolve()
  private readonly listeners = new Set<(event: VaultEvent) => void>()
  private readonly cleanups = new Set<() => void | Promise<void>>()

  constructor(
    deps: VaultDeps,
    meta: LocalMeta,
    vault: { readonly id: Bytes; readonly text: string; readonly slots: readonly Slot[] } | null,
    secretKeyStored: boolean,
  ) {
    this.deps = deps
    this.meta = meta
    this.state = vault ? 'locked' : 'absent'
    this.vaultId = vault?.id ?? null
    this.vaultText = vault?.text ?? null
    for (const slot of vault?.slots ?? []) this.slots.set(slot.id, slot)
    this.secretKeyStored = secretKeyStored
    this.policy = checkPolicy(deps.autoLock ?? DEFAULT_AUTO_LOCK)
    this.lastActivity = deps.clock.now()
  }

  // Observation

  status(): VaultStatus {
    return {
      state: this.state,
      vaultId: this.vaultText,
      slots: this.sortedSlots().map(
        ({ id, keyslot }): SlotInfo => ({
          slot: id,
          kind: keyslot.kind,
          secretKey: keyslot.kind === 'passphrase' && keyslot.kdf.secretKey,
        }),
      ),
      holds: [...this.holds.values()],
      autoLock: this.policy,
      secretKeyOnDevice: this.secretKeyStored,
    }
  }

  subscribe(listener: (event: VaultEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onLock(cleanup: () => void | Promise<void>): () => void {
    // A wrapper makes each registration distinct, so registering one function twice runs it twice.
    const entry = () => cleanup()
    this.cleanups.add(entry)
    return () => {
      this.cleanups.delete(entry)
    }
  }

  subkeys(): Subkeys {
    return this.requireKeys()
  }

  localStore(): LocalStore {
    this.requireKeys()
    if (!this.store) throw new LockedError()
    return this.store
  }

  async keyslotFiles(): Promise<readonly KeyslotFile[]> {
    return this.sortedSlots().map(({ id, bytes }) => ({
      name: N.keyslotName(B.base32Decode(id)),
      bytes: new Uint8Array(bytes),
    }))
  }

  async secretKeyText(): Promise<string | null> {
    this.requireKeys()
    const sk = await this.deviceSecretKey()
    if (sk === null || sk === 'damaged') return null
    try {
      return await SK.formatSecretKey(sk)
    } finally {
      sk.fill(0)
    }
  }

  // Creation and unlocking

  async create(input: CreateVaultInput): Promise<CreatedVault> {
    if (this.state !== 'absent' || this.creating) throw new InvalidStateError('A vault already exists on this device')
    this.creating = true
    try {
      KS.normalizePassphrase(input.passphrase).fill(0)
      const withSecretKey = input.secretKey ?? true
      const remember = withSecretKey && (input.rememberSecretKey ?? true)
      const { rng } = this.deps
      const mk = rng.bytes(MK_BYTES)
      const vaultId = rng.bytes(ID_BYTES)
      const deviceId = rng.bytes(ID_BYTES)
      const sk = withSecretKey ? SK.generateSecretKey(rng) : null
      const rk = (input.recoveryKey ?? true) ? RK.generateRecoveryKey(rng) : null
      try {
        const keyslots = [
          await KS.createKeyslot(
            {
              kind: 'passphrase',
              mk,
              vaultId,
              passphrase: input.passphrase,
              secretKey: sk,
              argon2: this.deps.argon2Params,
            },
            { rng, argon2: this.deps.argon2 },
          ),
        ]
        if (rk) keyslots.push(await KS.createKeyslot({ kind: 'recovery', mk, vaultId, recoveryKey: rk }, { rng }))
        const vaultText = B.base32Encode(vaultId)
        const subkeys = await K.deriveSubkeys(mk, vaultId)
        const recoverySlot = keyslots.find((k) => k.kind === 'recovery')?.slot
        const created: CreatedVault = {
          vaultId: vaultText,
          secretKey: sk ? await SK.formatSecretKey(sk) : null,
          recoveryKey: rk ? RK.formatRecoveryKey(rk) : null,
          kitProof: recoverySlot ? await makeKitProof(subkeys, vaultText, recoverySlot, rng) : null,
        }
        const slots = keyslots.map((keyslot) => ({ id: keyslot.slot, keyslot, bytes: KS.serializeKeyslot(keyslot) }))
        const device = remember && sk ? await this.wrapSecretKey(sk, vaultText, await newDeviceKey()) : {}

        // One transaction: refused if another page created a vault meanwhile, and leftovers of an interrupted creation
        // are dropped.
        const made = await this.meta.initVault({
          entries: { fmt: FMT, vault: vaultText, ...device },
          keyslots: slots.map(({ id, bytes }) => ({ slot: id, bytes })),
        })
        if (!made) {
          await this.refresh()
          throw new InvalidStateError('A vault already exists on this device')
        }

        const store = createLocalStore({ db: this.deps.db, subkeys, rng })
        await store.put('device', 'id', deviceId)
        this.vaultId = vaultId
        this.vaultText = vaultText
        this.slots.clear()
        for (const slot of slots) this.slots.set(slot.id, slot)
        this.secretKeyStored = remember
        this.secretKeyDamaged = false
        this.enterUnlocked(subkeys, store)
        return created
      } finally {
        mk.fill(0)
        deviceId.fill(0)
        sk?.fill(0)
        rk?.fill(0)
      }
    } finally {
      this.creating = false
    }
  }

  async join(input: { readonly vault: string; readonly keyslots: readonly KeyslotFile[] }): Promise<void> {
    if (this.state !== 'absent' || this.creating) throw new InvalidStateError('A vault already exists on this device')
    this.creating = true
    try {
      let vaultId: Bytes
      try {
        vaultId = B.base32Decode(input.vault)
      } catch (cause) {
        throw new InvalidInputError('Not a vault id', { cause })
      }
      if (vaultId.length !== ID_BYTES) throw new InvalidInputError('Not a vault id')
      const slots: Slot[] = []
      for (const file of input.keyslots) {
        const keyslot = KS.parseKeyslot(file.bytes, { name: file.name })
        if (keyslot.vault !== input.vault) throw new InvalidInputError('A keyslot belongs to another vault')
        if (slots.some((s) => s.id === keyslot.slot)) continue
        slots.push({ id: keyslot.slot, keyslot, bytes: KS.serializeKeyslot(keyslot) })
      }
      if (!slots.some((s) => s.keyslot.kind !== 'recovery')) {
        throw new InvalidInputError('The vault has no slot that a passphrase opens')
      }
      const made = await this.meta.initVault({
        entries: { fmt: FMT, vault: input.vault },
        keyslots: slots.map(({ id, bytes }) => ({ slot: id, bytes })),
      })
      if (!made) {
        await this.refresh()
        throw new InvalidStateError('A vault already exists on this device')
      }
      this.vaultId = vaultId
      this.vaultText = input.vault
      this.slots.clear()
      for (const slot of slots) this.slots.set(slot.id, slot)
      this.secretKeyStored = false
      this.secretKeyDamaged = false
      this.setState('locked')
    } finally {
      this.creating = false
    }
  }

  importKeyslots(files: readonly KeyslotFile[]): Promise<readonly string[]> {
    return this.exclusive(async () => {
      const vault = this.requireVaultText()
      await this.reloadSlots()
      const added: string[] = []
      for (const file of files) {
        let keyslot: Keyslot
        try {
          keyslot = KS.parseKeyslot(file.bytes, { name: file.name })
        } catch (error) {
          // A slot this build cannot read opens nothing here; the others still come in.
          if (error instanceof AparteError) continue
          throw error
        }
        if (keyslot.vault !== vault || this.slots.has(keyslot.slot)) continue
        await this.addSlot(keyslot)
        added.push(keyslot.slot)
      }
      return added
    })
  }

  unlock(credential: UnlockCredential): Promise<void> {
    return this.unlockWith(credential, async () => undefined)
  }

  unlockAndRenewKit(credential: UnlockCredential, kitProof: string): Promise<RenewedKit | null> {
    return this.unlockWith(credential, async (opened) => {
      const vault = this.requireVaultText()
      const subkeys = await K.deriveSubkeys(opened.mk, this.requireVaultId())
      // Only a proof this vault made, for a recovery slot it still holds, asks for a renewal: the marker it comes with
      // is in localStorage, which every page of the origin can write.
      const named = await openKitProof(subkeys, vault, kitProof)
      if (named === null || this.slots.get(named)?.keyslot.kind !== 'recovery') return null
      const rk = RK.generateRecoveryKey(this.deps.rng)
      try {
        const added = await this.addSlot(
          await KS.createKeyslot(
            { kind: 'recovery', mk: opened.mk, vaultId: this.requireVaultId(), recoveryKey: rk },
            { rng: this.deps.rng },
          ),
        )
        // The new slot is persisted first: then the recovery keys that were never confirmed stop opening the vault.
        for (const slot of this.sortedSlots()) {
          if (slot.keyslot.kind === 'recovery' && slot.id !== added) await this.dropSlot(slot.id)
        }
        return {
          secretKey: opened.secretKey ? await SK.formatSecretKey(opened.secretKey) : null,
          recoveryKey: RK.formatRecoveryKey(rk),
          kitProof: await makeKitProof(subkeys, vault, added, this.deps.rng),
        }
      } finally {
        rk.fill(0)
      }
    })
  }

  async refresh(): Promise<void> {
    const vault = await this.meta.get('vault')
    if (vault === undefined) return
    if (this.vaultText === null) {
      // Another page created the vault after this one loaded.
      this.vaultId = await checkVault(this.meta, vault)
      this.vaultText = vault
    } else if (vault !== this.vaultText) {
      return
    }
    await this.reloadSlots()
    this.secretKeyStored = await hasStoredSecretKey(this.meta)
    this.secretKeyDamaged = false
    if (this.state === 'absent') this.setState('locked')
  }

  recover(input: {
    readonly recoveryKey: string
    readonly next: string
    readonly replace?: boolean
  }): Promise<{ readonly added: string; readonly secretKey: string | null }> {
    if (this.state !== 'locked') return Promise.reject(new InvalidStateError('The vault is not locked'))
    try {
      KS.normalizePassphrase(input.next).fill(0)
    } catch (error) {
      return Promise.reject(error)
    }
    return this.runUnlocking(async () => {
      await this.reloadSlots()
      // The recovery slot needs only the recovery key: a stored Secret Key that no longer unwraps does not stop it.
      const opened = await this.openWith({ kind: 'recovery', recoveryKey: input.recoveryKey })
      let sk: Bytes | null = null
      try {
        const stored = await this.deviceSecretKey()
        const generated = stored === null || stored === 'damaged'
        if (generated) {
          // The device keeps the new Secret Key before any slot needs it, so an interruption cannot strand a slot. A
          // device key that wrapped a damaged copy is replaced along with it.
          sk = SK.generateSecretKey(this.deps.rng)
          await this.rememberSecretKey(sk, this.requireVaultText(), stored === 'damaged')
        } else {
          sk = stored
        }
        const added = await this.addSlot(
          await KS.createKeyslot(
            {
              kind: 'passphrase',
              mk: opened.mk,
              vaultId: this.requireVaultId(),
              passphrase: input.next,
              secretKey: sk,
              argon2: this.deps.argon2Params,
            },
            { rng: this.deps.rng, argon2: this.deps.argon2 },
          ),
        )
        if (input.replace === true) {
          for (const slot of this.sortedSlots()) {
            if (slot.keyslot.kind === 'passphrase' && slot.id !== added) await this.dropSlot(slot.id)
          }
        }
        const secretKey = generated ? await SK.formatSecretKey(sk) : null
        await this.finishUnlock(await K.deriveSubkeys(opened.mk, this.requireVaultId()))
        return { added, secretKey }
      } finally {
        opened.mk.fill(0)
        sk?.fill(0)
      }
    })
  }

  // Slots

  changePassphrase(input: {
    readonly current: UnlockCredential
    readonly next: string
  }): Promise<{ readonly added: string; readonly previous: string }> {
    return this.exclusive(async () => {
      this.requireUnlocked()
      await this.reloadSlots()
      if (input.current.kind !== 'passphrase') {
        throw new InvalidInputError('Changing the passphrase needs the current passphrase')
      }
      KS.normalizePassphrase(input.next).fill(0)
      const opened = await this.openWith(input.current)
      try {
        const added = await this.addSlot(
          await KS.createKeyslot(
            {
              kind: 'passphrase',
              mk: opened.mk,
              vaultId: this.requireVaultId(),
              passphrase: input.next,
              secretKey: opened.secretKey,
              argon2: this.deps.argon2Params,
            },
            { rng: this.deps.rng, argon2: this.deps.argon2 },
          ),
        )
        return { added, previous: opened.slot.id }
      } finally {
        opened.mk.fill(0)
        opened.secretKey?.fill(0)
      }
    })
  }

  addRecoveryKey(current: UnlockCredential): Promise<{ readonly slot: string; readonly recoveryKey: string }> {
    return this.exclusive(async () => {
      this.requireUnlocked()
      await this.reloadSlots()
      const opened = await this.openWith(current)
      const rk = RK.generateRecoveryKey(this.deps.rng)
      try {
        const slot = await this.addSlot(
          await KS.createKeyslot(
            { kind: 'recovery', mk: opened.mk, vaultId: this.requireVaultId(), recoveryKey: rk },
            { rng: this.deps.rng },
          ),
        )
        return { slot, recoveryKey: RK.formatRecoveryKey(rk) }
      } finally {
        opened.mk.fill(0)
        opened.secretKey?.fill(0)
        rk.fill(0)
      }
    })
  }

  removeSlot(slot: string): Promise<void> {
    return this.exclusive(async () => {
      this.requireUnlocked()
      await this.reloadSlots()
      if (!this.slots.has(slot)) throw new InvalidInputError('This vault has no such slot')
      const others = [...this.slots.values()].filter((s) => s.id !== slot && s.keyslot.kind !== 'recovery')
      if (others.length === 0)
        throw new InvalidStateError('A vault keeps at least one slot that is not a recovery slot')
      await this.dropSlot(slot)
    })
  }

  // Locking

  lock(options?: { readonly force?: boolean }): Promise<void> {
    const force = options?.force === true
    switch (this.state) {
      case 'absent':
      case 'locked':
        return Promise.resolve()
      case 'unlocking': {
        // The unlock in progress ends in `locked` instead of `unlocked`; its own promise rejects with LockedError.
        this.unlockAborted = true
        const unlocking = this.unlocking ?? Promise.resolve()
        return unlocking.then(
          () => undefined,
          () => undefined,
        )
      }
      case 'unlocked':
        if (force) return this.finalizeLock('forced')
        if (this.holds.size === 0) return this.finalizeLock('user')
        return this.requestLock('user')
      case 'locking':
        if (force) return this.finalizeLock('forced')
        return this.finalizing ?? this.lockRequest?.done ?? Promise.resolve()
    }
  }

  holdLock(reason: string): () => void {
    if (this.state === 'locking') throw new InvalidStateError('The vault is locking')
    if (this.state !== 'unlocked') throw new LockedError()
    const id = ++this.holdSeq
    this.holds.set(id, reason)
    // A hold taken during the grace period restarts the wait: the grace runs again after its release.
    this.clearGrace()
    let released = false
    return () => {
      if (released) return
      released = true
      if (this.holds.delete(id)) this.holdsChanged()
    }
  }

  touch(): void {
    this.lastActivity = this.deps.clock.now()
    if (this.state !== 'unlocked') return
    if (this.idlePending) {
      this.idlePending = false
      this.clearGrace()
    }
    if (this.idleTimer === null) this.scheduleIdle()
  }

  setAutoLock(policy: AutoLockPolicy): void {
    this.policy = checkPolicy(policy)
    if (this.state !== 'unlocked') return
    this.clearIdle()
    if (this.policy.idleMs === null) {
      this.idlePending = false
      this.clearGrace()
      return
    }
    if (!this.idlePending) this.scheduleIdle()
  }

  // Internals

  private emit(event: VaultEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        report(error)
      }
    }
  }

  private setState(state: VaultState): void {
    if (this.state === state) return
    this.state = state
    this.emit({ type: 'state', state })
  }

  private sortedSlots(): Slot[] {
    return [...this.slots.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  private requireKeys(): Subkeys {
    if ((this.state === 'unlocked' || this.state === 'locking') && this.keys) return this.keys
    throw new LockedError()
  }

  private requireUnlocked(): void {
    if (this.state !== 'unlocked' || !this.keys) throw new LockedError()
  }

  private requireVaultId(): Bytes {
    if (!this.vaultId) throw new InvalidStateError('There is no vault on this device')
    return this.vaultId
  }

  private requireVaultText(): string {
    if (!this.vaultText) throw new InvalidStateError('There is no vault on this device')
    return this.vaultText
  }

  /** Serializes the operations that read and rewrite the slot list. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.exclusiveTail.then(fn, fn)
    this.exclusiveTail = run.catch(() => undefined)
    return run
  }

  private async addSlot(keyslot: Keyslot): Promise<string> {
    const slot: Slot = { id: keyslot.slot, keyslot, bytes: KS.serializeKeyslot(keyslot) }
    await this.meta.putKeyslot(slot.id, slot.bytes)
    this.slots.set(slot.id, slot)
    return slot.id
  }

  private async dropSlot(slot: string): Promise<void> {
    await this.meta.deleteKeyslot(slot)
    this.slots.delete(slot)
  }

  /** Reads the keyslots again: another page of this device may have added or removed one. */
  private async reloadSlots(): Promise<void> {
    const slots = await loadSlots(this.meta, this.requireVaultText())
    this.slots.clear()
    for (const slot of slots) this.slots.set(slot.id, slot)
  }

  /**
   * The shared path of unlock and unlockAndRenewKit: from `locked`, opens a slot with `credential`, runs `then` with
   * the master key still in hand, stores again a Secret Key typed in over a damaged copy, and enters `unlocked`.
   */
  private unlockWith<T>(credential: UnlockCredential, then: (opened: Opened) => Promise<T>): Promise<T> {
    if (this.state !== 'locked') return Promise.reject(new InvalidStateError('The vault is not locked'))
    return this.runUnlocking(async () => {
      await this.reloadSlots()
      const opened = await this.openWith(credential)
      try {
        const result = await then(opened)
        const typed = opened.secretKey && credential.kind === 'passphrase' && credential.secretKey
        if (typed && (this.secretKeyDamaged || credential.rememberSecretKey === true)) {
          await this.rememberSecretKey(opened.secretKey as Bytes, this.requireVaultText(), this.secretKeyDamaged)
        }
        await this.finishUnlock(await K.deriveSubkeys(opened.mk, this.requireVaultId()))
        return result
      } finally {
        opened.mk.fill(0)
        opened.secretKey?.fill(0)
      }
    })
  }

  /** Runs an unlocking operation from `locked`: `unlocking` while it runs, then `unlocked` or back to `locked`. */
  private runUnlocking<T>(fn: () => Promise<T>): Promise<T> {
    this.unlockAborted = false
    this.setState('unlocking')
    const run = (async () => {
      try {
        return await fn()
      } catch (error) {
        if (this.state === 'unlocking') this.setState('locked')
        throw error
      } finally {
        this.unlocking = null
      }
    })()
    this.unlocking = run
    return run
  }

  /** Binds the record store to fresh subkeys, gives the device its id if it has none, and enters `unlocked`. */
  private async finishUnlock(subkeys: Subkeys): Promise<void> {
    const store = createLocalStore({ db: this.deps.db, subkeys, rng: this.deps.rng })
    try {
      if (!this.unlockAborted && (await store.get('device', 'id')) === null) {
        const deviceId = this.deps.rng.bytes(ID_BYTES)
        try {
          await store.put('device', 'id', deviceId)
        } finally {
          deviceId.fill(0)
        }
      }
    } catch (error) {
      store.dispose()
      throw error
    }
    if (this.unlockAborted) {
      store.dispose()
      this.setState('locked')
      this.emit({ type: 'locked', reason: 'user' })
      throw new LockedError('The vault was locked while unlocking')
    }
    this.enterUnlocked(subkeys, store)
  }

  private enterUnlocked(subkeys: Subkeys, store: LocalStore): void {
    this.keys = subkeys
    this.store = store
    this.idlePending = false
    this.lastActivity = this.deps.clock.now()
    this.setState('unlocked')
    this.scheduleIdle()
  }

  /**
   * Opens one slot of the vault with what the user typed (spec/FORMAT.md section 6.7): every passphrase slot, or every
   * recovery slot, until one passes the commitment. A failure after the commitment is damage or an attack and stops
   * the search at once.
   */
  private async openWith(credential: UnlockCredential): Promise<Opened> {
    const vaultId = this.requireVaultId()
    const options = { vaultId, argon2: this.deps.argon2 }
    const slots = this.sortedSlots().filter((s) => s.keyslot.kind === credential.kind)

    if (credential.kind === 'recovery') {
      const recoveryKey = RK.parseRecoveryKey(credential.recoveryKey)
      try {
        for (const slot of slots) {
          const mk = await this.tryOpen(slot.keyslot, { kind: 'recovery', recoveryKey }, options)
          if (mk) return { mk, slot, secretKey: null }
        }
      } finally {
        recoveryKey.fill(0)
      }
      throw new WrongSecretError()
    }

    const { passphrase } = credential
    KS.normalizePassphrase(passphrase).fill(0)
    const needsSecretKey = (slot: Slot) => slot.keyslot.kind === 'passphrase' && slot.keyslot.kdf.secretKey
    let sk: Bytes | null = null
    if (credential.secretKey !== undefined) sk = await SK.parseSecretKey(credential.secretKey)
    else if (slots.some(needsSecretKey)) {
      // A stored copy that no longer unwraps counts as none: the caller then asks for the Secret Key of the kit.
      const stored = await this.deviceSecretKey()
      sk = stored === 'damaged' ? null : stored
    }
    try {
      let missingSecretKey = false
      for (const slot of slots) {
        const withSecretKey = needsSecretKey(slot)
        if (withSecretKey && !sk) {
          missingSecretKey = true
          continue
        }
        const secretKey = withSecretKey ? sk : null
        const mk = await this.tryOpen(slot.keyslot, { kind: 'passphrase', passphrase, secretKey }, options)
        if (mk) return { mk, slot, secretKey: secretKey ? new Uint8Array(secretKey) : null }
      }
      if (missingSecretKey) throw new InvalidInputError('This vault needs the Secret Key of its Emergency Kit')
      throw new WrongSecretError()
    } finally {
      sk?.fill(0)
    }
  }

  /** The master key, or null when the secret does not open this slot (commitment mismatch). */
  private async tryOpen(
    keyslot: Keyslot,
    secret: SlotSecret,
    options: Parameters<KeyslotModule['openKeyslot']>[2],
  ): Promise<Bytes | null> {
    try {
      return await KS.openKeyslot(keyslot, secret, options)
    } catch (error) {
      if (error instanceof WrongSecretError) return null
      throw error
    }
  }

  /**
   * The Secret Key this device remembers, unwrapped with the device key; null when it remembers none, `damaged` when
   * the stored copy does not unwrap (a partial restore of site data, or another page of the origin overwriting it).
   * A damaged copy turns `secretKeyOnDevice` false.
   */
  private async deviceSecretKey(): Promise<Bytes | 'damaged' | null> {
    let wrapped: Bytes | undefined
    try {
      wrapped = await this.meta.get('secret-key')
    } catch (error) {
      if (!(error instanceof AparteError)) throw error
      return this.secretKeyIsDamaged()
    }
    const deviceKey = await this.meta.get('device-key')
    if (!wrapped || !deviceKey) return null
    if (wrapped.length !== IV_BYTES + 32 || !(deviceKey instanceof CryptoKey)) return this.secretKeyIsDamaged()
    try {
      return await K.aesGcmDecrypt(
        deviceKey,
        wrapped.subarray(0, IV_BYTES),
        wrapped.subarray(IV_BYTES),
        deviceSecretAad(this.requireVaultText()),
      )
    } catch (error) {
      if (!(error instanceof AparteError)) throw error
      return this.secretKeyIsDamaged()
    }
  }

  private secretKeyIsDamaged(): 'damaged' {
    this.secretKeyDamaged = true
    this.secretKeyStored = false
    return 'damaged'
  }

  /** The `meta` entries that keep the Secret Key on this device: the device key and the Secret Key it wraps. */
  private async wrapSecretKey(
    sk: Uint8Array,
    vault: string,
    deviceKey: CryptoKey,
  ): Promise<{ readonly 'device-key': CryptoKey; readonly 'secret-key': Bytes }> {
    const iv = this.deps.rng.bytes(IV_BYTES)
    const sealed = await K.aesGcmEncrypt(deviceKey, iv, sk, deviceSecretAad(vault))
    return { 'device-key': deviceKey, 'secret-key': B.concat(iv, sealed) }
  }

  /**
   * Stores the Secret Key wrapped by the device key, creating that non-extractable key on first use, or anew when
   * `freshDeviceKey` (the previous one wrapped a copy that no longer unwraps).
   */
  private async rememberSecretKey(sk: Uint8Array, vault: string, freshDeviceKey = false): Promise<void> {
    const current = freshDeviceKey ? undefined : await this.meta.get('device-key')
    let deviceKey: CryptoKey
    if (current instanceof CryptoKey) {
      deviceKey = current
    } else {
      deviceKey = await newDeviceKey()
      await this.meta.put('device-key', deviceKey)
    }
    const entries = await this.wrapSecretKey(sk, vault, deviceKey)
    await this.meta.put('secret-key', entries['secret-key'])
    this.secretKeyStored = true
    this.secretKeyDamaged = false
  }

  /** Enters `locking` and waits there for the holds; the last release finalizes the lock. */
  private requestLock(reason: LockReason): Promise<void> {
    if (this.lockRequest) return this.lockRequest.done
    let resolve = () => {}
    const done = new Promise<void>((r) => {
      resolve = r
    })
    this.lockRequest = { reason, resolve, done }
    this.clearTimers()
    this.idlePending = false
    this.setState('locking')
    this.emit({ type: 'lock-deferred', holds: [...this.holds.values()] })
    return done
  }

  private holdsChanged(): void {
    if (this.holds.size > 0) return
    if (this.lockRequest && this.state === 'locking') {
      void this.finalizeLock(this.lockRequest.reason)
      return
    }
    if (this.idlePending && this.state === 'unlocked') {
      this.clearGrace()
      this.graceTimer = this.deps.timers.set(() => {
        this.graceTimer = null
        if (this.idlePending && this.holds.size === 0 && this.state === 'unlocked') void this.finalizeLock('idle')
      }, this.policy.graceMs)
    }
  }

  /**
   * Drops the keys and the record store at once, runs every cleanup, then enters `locked`. Holders still running lose
   * their keys: this runs only once they are released, on idle without holds, or when forced.
   */
  private finalizeLock(reason: LockReason): Promise<void> {
    if (this.finalizing) return this.finalizing
    this.setState('locking')
    this.clearTimers()
    this.idlePending = false
    const store = this.store
    this.store = null
    this.keys = null
    store?.dispose()
    this.holds.clear()
    const request = this.lockRequest
    this.lockRequest = null
    const run = (async () => {
      for (const cleanup of [...this.cleanups]) {
        try {
          await cleanup()
        } catch (error) {
          report(error)
        }
      }
      this.setState('locked')
      this.emit({ type: 'locked', reason })
      request?.resolve()
    })()
    this.finalizing = run.finally(() => {
      this.finalizing = null
    })
    return this.finalizing
  }

  private scheduleIdle(): void {
    this.clearIdle()
    const { idleMs } = this.policy
    if (idleMs === null || this.state !== 'unlocked') return
    const due = this.lastActivity + idleMs - this.deps.clock.now()
    this.idleTimer = this.deps.timers.set(() => this.idleElapsed(), Math.max(0, due))
  }

  /** The idle timer fired: re-arm it if there was activity since, otherwise lock now or once the holds are released. */
  private idleElapsed(): void {
    this.idleTimer = null
    const { idleMs } = this.policy
    if (idleMs === null || this.state !== 'unlocked' || this.idlePending) return
    if (this.deps.clock.now() - this.lastActivity < idleMs) {
      this.scheduleIdle()
      return
    }
    if (this.holds.size === 0) {
      void this.finalizeLock('idle')
      return
    }
    this.idlePending = true
    this.emit({ type: 'lock-deferred', holds: [...this.holds.values()] })
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) this.deps.timers.clear(this.idleTimer)
    this.idleTimer = null
  }

  private clearGrace(): void {
    if (this.graceTimer !== null) this.deps.timers.clear(this.graceTimer)
    this.graceTimer = null
  }

  private clearTimers(): void {
    this.clearIdle()
    this.clearGrace()
  }
}

/** The keyslots of `meta` that belong to this vault and parse; any other entry is left in place but never offered. */
async function loadSlots(meta: LocalMeta, vault: string): Promise<Slot[]> {
  const slots: Slot[] = []
  for (const { slot, bytes } of await meta.keyslots()) {
    try {
      const keyslot = KS.parseKeyslot(bytes, { name: `keys/${slot}.json` })
      if (keyslot.vault === vault) slots.push({ id: slot, keyslot, bytes })
    } catch (error) {
      // A slot this build cannot read (damaged, or from a newer format) opens nothing here; the others still do.
      if (!(error instanceof AparteError)) throw error
    }
  }
  return slots
}

/** The non-extractable AES-256-GCM key that wraps the Secret Key on this device (spec/FORMAT.md section 11.2). */
function newDeviceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** Checks the format marker and the stored vault id; returns the id's bytes. */
async function checkVault(meta: LocalMeta, vault: string): Promise<Bytes> {
  if ((await meta.get('fmt')) !== FMT) throw new UnsupportedFormatError('This device holds a vault of another format')
  let id: Bytes
  try {
    id = B.base32Decode(vault)
  } catch (cause) {
    throw new CorruptError('The stored vault id is malformed', { cause })
  }
  if (id.length !== ID_BYTES) throw new CorruptError('The stored vault id is malformed')
  return id
}

async function hasStoredSecretKey(meta: LocalMeta): Promise<boolean> {
  return (await meta.get('secret-key')) !== undefined && (await meta.get('device-key')) !== undefined
}

/** Reads `meta` and returns a vault in state `absent` or `locked`. */
export async function openVault(deps: VaultDeps): Promise<Vault> {
  const meta = createLocalMeta(deps.db)
  const vault = await meta.get('vault')
  if (vault === undefined) return new VaultImpl(deps, meta, null, false)
  const id = await checkVault(meta, vault)
  const slots = await loadSlots(meta, vault)
  return new VaultImpl(deps, meta, { id, text: vault, slots }, await hasStoredSecretKey(meta))
}
