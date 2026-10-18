/*
 * The device slot of spec/FORMAT.md section 17: a vault that opens on this device without a passphrase, how it is
 * protected with a passphrase and unprotected again, what a damaged or planted device slot does, and how a device
 * vault gives way to one joined from a sync store. Over fake-indexeddb, with the small Argon2 parameters of
 * spec/vectors/inputs.json and a clock that only moves when the test says so.
 */
import { describe, expect, test } from 'bun:test'
import {
  CorruptError,
  InvalidInputError,
  InvalidStateError,
  LockedError,
  type RngModule,
  TamperedError,
  WrongSecretError,
} from '../contracts/crypto.ts'
import type { LocalDb, LocalStoreModule } from '../contracts/store.ts'
import type { Clock, Timers, Vault, VaultEvent, VaultModule } from '../contracts/vault.ts'
import * as rngImpl from '../crypto/rng.ts'
import * as storeImpl from '../store/localStore.ts'
import * as vaultImpl from './vault.ts'

const R: RngModule = rngImpl
const S: LocalStoreModule = storeImpl
const V: VaultModule = vaultImpl

const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  argon2: { m: number; t: number; p: number }
  passphrases: { ascii: string; unicode: string; wrong: string }
}
const PASS = inputs.passphrases.ascii
const WRONG = inputs.passphrases.wrong

const IDLE_MS = 60_000

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

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

let dbCount = 0

/** One page of the app over the database `name`. */
async function page(name: string, time = new FakeTime()) {
  const db = await S.openLocalDb({ name })
  const vault = await V.openVault({
    db,
    rng: R.cryptoRng(),
    clock: time,
    timers: time,
    argon2Params: inputs.argon2,
    autoLock: { idleMs: IDLE_MS, graceMs: 5_000 },
  })
  const events: VaultEvent[] = []
  vault.subscribe((e) => events.push(e))
  return { db, time, vault, events }
}

/** A fresh database with a device vault in it, unlocked. */
async function deviceVault() {
  const name = `device-test-${++dbCount}-${crypto.randomUUID()}`
  const ctx = await page(name)
  await ctx.vault.createDevice()
  return { name, ...ctx }
}

/** Every key and value of one store of the raw database, as structured clone gives them back. */
function rawEntries(name: string, store: string): Promise<Map<string, unknown>> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction(store, 'readonly')
      const keys = tx.objectStore(store).getAllKeys()
      const values = tx.objectStore(store).getAll()
      tx.oncomplete = () => {
        open.result.close()
        resolve(new Map(keys.result.map((k, i) => [String(k), values.result[i]])))
      }
      tx.onerror = () => reject(tx.error)
    }
  })
}

function rawPut(name: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const tx = open.result.transaction('meta', 'readwrite')
      tx.objectStore('meta').put(value, key)
      tx.oncomplete = () => {
        open.result.close()
        resolve()
      }
      tx.onerror = () => reject(tx.error)
    }
  })
}

const metaKeys = async (name: string) => [...(await rawEntries(name, 'meta')).keys()].sort()
const keyslotKeys = async (name: string) => (await metaKeys(name)).filter((k) => k.startsWith('keyslot:'))

/** Keeps a draft in the vault, as the app keeps any record. */
async function writeDraft(vault: Vault, text: string): Promise<void> {
  await vault.localStore().put('draft', 'composer', new TextEncoder().encode(text))
}

async function readDraft(vault: Vault): Promise<string | null> {
  const bytes = await vault.localStore().get('draft', 'composer')
  return bytes === null ? null : new TextDecoder().decode(bytes)
}

/** Reopens the database `name` as a page loading anew, its vault locked. */
async function reopen(db: LocalDb, name: string) {
  db.close()
  return page(name)
}

describe('creating a device vault', () => {
  test('opens at once, with a device slot and no keyslot, nothing to sync and no Secret Key', async () => {
    const { name, vault } = await deviceVault()
    const status = vault.status()
    expect(status.state).toBe('unlocked')
    expect(status.protection).toBe('device')
    expect(status.vaultId).toMatch(/^[a-z2-7]{26}$/)
    expect(status.slots).toEqual([])
    expect(status.secretKeyOnDevice).toBe(false)
    expect(await vault.keyslotFiles()).toEqual([])
    expect(await vault.secretKeyText()).toBeNull()

    const meta = await rawEntries(name, 'meta')
    expect([...meta.keys()].sort()).toEqual(['device-slot', 'device-slot-key', 'fmt', 'vault'])
    const key = meta.get('device-slot-key')
    // The key rests as a CryptoKey object the platform refuses to export, not as bytes.
    expect(key).toBeInstanceOf(CryptoKey)
    expect((key as CryptoKey).extractable).toBe(false)
    expect((key as CryptoKey).algorithm.name).toBe('AES-GCM')
    await expect(crypto.subtle.exportKey('raw', key as CryptoKey)).rejects.toThrow()
    const slot = meta.get('device-slot')
    expect(slot).toBeInstanceOf(Uint8Array)
    expect((slot as Uint8Array).length).toBe(60)
  })

  test('never auto-locks, and keeps no idle timer', async () => {
    const { vault, time } = await deviceVault()
    await time.advance(IDLE_MS * 10)
    expect(vault.status().state).toBe('unlocked')
    vault.touch()
    await time.advance(IDLE_MS * 10)
    expect(vault.status().state).toBe('unlocked')
  })

  test('is refused over a vault another page created first, which is then seen locked', async () => {
    const { name } = await deviceVault()
    const other = await page(name)
    // This page loaded with the vault already there: it reads it locked.
    expect(other.vault.status().state).toBe('locked')
    const late = await page(`device-late-${crypto.randomUUID()}`)
    await late.vault.createDevice()
    await expect(late.vault.createDevice()).rejects.toBeInstanceOf(InvalidStateError)
  })

  test('a second page that loaded before the vault existed cannot create another one over it', async () => {
    const name = `device-race-${++dbCount}-${crypto.randomUUID()}`
    const first = await page(name)
    const second = await page(name)
    await first.vault.createDevice()
    await expect(second.vault.createDevice()).rejects.toBeInstanceOf(InvalidStateError)
    expect(second.vault.status().state).toBe('locked')
    expect(second.vault.status().vaultId).toBe(first.vault.status().vaultId)
    await second.vault.unlock({ kind: 'device' })
    expect(second.vault.status().state).toBe('unlocked')
  })

  test('the page that lost the creation race opens the vault as soon as it reads it locked', async () => {
    const name = `device-race-open-${++dbCount}-${crypto.randomUUID()}`
    const first = await page(name)
    const second = await page(name)
    await first.vault.createDevice()
    // As the app does: the moment the state turns locked, it opens the device slot.
    let opening: Promise<void> | null = null
    second.vault.subscribe((e) => {
      if (e.type === 'state' && e.state === 'locked' && opening === null)
        opening = second.vault.unlock({ kind: 'device' })
    })
    await expect(second.vault.createDevice()).rejects.toBeInstanceOf(InvalidStateError)
    expect(opening).not.toBeNull()
    await opening
    expect(second.vault.status().state).toBe('unlocked')
  })
})

describe('opening a device vault', () => {
  test('a reloaded page finds it locked and opens it with the device slot alone, records intact', async () => {
    const { name, db, vault } = await deviceVault()
    await writeDraft(vault, 'kept across a reload')
    const vaultId = vault.status().vaultId
    const again = await reopen(db, name)
    expect(again.vault.status().state).toBe('locked')
    expect(again.vault.status().protection).toBe('device')
    expect(again.vault.status().vaultId).toBe(vaultId)
    await again.vault.unlock({ kind: 'device' })
    expect(again.vault.status().state).toBe('unlocked')
    expect(await readDraft(again.vault)).toBe('kept across a reload')
  })

  test('a lock drops the keys; the device slot opens the vault again', async () => {
    const { vault } = await deviceVault()
    await vault.lock()
    expect(vault.status().state).toBe('locked')
    expect(() => vault.localStore()).toThrow(LockedError)
    await vault.unlock({ kind: 'device' })
    expect(vault.status().state).toBe('unlocked')
  })

  test('a passphrase does not open it: there is no passphrase slot', async () => {
    const { vault } = await deviceVault()
    await vault.lock()
    await expect(vault.unlock({ kind: 'passphrase', passphrase: PASS })).rejects.toBeInstanceOf(WrongSecretError)
    expect(vault.status().state).toBe('locked')
  })
})

describe('a damaged or missing device slot', () => {
  test('a missing key is corrupt, and leaves the vault locked', async () => {
    const { name, db, vault } = await deviceVault()
    await vault.lock()
    await S.createLocalMeta(db).delete('device-slot-key')
    const again = await reopen(db, name)
    await expect(again.vault.unlock({ kind: 'device' })).rejects.toBeInstanceOf(CorruptError)
    expect(again.vault.status().state).toBe('locked')
    expect(again.vault.status().protection).toBe('device')
  })

  test('a missing slot is corrupt', async () => {
    const { vault, db } = await deviceVault()
    await vault.lock()
    await S.createLocalMeta(db).delete('device-slot')
    await expect(vault.unlock({ kind: 'device' })).rejects.toBeInstanceOf(CorruptError)
    expect(vault.status().state).toBe('locked')
  })

  test('a key that is not a CryptoKey, or a slot of the wrong length, is corrupt', async () => {
    const { name, vault } = await deviceVault()
    await vault.lock()
    await rawPut(name, 'device-slot-key', crypto.getRandomValues(new Uint8Array(32)))
    await expect(vault.unlock({ kind: 'device' })).rejects.toBeInstanceOf(CorruptError)

    const other = await deviceVault()
    await other.vault.lock()
    await rawPut(other.name, 'device-slot', crypto.getRandomValues(new Uint8Array(59)))
    await expect(other.vault.unlock({ kind: 'device' })).rejects.toBeInstanceOf(CorruptError)
    expect(other.vault.status().state).toBe('locked')
  })

  test('a slot or a key replaced by another one does not unwrap: tampered', async () => {
    const { vault, db } = await deviceVault()
    await vault.lock()
    const meta = S.createLocalMeta(db)
    await meta.put('device-slot', crypto.getRandomValues(new Uint8Array(60)))
    await expect(vault.unlock({ kind: 'device' })).rejects.toBeInstanceOf(TamperedError)
    expect(vault.status().state).toBe('locked')

    const other = await deviceVault()
    await other.vault.lock()
    const planted = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    await S.createLocalMeta(other.db).put('device-slot-key', planted)
    await expect(other.vault.unlock({ kind: 'device' })).rejects.toBeInstanceOf(TamperedError)
  })

  test('the slot is bound to its vault: the slot of another vault does not unwrap', async () => {
    const a = await deviceVault()
    const b = await deviceVault()
    await a.vault.lock()
    await b.vault.lock()
    const metaA = await rawEntries(a.name, 'meta')
    // B gets A's key and A's slot, but keeps its own vault id.
    await rawPut(b.name, 'device-slot', metaA.get('device-slot'))
    await rawPut(b.name, 'device-slot-key', metaA.get('device-slot-key'))
    await expect(b.vault.unlock({ kind: 'device' })).rejects.toBeInstanceOf(TamperedError)
  })

  test('reset starts over with a new empty vault, deleting what the old one stored', async () => {
    const { name, db, vault } = await deviceVault()
    await writeDraft(vault, 'lost with the key')
    const before = vault.status().vaultId
    await vault.lock()
    await S.createLocalMeta(db).delete('device-slot-key')
    await expect(vault.unlock({ kind: 'device' })).rejects.toBeInstanceOf(CorruptError)
    await vault.reset()
    expect(vault.status().state).toBe('unlocked')
    expect(vault.status().protection).toBe('device')
    expect(vault.status().vaultId).not.toBe(before)
    expect(await readDraft(vault)).toBeNull()
    // Only the new vault's own device record is left.
    expect((await rawEntries(name, 'local')).size).toBe(1)
  })

  test('reset is refused unless a locked device vault is there', async () => {
    const { vault } = await deviceVault()
    await expect(vault.reset()).rejects.toBeInstanceOf(InvalidStateError)
    await vault.protect({ passphrase: PASS })
    await vault.lock()
    await expect(vault.reset()).rejects.toBeInstanceOf(InvalidStateError)
    expect(vault.status().protection).toBe('passphrase')
  })
})

describe('protecting with a passphrase', () => {
  test('adds a passphrase slot and a recovery slot, deletes the device slot and its key, keeps the records', async () => {
    const { name, db, vault, events } = await deviceVault()
    await writeDraft(vault, 'written before the passphrase')
    const kit = await vault.protect({ passphrase: PASS })
    expect(kit.vaultId).toBe(vault.status().vaultId as string)
    expect(kit.secretKey).toMatch(/^A1(-[A-Z2-7]{5}){6}$/)
    expect(kit.recoveryKey).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){12}$/)
    expect(kit.kitProof).not.toBeNull()
    expect(events).toContainEqual({ type: 'changed' })

    const status = vault.status()
    expect(status.state).toBe('unlocked')
    expect(status.protection).toBe('passphrase')
    expect(status.slots.map((s) => s.kind).sort()).toEqual(['passphrase', 'recovery'])
    expect(status.secretKeyOnDevice).toBe(true)
    const keys = await metaKeys(name)
    expect(keys).not.toContain('device-slot')
    expect(keys).not.toContain('device-slot-key')
    expect(keys).toContain('device-key')
    expect(keys).toContain('secret-key')
    expect(await keyslotKeys(name)).toHaveLength(2)
    expect(await vault.keyslotFiles()).toHaveLength(2)

    // A reload asks for the passphrase; the device slot opens nothing any more.
    const again = await reopen(db, name)
    expect(again.vault.status().state).toBe('locked')
    expect(again.vault.status().protection).toBe('passphrase')
    await expect(again.vault.unlock({ kind: 'device' })).rejects.toBeInstanceOf(InvalidStateError)
    expect(again.vault.status().state).toBe('locked')
    await again.vault.unlock({ kind: 'passphrase', passphrase: PASS })
    expect(await readDraft(again.vault)).toBe('written before the passphrase')
  })

  test('the recovery key of the kit opens the vault', async () => {
    const { vault } = await deviceVault()
    const kit = await vault.protect({ passphrase: PASS })
    await vault.lock()
    await vault.unlock({ kind: 'recovery', recoveryKey: kit.recoveryKey as string })
    expect(vault.status().state).toBe('unlocked')
  })

  test('starts the auto-lock', async () => {
    const { vault, time } = await deviceVault()
    await vault.protect({ passphrase: PASS })
    await time.advance(IDLE_MS + 1)
    expect(vault.status().state).toBe('locked')
  })

  test('is refused for an empty passphrase, a locked vault, or a vault already protected', async () => {
    const { name, vault } = await deviceVault()
    await expect(vault.protect({ passphrase: '' })).rejects.toBeInstanceOf(InvalidInputError)
    expect(vault.status().protection).toBe('device')
    expect(await metaKeys(name)).toContain('device-slot')
    await vault.lock()
    await expect(vault.protect({ passphrase: PASS })).rejects.toBeInstanceOf(LockedError)
    await vault.unlock({ kind: 'device' })
    await vault.protect({ passphrase: PASS })
    await expect(vault.protect({ passphrase: PASS })).rejects.toBeInstanceOf(InvalidStateError)
    expect(await keyslotKeys(name)).toHaveLength(2)
  })

  test('a page that protected in another tab is seen protected here after refresh, and this page starts locking', async () => {
    const { name, vault, time } = await deviceVault()
    const other = await page(name, time)
    await other.vault.unlock({ kind: 'device' })
    await vault.protect({ passphrase: PASS })
    // The other page still holds the keys, and a protect from it now finds the vault protected.
    await expect(other.vault.protect({ passphrase: PASS })).rejects.toBeInstanceOf(InvalidStateError)
    await other.vault.refresh()
    expect(other.vault.status().protection).toBe('passphrase')
    expect(other.events).toContainEqual({ type: 'changed' })
    await time.advance(IDLE_MS + 1)
    expect(other.vault.status().state).toBe('locked')
  })

  test('a device slot planted next to a passphrase slot opens nothing, and the next unlock deletes it', async () => {
    const victim = await deviceVault()
    await victim.vault.protect({ passphrase: PASS })
    await victim.vault.lock()
    // Another page of the origin makes a device vault of its own and copies its device slot over.
    const attacker = await deviceVault()
    await attacker.vault.lock()
    const planted = await rawEntries(attacker.name, 'meta')
    await rawPut(victim.name, 'device-slot', planted.get('device-slot'))
    await rawPut(victim.name, 'device-slot-key', planted.get('device-slot-key'))
    const again = await reopen(victim.db, victim.name)
    expect(again.vault.status().protection).toBe('passphrase')
    await expect(again.vault.unlock({ kind: 'device' })).rejects.toBeInstanceOf(InvalidStateError)
    expect(again.vault.status().state).toBe('locked')
    await again.vault.unlock({ kind: 'passphrase', passphrase: PASS })
    const keys = await metaKeys(victim.name)
    expect(keys).not.toContain('device-slot')
    expect(keys).not.toContain('device-slot-key')
  })
})

describe('removing passphrase protection', () => {
  test('needs the passphrase, then swaps every keyslot for a new device slot', async () => {
    const { name, db, vault, time } = await deviceVault()
    await vault.protect({ passphrase: PASS })
    await writeDraft(vault, 'kept without the passphrase')
    await expect(vault.unprotect({ kind: 'passphrase', passphrase: WRONG })).rejects.toBeInstanceOf(WrongSecretError)
    expect(vault.status().protection).toBe('passphrase')
    expect(await keyslotKeys(name)).toHaveLength(2)

    await vault.unprotect({ kind: 'passphrase', passphrase: PASS })
    expect(vault.status().state).toBe('unlocked')
    expect(vault.status().protection).toBe('device')
    expect(vault.status().slots).toEqual([])
    expect(vault.status().secretKeyOnDevice).toBe(false)
    expect(await metaKeys(name)).toEqual(['device-slot', 'device-slot-key', 'fmt', 'vault'])
    // No more auto-lock.
    await time.advance(IDLE_MS * 3)
    expect(vault.status().state).toBe('unlocked')

    const again = await reopen(db, name)
    await again.vault.unlock({ kind: 'device' })
    expect(await readDraft(again.vault)).toBe('kept without the passphrase')
  })

  test('is refused for a device vault, or with another credential than the passphrase', async () => {
    const { vault } = await deviceVault()
    await expect(vault.unprotect({ kind: 'passphrase', passphrase: PASS })).rejects.toBeInstanceOf(InvalidStateError)
    const kit = await vault.protect({ passphrase: PASS })
    await expect(vault.unprotect({ kind: 'recovery', recoveryKey: kit.recoveryKey as string })).rejects.toBeInstanceOf(
      InvalidInputError,
    )
    await expect(vault.unprotect({ kind: 'device' })).rejects.toBeInstanceOf(InvalidInputError)
    expect(vault.status().protection).toBe('passphrase')
  })

  test('can be protected again, with a new kit', async () => {
    const { vault } = await deviceVault()
    const first = await vault.protect({ passphrase: PASS })
    await vault.unprotect({ kind: 'passphrase', passphrase: PASS })
    const second = await vault.protect({ passphrase: inputs.passphrases.unicode })
    expect(second.secretKey).not.toBe(first.secretKey)
    await vault.lock()
    await expect(vault.unlock({ kind: 'recovery', recoveryKey: first.recoveryKey as string })).rejects.toBeInstanceOf(
      WrongSecretError,
    )
    await vault.unlock({ kind: 'passphrase', passphrase: inputs.passphrases.unicode })
    expect(vault.status().state).toBe('unlocked')
  })
})

describe('joining a vault over a device vault', () => {
  /** A passphrase vault elsewhere and its keyslot files, as a sync store holds them. */
  async function elsewhere() {
    const remote = await page(`device-remote-${++dbCount}-${crypto.randomUUID()}`)
    const kit = await remote.vault.create({ passphrase: PASS })
    return { vault: kit.vaultId, secretKey: kit.secretKey as string, keyslots: await remote.vault.keyslotFiles() }
  }

  test('is refused unless asked to replace', async () => {
    const { vault } = await deviceVault()
    const stored = await elsewhere()
    await expect(vault.join(stored)).rejects.toBeInstanceOf(InvalidStateError)
    expect(vault.status().state).toBe('unlocked')
    expect(vault.status().protection).toBe('device')
  })

  test('replaces it: the device vault and its records are gone, the joined vault waits locked', async () => {
    const { name, vault, events } = await deviceVault()
    await writeDraft(vault, 'replaced by the joined vault')
    let cleaned = 0
    vault.onLock(() => {
      cleaned++
    })
    const stored = await elsewhere()
    await vault.join(stored, { replaceDevice: true })
    expect(cleaned).toBe(1)
    expect(vault.status().state).toBe('locked')
    expect(vault.status().protection).toBe('passphrase')
    expect(vault.status().vaultId).toBe(stored.vault)
    expect(events).toContainEqual({ type: 'locked', reason: 'forced' })
    expect(() => vault.localStore()).toThrow(LockedError)
    const keys = await metaKeys(name)
    expect(keys).not.toContain('device-slot')
    expect(keys).not.toContain('device-slot-key')
    expect((await rawEntries(name, 'local')).size).toBe(0)
    await expect(vault.unlock({ kind: 'device' })).rejects.toBeInstanceOf(InvalidStateError)
    await vault.unlock({ kind: 'passphrase', passphrase: PASS, secretKey: stored.secretKey })
    expect(vault.status().state).toBe('unlocked')
    expect(await readDraft(vault)).toBeNull()
  })

  test('replaces a device vault whose slot no longer opens', async () => {
    const { vault, db } = await deviceVault()
    await vault.lock()
    await S.createLocalMeta(db).delete('device-slot-key')
    const stored = await elsewhere()
    await vault.join(stored, { replaceDevice: true })
    expect(vault.status().protection).toBe('passphrase')
    expect(vault.status().vaultId).toBe(stored.vault)
  })

  test('never replaces a vault a passphrase protects, and a bad store changes nothing', async () => {
    const { name, vault } = await deviceVault()
    const stored = await elsewhere()
    await expect(
      vault.join(
        { vault: stored.vault, keyslots: [{ name: 'keys/x.json', bytes: new Uint8Array(3) }] },
        {
          replaceDevice: true,
        },
      ),
    ).rejects.toBeInstanceOf(CorruptError)
    expect(vault.status().state).toBe('unlocked')
    expect(await metaKeys(name)).toContain('device-slot')

    await vault.protect({ passphrase: PASS })
    await expect(vault.join(stored, { replaceDevice: true })).rejects.toBeInstanceOf(InvalidStateError)
    expect(vault.status().state).toBe('unlocked')
    expect(vault.status().vaultId).not.toBe(stored.vault)
  })

  test('another page of the device drops its keys once it reads the replacement', async () => {
    const { name, vault } = await deviceVault()
    const other = await page(name)
    await other.vault.unlock({ kind: 'device' })
    const stored = await elsewhere()
    await vault.join(stored, { replaceDevice: true })
    await other.vault.refresh()
    expect(other.vault.status().state).toBe('locked')
    expect(other.vault.status().vaultId).toBe(stored.vault)
    expect(other.vault.status().protection).toBe('passphrase')
    expect(() => other.vault.localStore()).toThrow(LockedError)
  })
})
