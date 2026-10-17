/*
 * Rules of the vault beyond the contract tests: what creation leaves in IndexedDB (no secret in readable form), the
 * device record, recovery on a device that does not remember the Secret Key, and locking during an unlock.
 */
import { describe, expect, test } from 'bun:test'
import {
  type BytesModule,
  InvalidInputError,
  InvalidStateError,
  LockedError,
  type RngModule,
  type SecretKeyModule,
  WrongSecretError,
} from '../contracts/crypto.ts'
import type { LocalStoreModule } from '../contracts/store.ts'
import type { Clock, Timers, VaultModule } from '../contracts/vault.ts'
import * as bytesImpl from '../crypto/bytes.ts'
import * as rngImpl from '../crypto/rng.ts'
import * as secretKeyImpl from '../crypto/secretKey.ts'
import * as storeImpl from '../store/localStore.ts'
import * as vaultImpl from './vault.ts'

const B: BytesModule = bytesImpl
const R: RngModule = rngImpl
const SK: SecretKeyModule = secretKeyImpl
const S: LocalStoreModule = storeImpl
const V: VaultModule = vaultImpl

const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  argon2: { m: number; t: number; p: number }
  passphrases: { ascii: string; unicode: string }
}
const PASS = inputs.passphrases.ascii
const NEXT = inputs.passphrases.unicode

/** Time that never moves: these tests do not exercise the auto-lock. */
const still: Clock & Timers = { now: () => 0, set: () => 0, clear: () => undefined }

let count = 0
async function setup(name = `vault-rules-${++count}-${crypto.randomUUID()}`) {
  const db = await S.openLocalDb({ name })
  const vault = await V.openVault({
    db,
    rng: R.cryptoRng(),
    clock: still,
    timers: still,
    argon2Params: inputs.argon2,
    autoLock: { idleMs: null, graceMs: 0 },
  })
  return { name, db, vault }
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function dump(name: string): Promise<{ store: string; key: string; value: unknown }[]> {
  const db = await request(indexedDB.open(name))
  const rows: { store: string; key: string; value: unknown }[] = []
  for (const store of [...db.objectStoreNames]) {
    const os = db.transaction(store, 'readonly').objectStore(store)
    const keys = await request(os.getAllKeys())
    const values = await request(os.getAll())
    keys.forEach((key, i) => {
      rows.push({ store, key: String(key), value: values[i] })
    })
  }
  db.close()
  return rows
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

describe('what creation stores', () => {
  test('the marker, the vault id, keyslots, the device key, the wrapped Secret Key and one device record', async () => {
    const { name, vault } = await setup()
    const kit = await vault.create({ passphrase: PASS })
    const rows = await dump(name)
    const meta = rows.filter((r) => r.store === 'meta').map((r) => r.key)
    expect(meta.sort()).toEqual(
      ['device-key', 'fmt', 'secret-key', 'vault', ...vault.status().slots.map((s) => `keyslot:${s.slot}`)].sort(),
    )
    expect(rows.find((r) => r.key === 'fmt')?.value).toBe('aparte/1\n')
    expect(rows.find((r) => r.key === 'vault')?.value).toBe(kit.vaultId)
    expect((rows.find((r) => r.key === 'secret-key')?.value as Uint8Array | undefined)?.length).toBe(44)
    expect((rows.find((r) => r.key === 'device-key')?.value as CryptoKey | undefined)?.extractable).toBe(false)
    expect(rows.filter((r) => r.store === 'local')).toHaveLength(1)
    expect(rows.filter((r) => r.store === 'objects' || r.store === 'pending')).toEqual([])
  })

  test('neither the passphrase, the Secret Key nor the recovery key appears anywhere', async () => {
    const { name, vault } = await setup()
    const kit = await vault.create({ passphrase: PASS })
    const sk = await SK.parseSecretKey(kit.secretKey as string)
    const texts = [PASS, kit.secretKey as string, kit.recoveryKey as string, B.toHex(sk), B.base64urlEncode(sk)]
    for (const row of await dump(name)) {
      for (const text of texts) expect(row.key.includes(text)).toBe(false)
      if (typeof row.value === 'string') for (const text of texts) expect(row.value.includes(text)).toBe(false)
      if (row.value instanceof Uint8Array) {
        expect(contains(row.value, sk)).toBe(false)
        expect(contains(row.value, B.utf8(PASS))).toBe(false)
      }
    }
  })

  test('a passphrase-only vault keeps no Secret Key and no device key', async () => {
    const { name, vault } = await setup()
    await vault.create({ passphrase: PASS, secretKey: false })
    const keys = (await dump(name)).filter((r) => r.store === 'meta').map((r) => r.key)
    expect(keys).not.toContain('secret-key')
    expect(keys).not.toContain('device-key')
    expect(vault.status().secretKeyOnDevice).toBe(false)
    expect(await vault.secretKeyText()).toBeNull()
  })
})

describe('recovery on a device without the Secret Key', () => {
  test('generates a new Secret Key for the new slot, which this device then remembers', async () => {
    const { vault } = await setup()
    const kit = await vault.create({ passphrase: PASS, rememberSecretKey: false })
    await vault.lock()
    const { added, secretKey } = await vault.recover({ recoveryKey: kit.recoveryKey as string, next: NEXT })
    expect(secretKey).toMatch(/^A1(-[A-Z2-7]{5}){6}$/)
    expect(secretKey).not.toBe(kit.secretKey)
    expect(vault.status().slots.find((s) => s.slot === added)).toMatchObject({ kind: 'passphrase', secretKey: true })
    expect(await vault.secretKeyText()).toBe(secretKey)
    await vault.lock()
    await vault.unlock({ kind: 'passphrase', passphrase: NEXT })
    // The first slot still needs the first Secret Key, which the user types.
    await vault.lock()
    await vault.unlock({ kind: 'passphrase', passphrase: PASS, secretKey: kit.secretKey as string })
    expect(vault.status().state).toBe('unlocked')
  })

  test('an empty new passphrase is refused before anything changes', async () => {
    const { vault } = await setup()
    const kit = await vault.create({ passphrase: PASS })
    await vault.lock()
    const before = vault.status().slots
    await expect(vault.recover({ recoveryKey: kit.recoveryKey as string, next: '' })).rejects.toBeInstanceOf(
      InvalidInputError,
    )
    expect(vault.status().state).toBe('locked')
    expect(vault.status().slots).toEqual(before)
  })
})

describe('locking while unlocking', () => {
  test('the unlock ends locked, without keys', async () => {
    const { vault } = await setup()
    await vault.create({ passphrase: PASS })
    await vault.lock()
    const unlocking = vault.unlock({ kind: 'passphrase', passphrase: PASS })
    expect(vault.status().state).toBe('unlocking')
    const locking = vault.lock()
    await expect(unlocking).rejects.toBeInstanceOf(LockedError)
    await locking
    expect(vault.status().state).toBe('locked')
    expect(() => vault.subkeys()).toThrow(LockedError)
  })
})

describe('slots', () => {
  test('a recovery slot can be removed while a passphrase slot remains, and is gone after reopening', async () => {
    const first = await setup()
    await first.vault.create({ passphrase: PASS })
    const recovery = first.vault.status().slots.find((s) => s.kind === 'recovery')?.slot as string
    await first.vault.removeSlot(recovery)
    await first.vault.lock()
    const again = await setup(first.name)
    expect(again.vault.status().slots.map((s) => s.kind)).toEqual(['passphrase'])
    await expect(again.vault.removeSlot('aaaaaaaaaaaaaaaaaaaaaaaaaa')).rejects.toBeInstanceOf(LockedError)
  })
})

describe('several pages, one device', () => {
  test('refresh shows a vault another page created as locked', async () => {
    const first = await setup()
    const second = await setup(first.name)
    await first.vault.create({ passphrase: PASS })
    expect(second.vault.status().state).toBe('absent')
    await second.vault.refresh()
    expect(second.vault.status()).toMatchObject({ state: 'locked', vaultId: first.vault.status().vaultId })
    await second.vault.unlock({ kind: 'passphrase', passphrase: PASS })
    expect(second.vault.status().state).toBe('unlocked')
  })

  test('a refused creation leaves the page locked on the existing vault', async () => {
    const first = await setup()
    const second = await setup(first.name)
    const kit = await first.vault.create({ passphrase: PASS })
    await expect(second.vault.create({ passphrase: NEXT })).rejects.toBeInstanceOf(InvalidStateError)
    expect(second.vault.status()).toMatchObject({ state: 'locked', vaultId: kit.vaultId })
  })
})

describe('recovery that replaces the passphrase', () => {
  test('the previous passphrase stops opening the vault', async () => {
    const { vault } = await setup()
    const kit = await vault.create({ passphrase: PASS })
    await vault.lock()
    const { added } = await vault.recover({ recoveryKey: kit.recoveryKey as string, next: NEXT, replace: true })
    const passphraseSlots = vault.status().slots.filter((s) => s.kind === 'passphrase')
    expect(passphraseSlots.map((s) => s.slot)).toEqual([added])
    expect(vault.status().slots.filter((s) => s.kind === 'recovery')).toHaveLength(1)
    await vault.lock()
    await expect(vault.unlock({ kind: 'passphrase', passphrase: PASS })).rejects.toBeInstanceOf(WrongSecretError)
    await vault.unlock({ kind: 'passphrase', passphrase: NEXT })
    expect(vault.status().state).toBe('unlocked')
  })
})

describe('renewing an Emergency Kit never confirmed', () => {
  test('unlocks, and a new recovery key replaces the previous one', async () => {
    const { vault } = await setup()
    const kit = await vault.create({ passphrase: PASS })
    await vault.lock()
    const renewed = await vault.unlockAndRenewKit({ kind: 'passphrase', passphrase: PASS })
    expect(vault.status().state).toBe('unlocked')
    expect(renewed.secretKey).toBe(kit.secretKey)
    expect(renewed.recoveryKey).not.toBe(kit.recoveryKey)
    expect(vault.status().slots.filter((s) => s.kind === 'recovery')).toHaveLength(1)
    await vault.lock()
    await expect(vault.unlock({ kind: 'recovery', recoveryKey: kit.recoveryKey as string })).rejects.toBeInstanceOf(
      WrongSecretError,
    )
    await vault.unlock({ kind: 'recovery', recoveryKey: renewed.recoveryKey })
    expect(vault.status().state).toBe('unlocked')
  })

  test('a wrong passphrase changes nothing', async () => {
    const { vault } = await setup()
    await vault.create({ passphrase: PASS })
    await vault.lock()
    const before = vault.status().slots
    await expect(vault.unlockAndRenewKit({ kind: 'passphrase', passphrase: NEXT })).rejects.toBeInstanceOf(
      WrongSecretError,
    )
    expect(vault.status().state).toBe('locked')
    expect(vault.status().slots).toEqual(before)
  })
})

describe('a stored Secret Key that no longer unwraps', () => {
  test('unlocking asks for the Secret Key, and the one typed in is stored again', async () => {
    const { name, db, vault } = await setup()
    const kit = await vault.create({ passphrase: PASS })
    await vault.lock()
    await S.createLocalMeta(db).put('secret-key', crypto.getRandomValues(new Uint8Array(44)))
    const again = (await setup(name)).vault
    expect(again.status().secretKeyOnDevice).toBe(true)
    await expect(again.unlock({ kind: 'passphrase', passphrase: PASS })).rejects.toBeInstanceOf(InvalidInputError)
    expect(again.status()).toMatchObject({ state: 'locked', secretKeyOnDevice: false })

    await again.unlock({ kind: 'passphrase', passphrase: PASS, secretKey: kit.secretKey as string })
    expect(again.status().secretKeyOnDevice).toBe(true)
    expect(await again.secretKeyText()).toBe(kit.secretKey)
    await again.lock()
    await again.unlock({ kind: 'passphrase', passphrase: PASS })
    expect(again.status().state).toBe('unlocked')
  })

  test('recovery pairs the new passphrase with a new Secret Key', async () => {
    const { name, db, vault } = await setup()
    const kit = await vault.create({ passphrase: PASS })
    await vault.lock()
    await S.createLocalMeta(db).put('secret-key', crypto.getRandomValues(new Uint8Array(44)))
    const again = (await setup(name)).vault
    const { secretKey } = await again.recover({ recoveryKey: kit.recoveryKey as string, next: NEXT })
    expect(secretKey).toMatch(/^A1(-[A-Z2-7]{5}){6}$/)
    expect(secretKey).not.toBe(kit.secretKey)
    expect(again.status().secretKeyOnDevice).toBe(true)
    await again.lock()
    await again.unlock({ kind: 'passphrase', passphrase: NEXT })
    expect(again.status().state).toBe('unlocked')
  })
})
