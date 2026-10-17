/*
 * Adversarial review of the vault over fake-indexeddb: what happens when two pages (two tabs, or the installed app
 * and a tab) open the same device database, and when the device-wrapped Secret Key cannot be unwrapped.
 *
 * Each test states the behaviour the vault should have; a failure here is a defect, not a flaky test.
 */
import { describe, expect, test } from 'bun:test'
import { InvalidStateError } from '../contracts/crypto.ts'
import type { Clock, Timers } from '../contracts/vault.ts'
import { cryptoRng } from '../crypto/rng.ts'
import { createLocalMeta, openLocalDb } from '../store/localStore.ts'
import { openVault } from './vault.ts'

const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  argon2: { m: number; t: number; p: number }
  passphrases: { ascii: string; unicode: string; unicodeEquivalent: string; wrong: string }
}
const PASS = inputs.passphrases.ascii
const NEXT = inputs.passphrases.unicode
const OTHER = 'a completely different passphrase typed in the second tab'

/** Timers that never fire: these tests do not exercise the auto-lock. */
const clock: Clock = { now: () => 1_760_000_000_000 }
const timers: Timers = { set: () => 0, clear: () => undefined }

/** One page of the app: its own connection to the shared device database and its own Vault, as vault.tsx makes. */
async function page(name: string) {
  const db = await openLocalDb({ name })
  const vault = await openVault({ db, rng: cryptoRng(), clock, timers, argon2Params: inputs.argon2 })
  return { db, vault }
}

const dbName = () => `review-vault-${crypto.randomUUID()}`

describe('two pages on one device database', () => {
  test('a page loaded before the vault existed cannot create a second vault over it', async () => {
    const name = dbName()
    const a = await page(name)
    const b = await page(name)
    expect(a.vault.status().state).toBe('absent')
    expect(b.vault.status().state).toBe('absent')

    const kit = await a.vault.create({ passphrase: PASS })
    await a.vault.localStore().put('draft', 'note', new Uint8Array([1, 2, 3]))
    await a.vault.lock()

    // Page B still shows the onboarding (its status was read at load). Creating there must be refused, since the
    // device now holds a vault: it would otherwise erase that vault's keyslots, recovery slot included.
    await expect(b.vault.create({ passphrase: OTHER })).rejects.toBeInstanceOf(InvalidStateError)

    // And the first vault must still open with its own passphrase and its own recovery key.
    const reopened = await page(name)
    expect(reopened.vault.status().vaultId).toBe(kit.vaultId)
    await reopened.vault.unlock({ kind: 'passphrase', passphrase: PASS })
    expect(await reopened.vault.localStore().get('draft', 'note')).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('creating in a stale page leaves the existing vault openable', async () => {
    const name = dbName()
    const a = await page(name)
    const b = await page(name)
    const kit = await a.vault.create({ passphrase: PASS })
    await a.vault.lock()
    // Whatever page B does, the vault that already exists must survive it.
    await b.vault.create({ passphrase: OTHER }).catch(() => undefined)

    const reopened = await page(name)
    expect(reopened.vault.status().vaultId).toBe(kit.vaultId)
    // Its recovery key must still open it.
    await reopened.vault.unlock({ kind: 'recovery', recoveryKey: kit.recoveryKey as string })
    expect(reopened.vault.status().state).toBe('unlocked')
  })

  test('a passphrase set by recovery in one page opens the vault in another page', async () => {
    const name = dbName()
    const a = await page(name)
    const created = await a.vault.create({ passphrase: PASS })
    await a.vault.lock()

    const b = await page(name)
    const other = await page(name)
    expect(b.vault.status().state).toBe('locked')
    expect(other.vault.status().state).toBe('locked')

    // The user recovers in page B and picks a new passphrase.
    await b.vault.recover({ recoveryKey: created.recoveryKey as string, next: NEXT })
    expect(b.vault.status().state).toBe('unlocked')

    // The other page (another tab, or the installed app) is still on its lock screen: the new passphrase must work
    // there too, or the user is told "This passphrase does not open the vault" right after a successful recovery.
    await other.vault.unlock({ kind: 'passphrase', passphrase: NEXT })
    expect(other.vault.status().state).toBe('unlocked')
  })
})

describe('the device-wrapped Secret Key', () => {
  test('the recovery key still recovers when the stored Secret Key cannot be unwrapped', async () => {
    const name = dbName()
    const a = await page(name)
    const kit = await a.vault.create({ passphrase: PASS })
    await a.vault.lock()

    // `secret-key` no longer unwraps under `device-key`: a browser that restored one entry and not the other, or
    // any page of the shared origin (spec/FORMAT.md section 14) overwriting it. 44 bytes passes the length check.
    const meta = createLocalMeta(a.db)
    await meta.put('secret-key', crypto.getRandomValues(new Uint8Array(44)))

    const b = await page(name)
    expect(b.vault.status().state).toBe('locked')
    // The recovery slot needs only the recovery key (spec/FORMAT.md section 6.4): it must not depend on the
    // device-wrapped Secret Key. Today recover() unwraps it first and fails with `tampered`, so the Emergency Kit
    // cannot get the user back in.
    await b.vault.recover({ recoveryKey: kit.recoveryKey as string, next: NEXT })
    expect(b.vault.status().state).toBe('unlocked')
  })
})
