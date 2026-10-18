import { describe, expect, test } from 'bun:test'
import { InvalidInputError, InvalidStateError } from '../contracts/crypto.ts'
import type { Vault } from '../contracts/vault.ts'
import { cryptoRng } from '../crypto/rng.ts'
import { openLocalDb } from '../store/localStore.ts'
import { openVault } from '../vault/vault.ts'
import { FakeClock } from '../workspace/testkit.ts'
import { openWorkspace } from '../workspace/workspace.ts'
import { createSyncEngine } from './engine.ts'
import { readStoredVault } from './join.ts'
import { MemoryBucket, memoryStore } from './providers/memory.ts'
import { mirroredUpdates } from './streams.ts'

/*
 * A second device joins a real vault (real keyslots, real Argon2 at the small vector parameters) from its sync store:
 * it reads the keyslots, unlocks with the passphrase and the Secret Key, keeps the Secret Key, and downloads the data.
 */

const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  argon2: { m: number; t: number; p: number }
}
const PASS = 'correct horse battery staple'

let n = 0
async function newVault(): Promise<{ vault: Vault; db: Awaited<ReturnType<typeof openLocalDb>> }> {
  const db = await openLocalDb({ name: `join-${++n}-${crypto.randomUUID()}` })
  const clock = new FakeClock()
  const vault = await openVault({
    db,
    rng: cryptoRng(),
    clock,
    timers: { set: () => 0, clear: () => undefined },
    argon2Params: inputs.argon2,
    autoLock: { idleMs: null, graceMs: 0 },
  })
  return { vault, db }
}

async function session(vault: Vault, db: Awaited<ReturnType<typeof openLocalDb>>, bucket: MemoryBucket) {
  const store = vault.localStore()
  const subkeys = vault.subkeys()
  const rng = cryptoRng()
  const clock = new FakeClock()
  const ws = await openWorkspace({
    store,
    subkeys,
    rng,
    clock,
    channel: null,
    lock: null,
    base: (doc) => mirroredUpdates(store.objects, subkeys, doc),
  })
  const status = vault.status()
  const engine = createSyncEngine({
    store,
    subkeys,
    workspace: ws,
    rng,
    clock,
    lock: null,
    keyslots: {
      vault: status.vaultId as string,
      files: () => vault.keyslotFiles(),
      import: (files) => vault.importKeyslots(files),
    },
  })
  const remote = memoryStore(bucket)
  engine.addDestination(remote, 'memory')
  void db
  const sync = async () => {
    await ws.flush()
    return engine.round(remote.id)
  }
  return { ws, engine, sync }
}

describe('joining a vault from its store', () => {
  test('the second device unlocks with the kit, keeps the Secret Key, and gets the data', async () => {
    const bucket = new MemoryBucket()
    const a = await newVault()
    const kit = await a.vault.create({ passphrase: PASS })
    const sa = await session(a.vault, a.db, bucket)
    const conv = sa.ws.conversations.create({ title: 'joined' })
    await sa.sync()

    const stored = await readStoredVault(memoryStore(bucket))
    expect(stored.vault).toBe(kit.vaultId)
    expect(stored.keyslots).toHaveLength(2)

    const b = await newVault()
    expect(b.vault.status().state).toBe('absent')
    await b.vault.join(stored)
    expect(b.vault.status()).toMatchObject({ state: 'locked', vaultId: kit.vaultId, secretKeyOnDevice: false })
    await expect(b.vault.unlock({ kind: 'passphrase', passphrase: PASS })).rejects.toBeInstanceOf(InvalidInputError)
    await b.vault.unlock({
      kind: 'passphrase',
      passphrase: PASS,
      secretKey: kit.secretKey as string,
      rememberSecretKey: true,
    })
    expect(b.vault.status()).toMatchObject({ state: 'unlocked', secretKeyOnDevice: true })
    const sb = await session(b.vault, b.db, bucket)
    await sb.sync()
    expect(sb.ws.conversations.get(conv)?.title).toBe('joined')

    // The Secret Key stays on this device: the next unlock needs only the passphrase.
    sb.ws.close()
    await b.vault.lock()
    await b.vault.unlock({ kind: 'passphrase', passphrase: PASS })
    expect(b.vault.status().state).toBe('unlocked')
  })

  test('a slot another device adds reaches this one through the store', async () => {
    const bucket = new MemoryBucket()
    const a = await newVault()
    const kit = await a.vault.create({ passphrase: PASS })
    const sa = await session(a.vault, a.db, bucket)
    await sa.sync()
    const b = await newVault()
    await b.vault.join(await readStoredVault(memoryStore(bucket)))
    await b.vault.unlock({ kind: 'passphrase', passphrase: PASS, secretKey: kit.secretKey as string })
    const sb = await session(b.vault, b.db, bucket)
    const added = await a.vault.addRecoveryKey({ kind: 'passphrase', passphrase: PASS })
    await sa.sync()
    await sb.sync()
    expect(b.vault.status().slots.map((s) => s.slot)).toContain(added.slot)
  })

  test('join refuses keyslots of another vault, a vault without a passphrase slot, and a device that has one', async () => {
    const bucket = new MemoryBucket()
    const a = await newVault()
    await a.vault.create({ passphrase: PASS })
    const sa = await session(a.vault, a.db, bucket)
    await sa.sync()
    const stored = await readStoredVault(memoryStore(bucket))
    const b = await newVault()
    await expect(b.vault.join({ ...stored, vault: '2'.repeat(25).concat('a') })).rejects.toBeInstanceOf(
      InvalidInputError,
    )
    const recoveryOnly = stored.keyslots.filter((f) => new TextDecoder().decode(f.bytes).includes('"kind":"recovery"'))
    await expect(b.vault.join({ ...stored, keyslots: recoveryOnly })).rejects.toBeInstanceOf(InvalidInputError)
    expect(b.vault.status().state).toBe('absent')
    await expect(a.vault.join(stored)).rejects.toBeInstanceOf(InvalidStateError)
  })

  test('a store with no vault, another format, or keyslots of two vaults is refused', async () => {
    const empty = memoryStore(new MemoryBucket())
    await expect(readStoredVault(empty)).rejects.toMatchObject({ kind: 'not-found' })
    const other = new MemoryBucket()
    other.write('fmt/1', new TextEncoder().encode('aparte/2\n'))
    await expect(readStoredVault(memoryStore(other))).rejects.toMatchObject({ kind: 'incompatible' })
    const mixed = new MemoryBucket()
    mixed.write('fmt/1', new TextEncoder().encode('aparte/1\n'))
    mixed.write(`keys/${'a'.repeat(26)}.json`, new TextEncoder().encode('{"vault":"x"}'))
    mixed.write(`keys/${'b'.repeat(25)}a.json`, new TextEncoder().encode('{"vault":"y"}'))
    await expect(readStoredVault(memoryStore(mixed))).rejects.toMatchObject({ kind: 'incompatible' })
  })
})
