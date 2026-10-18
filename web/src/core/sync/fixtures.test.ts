import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Y from 'yjs'
import type { Bytes, DocId } from '../contracts/crypto.ts'
import { base32Decode, fromUtf8, toHex } from '../crypto/bytes.ts'
import { openEnvelope } from '../crypto/envelope.ts'
import { deriveSubkeys, sha256 } from '../crypto/keys.ts'
import { openKeyslot, parseKeyslot } from '../crypto/keyslot.ts'
import { parseName } from '../crypto/names.ts'
import { parseRecoveryKey } from '../crypto/recovery.ts'
import { cryptoRng } from '../crypto/rng.ts'
import { parseSecretKey } from '../crypto/secretKey.ts'
import { createLocalBlobs } from '../media/blobs.ts'
import { openLocalDb } from '../store/localStore.ts'
import { openVault } from '../vault/vault.ts'
import { FakeClock } from '../workspace/testkit.ts'
import { openWorkspace } from '../workspace/workspace.ts'
import { createSyncEngine } from './engine.ts'
import { readStoredVault } from './join.ts'
import { MemoryBucket, memoryStore } from './providers/memory.ts'
import { DOC_IDS, docTags, mirroredUpdates, openStream, streamName } from './streams.ts'

/*
 * The frozen sync fixture of spec/fixtures/sync-v1 (written once by web/scripts/fixtures.ts) read back by this build:
 * every object opens to what fixture.json says, the documents rebuild to the recorded state, and a new device joins
 * the vault from the store and syncs it. A change that breaks this breaks every store already written.
 */

const DIR = fileURLToPath(new URL('../../../../spec/fixtures/sync-v1', import.meta.url))

interface FixtureObject {
  readonly name: string
  readonly type: string
  readonly sha256: string
  readonly header?: unknown
  readonly update?: string
  readonly size?: number
  readonly plaintext?: string
  readonly manifest?: unknown
}

const fixture = JSON.parse(readFileSync(join(DIR, 'fixture.json'), 'utf8')) as {
  readonly passphrase: string
  readonly secretKey: string
  readonly recoveryKey: string
  readonly vault: string
  readonly devices: Record<string, string>
  readonly docs: Record<string, string>
  readonly photo: { readonly blob: string; readonly size: number; readonly sha256: string }
  readonly objects: readonly FixtureObject[]
  readonly documents: Record<string, unknown>
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
}

function storeBucket(): MemoryBucket {
  const bucket = new MemoryBucket()
  const root = join(DIR, 'store')
  for (const path of files(root)) bucket.write(relative(root, path).split('\\').join('/'), readFileSync(path))
  return bucket
}

async function subkeysOf(bucket: MemoryBucket) {
  const vaultId = base32Decode(fixture.vault)
  const slots = bucket.names('keys/').map((name) => parseKeyslot(bucket.read(name) as Bytes, { name }))
  const passphrase = slots.find((s) => s.kind === 'passphrase')
  if (!passphrase) throw new Error('no passphrase slot')
  const mk = await openKeyslot(
    passphrase,
    { kind: 'passphrase', passphrase: fixture.passphrase, secretKey: await parseSecretKey(fixture.secretKey) },
    { vaultId },
  )
  const recovery = slots.find((s) => s.kind === 'recovery')
  if (!recovery) throw new Error('no recovery slot')
  const again = await openKeyslot(
    recovery,
    { kind: 'recovery', recoveryKey: parseRecoveryKey(fixture.recoveryKey) },
    { vaultId },
  )
  expect(toHex(again)).toBe(toHex(mk))
  return deriveSubkeys(mk, vaultId)
}

describe('spec/fixtures/sync-v1', () => {
  test('the store holds exactly the recorded objects, byte for byte', async () => {
    const bucket = storeBucket()
    expect(bucket.names()).toEqual(fixture.objects.map((o) => o.name).sort())
    for (const o of fixture.objects) {
      expect(toHex(await sha256(bucket.read(o.name) as Bytes)), o.name).toBe(o.sha256)
      expect(parseName(o.name)?.type, o.name).toBe(o.type as never)
    }
    expect(fromUtf8(bucket.read('fmt/1') as Bytes)).toBe('aparte/1\n')
  })

  test('both keyslots open, and every object opens to what the fixture records', async () => {
    const bucket = storeBucket()
    const subkeys = await subkeysOf(bucket)
    const tags = await docTags(subkeys)
    for (const [doc, stag] of Object.entries(fixture.docs)) expect(tags.byDoc.get(doc as DocId)).toBe(stag)
    const updates = new Map<DocId, Uint8Array[]>()
    for (const o of fixture.objects) {
      const bytes = bucket.read(o.name) as Bytes
      const stream = streamName(o.name)
      if (stream !== null) {
        const opened = await openStream(subkeys, tags, o.name, stream, bytes)
        expect(JSON.parse(JSON.stringify(opened.header)), o.name).toEqual(o.header)
        expect(toHex(await sha256(opened.update)), o.name).toBe(o.update as string)
        const list = updates.get(opened.header.doc) ?? []
        list.push(opened.update)
        updates.set(opened.header.doc, list)
      } else if (o.type === 'chunk') {
        const chunk = await openEnvelope(subkeys, { kind: 3, name: o.name, bytes })
        expect(chunk.length).toBe(o.size as number)
        expect(toHex(await sha256(chunk))).toBe(o.plaintext as string)
      } else if (o.type === 'manifest') {
        expect(JSON.parse(fromUtf8(await openEnvelope(subkeys, { kind: 4, name: o.name, bytes })))).toEqual(o.manifest)
      }
    }
    for (const docId of DOC_IDS) {
      const list = updates.get(docId)
      if (!list) continue
      const doc = new Y.Doc()
      for (const u of list) Y.applyUpdateV2(doc, u)
      const maps = docId === 'index' ? ['conversations', 'folders', 'settings', 'providers'] : ['messages']
      const json: unknown = Object.fromEntries(maps.map((m) => [m, doc.getMap(m).toJSON()]))
      expect(json).toEqual(fixture.documents[docId])
      doc.destroy()
    }
    // Two devices wrote, and each one's segments name what it had seen of the other.
    const seen = fixture.objects.flatMap((o) => Object.keys((o.header as { seen?: object } | undefined)?.seen ?? {}))
    expect(new Set(seen)).toEqual(new Set(Object.values(fixture.devices)))
  })

  test('a new device joins the vault from the store and syncs it, photo included', async () => {
    const bucket = storeBucket()
    const db = await openLocalDb({ name: `fixture-read-${crypto.randomUUID()}` })
    const clock = new FakeClock()
    const vault = await openVault({
      db,
      rng: cryptoRng(),
      clock,
      timers: { set: () => 0, clear: () => undefined },
      autoLock: { idleMs: null, graceMs: 0 },
    })
    await vault.join(await readStoredVault(memoryStore(bucket)))
    await vault.unlock({ kind: 'passphrase', passphrase: fixture.passphrase, secretKey: fixture.secretKey })
    const store = vault.localStore()
    const subkeys = vault.subkeys()
    const rng = cryptoRng()
    const ws = await openWorkspace({
      store,
      subkeys,
      rng,
      clock,
      channel: null,
      lock: null,
      base: (doc) => mirroredUpdates(store.objects, subkeys, doc),
    })
    const engine = createSyncEngine({
      store,
      subkeys,
      workspace: ws,
      rng,
      clock,
      lock: null,
      keyslots: {
        vault: fixture.vault,
        files: () => vault.keyslotFiles(),
        import: (f) => vault.importKeyslots(f),
      },
    })
    // The bucket is an in-memory copy of the files: whatever the round writes never reaches the fixture.
    const remote = memoryStore(bucket, { id: 'fixture' })
    engine.addDestination(remote, 'fixture')
    await engine.round(remote.id)
    const [conv] = ws.conversations.list()
    expect(conv?.title).toBe('Renamed on the second device')
    const thread = await ws.thread(conv?.id as string)
    expect(thread.path().map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user'])
    const blobs = createLocalBlobs({ objects: store.objects, subkeys, rng })
    const bytes = await blobs.get(fixture.photo.blob)
    expect(bytes?.length).toBe(fixture.photo.size)
    expect(toHex(await sha256(bytes as Bytes))).toBe(fixture.photo.sha256)
    expect(engine.status().alarms).toEqual([])
    ws.close()
  })
})
