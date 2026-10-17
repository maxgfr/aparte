/*
 * The vault state machine (web/src/core/contracts/vault.ts) over fake-indexeddb, with the small Argon2 parameters of
 * spec/vectors/inputs.json and a fake clock, so idle and grace periods are driven explicitly.
 */
import { describe, expect, test } from 'bun:test'
import {
  InvalidInputError,
  InvalidStateError,
  LockedError,
  type RngModule,
  WrongSecretError,
} from '../contracts/crypto.ts'
import type { LocalStoreModule } from '../contracts/store.ts'
import type { AutoLockPolicy, Clock, Timers, VaultEvent, VaultModule, VaultState } from '../contracts/vault.ts'
import * as rngImpl from '../crypto/rng.ts'
import * as storeImpl from '../store/localStore.ts'
import * as vaultImpl from './vault.ts'

const R: RngModule = rngImpl
const S: LocalStoreModule = storeImpl
const V: VaultModule = vaultImpl

const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  argon2: { m: number; t: number; p: number }
  passphrases: { ascii: string; unicode: string; unicodeEquivalent: string; wrong: string }
}
const PASS = inputs.passphrases.ascii
const NEXT = inputs.passphrases.unicode

/** A clock and timer queue that only move when the test says so. */
class FakeTime implements Clock, Timers {
  private t = 1_760_000_000_000
  private seq = 0
  private readonly queue = new Map<number, { at: number; fn: () => void }>()

  now(): number {
    return this.t
  }

  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq
    this.queue.set(id, { at: this.t + Math.max(0, ms), fn })
    return id
  }

  clear(handle: unknown): void {
    this.queue.delete(handle as number)
  }

  /** Moves time forward, firing due timers in order and letting the promises they start settle. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms
    for (;;) {
      const next = [...this.queue.entries()].filter(([, e]) => e.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      this.queue.delete(next[0])
      this.t = next[1].at
      next[1].fn()
      await settle()
    }
    this.t = end
    await settle()
  }
}

/** Lets pending promise chains (lock cleanups, IndexedDB requests) run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

let dbCount = 0
async function setup(autoLock: AutoLockPolicy = { idleMs: 60_000, graceMs: 5_000 }, dbName?: string) {
  const name = dbName ?? `vault-test-${++dbCount}-${crypto.randomUUID()}`
  const db = await S.openLocalDb({ name })
  const time = new FakeTime()
  const vault = await V.openVault({
    db,
    rng: R.cryptoRng(),
    clock: time,
    timers: time,
    argon2Params: inputs.argon2,
    autoLock,
  })
  const events: VaultEvent[] = []
  vault.subscribe((e) => events.push(e))
  return { name, db, time, vault, events }
}

async function created(autoLock?: AutoLockPolicy) {
  const ctx = await setup(autoLock)
  const kit = await ctx.vault.create({ passphrase: PASS })
  return { ...ctx, kit }
}

const states = (events: VaultEvent[]): VaultState[] => events.flatMap((e) => (e.type === 'state' ? [e.state] : []))

describe('creating', () => {
  test('a device without a vault is absent and has no keys', async () => {
    const { vault } = await setup()
    expect(vault.status().state).toBe('absent')
    expect(vault.status().vaultId).toBeNull()
    expect(() => vault.subkeys()).toThrow(LockedError)
    expect(() => vault.localStore()).toThrow(LockedError)
    await expect(vault.unlock({ kind: 'passphrase', passphrase: PASS })).rejects.toBeInstanceOf(InvalidStateError)
  })

  test('create unlocks, and returns the Emergency Kit and the recovery key once', async () => {
    const { vault, kit } = await created()
    expect(vault.status().state).toBe('unlocked')
    expect(kit.vaultId).toMatch(/^[a-z2-7]{26}$/)
    expect(vault.status().vaultId).toBe(kit.vaultId)
    expect(kit.secretKey).toMatch(/^A1(-[A-Z2-7]{5}){6}$/)
    expect(kit.recoveryKey).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){12}$/)
    expect(vault.status().secretKeyOnDevice).toBe(true)
    const kinds = vault.status().slots.map((s) => [s.kind, s.secretKey])
    expect(kinds.sort()).toEqual([
      ['passphrase', true],
      ['recovery', false],
    ])
    expect(vault.subkeys().objName.extractable).toBe(false)
  })

  test('the keyslot files are named after their slots', async () => {
    const { vault } = await created()
    const files = await vault.keyslotFiles()
    expect(files).toHaveLength(2)
    for (const f of files) {
      const parsed = JSON.parse(new TextDecoder().decode(f.bytes)) as { slot: string; vault: string }
      expect(f.name).toBe(`keys/${parsed.slot}.json`)
      expect(parsed.vault).toBe(vault.status().vaultId as string)
    }
  })

  test('without a Secret Key or a recovery slot when asked', async () => {
    const { vault } = await setup()
    const kit = await vault.create({ passphrase: PASS, secretKey: false, recoveryKey: false })
    expect(kit.secretKey).toBeNull()
    expect(kit.recoveryKey).toBeNull()
    expect(vault.status().slots).toEqual([expect.objectContaining({ kind: 'passphrase', secretKey: false })])
  })

  test('refuses a second vault and an empty passphrase', async () => {
    const { vault } = await created()
    await expect(vault.create({ passphrase: NEXT })).rejects.toBeInstanceOf(InvalidStateError)
    const fresh = await setup()
    await expect(fresh.vault.create({ passphrase: '' })).rejects.toBeInstanceOf(InvalidInputError)
    expect(fresh.vault.status().state).toBe('absent')
  })
})

describe('locking', () => {
  test('lock clears the keys, disposes the store and runs the cleanups', async () => {
    const { vault, events } = await created()
    const store = vault.localStore()
    await store.put('draft', 'x', new Uint8Array([1]))
    let cleaned = 0
    vault.onLock(() => {
      cleaned++
    })
    await vault.lock()
    expect(vault.status().state).toBe('locked')
    expect(() => vault.subkeys()).toThrow(LockedError)
    expect(() => vault.localStore()).toThrow(LockedError)
    await expect(store.get('draft', 'x')).rejects.toBeInstanceOf(LockedError)
    expect(cleaned).toBe(1)
    expect(events).toContainEqual({ type: 'locked', reason: 'user' })
    expect(states(events).slice(-2)).toEqual(['locking', 'locked'])
  })

  test('an unregistered cleanup does not run', async () => {
    const { vault } = await created()
    let cleaned = 0
    const off = vault.onLock(() => {
      cleaned++
    })
    off()
    await vault.lock()
    expect(cleaned).toBe(0)
  })
})

describe('unlocking', () => {
  test('with the passphrase alone, since the device remembers the Secret Key', async () => {
    const { vault, kit, events } = await created()
    await vault.localStore().put('draft', 'note', new Uint8Array([4, 2]))
    await vault.lock()
    events.length = 0
    await vault.unlock({ kind: 'passphrase', passphrase: PASS })
    expect(vault.status().state).toBe('unlocked')
    expect(vault.status().vaultId).toBe(kit.vaultId)
    expect(states(events)).toEqual(['unlocking', 'unlocked'])
    // Records written before the lock are readable again with the re-derived keys.
    expect(await vault.localStore().get('draft', 'note')).toEqual(new Uint8Array([4, 2]))
  })

  test('a wrong passphrase leaves the vault locked', async () => {
    const { vault } = await created()
    await vault.lock()
    await expect(vault.unlock({ kind: 'passphrase', passphrase: inputs.passphrases.wrong })).rejects.toBeInstanceOf(
      WrongSecretError,
    )
    expect(vault.status().state).toBe('locked')
    expect(() => vault.subkeys()).toThrow(LockedError)
  })

  test('a wrong or malformed Secret Key is refused', async () => {
    const { vault, kit } = await created()
    await vault.lock()
    const other = (await (await setup()).vault.create({ passphrase: PASS })).secretKey as string
    await expect(vault.unlock({ kind: 'passphrase', passphrase: PASS, secretKey: other })).rejects.toBeInstanceOf(
      WrongSecretError,
    )
    await expect(
      vault.unlock({ kind: 'passphrase', passphrase: PASS, secretKey: 'A1-NOT-A-KEY' }),
    ).rejects.toBeInstanceOf(InvalidInputError)
    await vault.unlock({ kind: 'passphrase', passphrase: PASS, secretKey: kit.secretKey as string })
    expect(vault.status().state).toBe('unlocked')
  })

  test('a reopened device finds its vault locked and unlocks it', async () => {
    const first = await created()
    await first.vault.lock()
    const again = await setup(undefined, first.name)
    expect(again.vault.status().state).toBe('locked')
    expect(again.vault.status().vaultId).toBe(first.kit.vaultId)
    await again.vault.unlock({ kind: 'passphrase', passphrase: PASS })
    expect(again.vault.status().state).toBe('unlocked')
  })

  test('a device that does not remember the Secret Key asks for it', async () => {
    const { vault } = await setup()
    const kit = await vault.create({ passphrase: PASS, rememberSecretKey: false })
    expect(vault.status().secretKeyOnDevice).toBe(false)
    await vault.lock()
    await expect(vault.unlock({ kind: 'passphrase', passphrase: PASS })).rejects.toBeInstanceOf(InvalidInputError)
    await vault.unlock({ kind: 'passphrase', passphrase: PASS, secretKey: kit.secretKey as string })
    expect(vault.status().state).toBe('unlocked')
  })

  test('unlocking an unlocked vault is refused', async () => {
    const { vault } = await created()
    await expect(vault.unlock({ kind: 'passphrase', passphrase: PASS })).rejects.toBeInstanceOf(InvalidStateError)
  })
})

describe('auto-lock', () => {
  test('locks after the idle period, and activity restarts it', async () => {
    const { vault, time, events } = await created({ idleMs: 60_000, graceMs: 5_000 })
    await time.advance(59_000)
    expect(vault.status().state).toBe('unlocked')
    vault.touch()
    await time.advance(59_000)
    expect(vault.status().state).toBe('unlocked')
    await time.advance(1_001)
    expect(vault.status().state).toBe('locked')
    expect(events).toContainEqual({ type: 'locked', reason: 'idle' })
  })

  test('holdLock defers it past the idle period, then the grace period runs after the last release', async () => {
    const { vault, time, events } = await created({ idleMs: 60_000, graceMs: 5_000 })
    const releaseStream = vault.holdLock('streaming')
    const releaseWrite = vault.holdLock('write')
    expect([...vault.status().holds].sort()).toEqual(['streaming', 'write'])
    await time.advance(10 * 60_000)
    expect(vault.status().state).toBe('unlocked')
    expect(events.some((e) => e.type === 'lock-deferred')).toBe(true)
    releaseWrite()
    await time.advance(60_000)
    expect(vault.status().state).toBe('unlocked')
    releaseStream()
    releaseStream()
    expect(vault.status().holds).toEqual([])
    await time.advance(4_999)
    expect(vault.status().state).toBe('unlocked')
    await time.advance(2)
    expect(vault.status().state).toBe('locked')
  })

  test('activity during the grace period cancels the deferred lock', async () => {
    const { vault, time } = await created({ idleMs: 60_000, graceMs: 5_000 })
    const release = vault.holdLock('streaming')
    await time.advance(61_000)
    release()
    await time.advance(2_000)
    vault.touch()
    await time.advance(10_000)
    expect(vault.status().state).toBe('unlocked')
    await time.advance(60_000)
    expect(vault.status().state).toBe('locked')
  })

  test('never auto-locks with idleMs null', async () => {
    const { vault, time } = await created({ idleMs: null, graceMs: 0 })
    await time.advance(24 * 3_600_000)
    expect(vault.status().state).toBe('unlocked')
  })

  test('setAutoLock applies a new policy', async () => {
    const { vault, time } = await created({ idleMs: null, graceMs: 0 })
    vault.setAutoLock({ idleMs: 1_000, graceMs: 0 })
    expect(vault.status().autoLock).toEqual({ idleMs: 1_000, graceMs: 0 })
    await time.advance(1_001)
    expect(vault.status().state).toBe('locked')
  })

  test('the default policy is five minutes idle and thirty seconds of grace', () => {
    expect(V.DEFAULT_AUTO_LOCK).toEqual({ idleMs: 300_000, graceMs: 30_000 })
  })
})

describe('an explicit lock and holds', () => {
  test('waits in locking for the holds, keeping the keys for them, and refuses new holds', async () => {
    const { vault } = await created()
    const release = vault.holdLock('streaming')
    const locked = vault.lock()
    await settle()
    expect(vault.status().state).toBe('locking')
    expect(vault.subkeys().objName).toBeInstanceOf(CryptoKey)
    expect(() => vault.holdLock('another')).toThrow(InvalidStateError)
    release()
    await locked
    expect(vault.status().state).toBe('locked')
  })

  test('force locks at once', async () => {
    const { vault, events } = await created()
    vault.holdLock('streaming')
    await vault.lock({ force: true })
    expect(vault.status().state).toBe('locked')
    expect(events).toContainEqual({ type: 'locked', reason: 'forced' })
  })
})

describe('changing the passphrase', () => {
  test('adds a slot: old and new both open until the old one is removed', async () => {
    const { vault } = await created()
    const before = vault.status().slots.length
    const { added, previous } = await vault.changePassphrase({
      current: { kind: 'passphrase', passphrase: PASS },
      next: NEXT,
    })
    expect(added).not.toBe(previous)
    expect(vault.status().slots).toHaveLength(before + 1)
    expect(vault.status().slots.find((s) => s.slot === added)).toMatchObject({ kind: 'passphrase', secretKey: true })

    await vault.lock()
    await vault.unlock({ kind: 'passphrase', passphrase: PASS })
    await vault.lock()
    await vault.unlock({ kind: 'passphrase', passphrase: inputs.passphrases.unicodeEquivalent })

    await vault.removeSlot(previous)
    expect(vault.status().slots.map((s) => s.slot)).not.toContain(previous)
    expect((await vault.keyslotFiles()).map((f) => f.name)).not.toContain(`keys/${previous}.json`)
    await vault.lock()
    await expect(vault.unlock({ kind: 'passphrase', passphrase: PASS })).rejects.toBeInstanceOf(WrongSecretError)
    await vault.unlock({ kind: 'passphrase', passphrase: NEXT })
    expect(vault.status().state).toBe('unlocked')
  })

  test('needs the current passphrase', async () => {
    const { vault } = await created()
    await expect(
      vault.changePassphrase({ current: { kind: 'passphrase', passphrase: inputs.passphrases.wrong }, next: NEXT }),
    ).rejects.toBeInstanceOf(WrongSecretError)
  })

  test('never removes the last slot that is not a recovery slot', async () => {
    const { vault } = await created()
    const only = vault.status().slots.find((s) => s.kind === 'passphrase')
    await expect(vault.removeSlot(only?.slot ?? '')).rejects.toBeInstanceOf(InvalidStateError)
    expect(vault.status().slots).toHaveLength(2)
  })

  test('removing a slot needs the vault unlocked', async () => {
    const { vault } = await created()
    const recovery = vault.status().slots.find((s) => s.kind === 'recovery')
    await vault.lock()
    await expect(vault.removeSlot(recovery?.slot ?? '')).rejects.toBeInstanceOf(LockedError)
  })
})

describe('recovery', () => {
  test('the recovery key unlocks', async () => {
    const { vault, kit } = await created()
    await vault.lock()
    await vault.unlock({ kind: 'recovery', recoveryKey: (kit.recoveryKey as string).toLowerCase() })
    expect(vault.status().state).toBe('unlocked')
  })

  test('a wrong recovery key is wrong-secret, a malformed one invalid-input', async () => {
    const { vault } = await created()
    await vault.lock()
    const wrong = (await (await setup()).vault.create({ passphrase: PASS })).recoveryKey as string
    await expect(vault.unlock({ kind: 'recovery', recoveryKey: wrong })).rejects.toBeInstanceOf(WrongSecretError)
    await expect(vault.unlock({ kind: 'recovery', recoveryKey: 'ABCD-EFGH' })).rejects.toBeInstanceOf(InvalidInputError)
    expect(vault.status().state).toBe('locked')
  })

  test('recover sets a new passphrase from the recovery key', async () => {
    const { vault, kit } = await created()
    await vault.lock()
    const { added, secretKey } = await vault.recover({ recoveryKey: kit.recoveryKey as string, next: NEXT })
    expect(secretKey).toBeNull()
    expect(vault.status().state).toBe('unlocked')
    expect(vault.status().slots.map((s) => s.slot)).toContain(added)
    await vault.lock()
    await vault.unlock({ kind: 'passphrase', passphrase: NEXT })
    expect(vault.status().state).toBe('unlocked')
  })

  test('addRecoveryKey adds a working recovery slot', async () => {
    const { vault } = await setup()
    await vault.create({ passphrase: PASS, recoveryKey: false })
    const { slot, recoveryKey } = await vault.addRecoveryKey({ kind: 'passphrase', passphrase: PASS })
    expect(vault.status().slots.find((s) => s.slot === slot)?.kind).toBe('recovery')
    await vault.lock()
    await vault.unlock({ kind: 'recovery', recoveryKey })
    expect(vault.status().state).toBe('unlocked')
  })
})

describe('events', () => {
  test('subscribers stop receiving events once unsubscribed', async () => {
    const { vault } = await created()
    const seen: VaultEvent[] = []
    const off = vault.subscribe((e) => seen.push(e))
    off()
    await vault.lock()
    expect(seen).toEqual([])
  })

  test('the Emergency Kit text can be shown again while unlocked', async () => {
    const { vault, kit } = await created()
    expect(await vault.secretKeyText()).toBe(kit.secretKey)
    await vault.lock()
    await expect(vault.secretKeyText()).rejects.toBeInstanceOf(LockedError)
  })
})
