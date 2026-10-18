/**
 * Writes the sync fixture of aparte/1 (spec/fixtures/README.md): a real store written by the TypeScript reference, two
 * devices of one vault syncing through it, with a folder, a conversation, a reasoning part, a photo of two chunks, a
 * checkpoint and segments that have seen each other. `store/` holds every object byte for byte under its name (the
 * layout of a folder destination); `fixture.json` holds the secrets that open it and what each object must decode to.
 *
 * The fixture is frozen with the format: the script refuses to write into a directory that exists. A new fixture goes
 * into a new directory, never over an old one. Randomness is seeded (this vault protects nothing), the clock is fixed,
 * and the Argon2 parameters are the small ones of spec/vectors/inputs.json.
 *
 * Usage: bun scripts/fixtures.ts [out-dir]
 */
import 'fake-indexeddb/auto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import * as Y from 'yjs'
import type { Bytes, DocId, Rng } from '../src/core/contracts/crypto.ts'
import type { Vault } from '../src/core/contracts/vault.ts'
import type { Workspace } from '../src/core/contracts/workspace.ts'
import { base32Encode, fromUtf8, toHex } from '../src/core/crypto/bytes.ts'
import { openEnvelope } from '../src/core/crypto/envelope.ts'
import { sha256 } from '../src/core/crypto/keys.ts'
import { deviceTag, parseName } from '../src/core/crypto/names.ts'
import { seededRng } from '../src/core/crypto/rng.ts'
import { createLocalBlobs } from '../src/core/media/blobs.ts'
import { openLocalDb } from '../src/core/store/localStore.ts'
import { createSyncEngine } from '../src/core/sync/engine.ts'
import { readStoredVault } from '../src/core/sync/join.ts'
import { MemoryBucket, memoryStore } from '../src/core/sync/providers/memory.ts'
import { DOC_IDS, docTags, mirroredUpdates, openStream, streamName } from '../src/core/sync/streams.ts'
import { openVault } from '../src/core/vault/vault.ts'
import { openWorkspace } from '../src/core/workspace/workspace.ts'

export const FIXTURE_DIR = resolve(import.meta.dir, '../../spec/fixtures/sync-v1')
export const PASSPHRASE = 'fixture passphrase: Aparté, café, 日本'

const inputs = (await Bun.file(resolve(import.meta.dir, '../../spec/vectors/inputs.json')).json()) as {
  argon2: { m: number; t: number; p: number }
}

class Clock {
  t = 1_760_000_000_000
  now(): number {
    this.t += 1000
    return this.t
  }
}

/** Deterministic bytes standing for a photo. */
function photo(n: number): Bytes {
  const out = new Uint8Array(n)
  let x = 0x2545f491
  for (let i = 0; i < n; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 0xff
  }
  return out as Bytes
}

interface Device {
  readonly vault: Vault
  readonly ws: Workspace
  readonly engine: ReturnType<typeof createSyncEngine>
  readonly blobs: ReturnType<typeof createLocalBlobs>
  sync(): Promise<void>
}

async function device(name: string, rng: Rng, clock: Clock, bucket: MemoryBucket, vault: Vault): Promise<Device> {
  const store = vault.localStore()
  const subkeys = vault.subkeys()
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
    checkpointEvery: 3,
    keyslots: {
      vault: vault.status().vaultId as string,
      files: () => vault.keyslotFiles(),
      import: (files) => vault.importKeyslots(files),
    },
  })
  const remote = memoryStore(bucket, { id: `fixture-${name}` })
  engine.addDestination(remote, 'fixture')
  return {
    vault,
    ws,
    engine,
    blobs: createLocalBlobs({ objects: store.objects, subkeys, rng }),
    async sync() {
      await ws.flush()
      await engine.round(remote.id)
    },
  }
}

async function newVault(name: string, rng: Rng, clock: Clock): Promise<Vault> {
  const db = await openLocalDb({ name: `fixture-${name}` })
  return openVault({
    db,
    rng,
    clock,
    timers: { set: () => 0, clear: () => undefined },
    argon2Params: inputs.argon2,
    autoLock: { idleMs: null, graceMs: 0 },
  })
}

const newId = (rng: Rng): string => base32Encode(rng.bytes(16))

/** A document's top-level maps as JSON. */
function docJson(updates: readonly Uint8Array[], docId: DocId): unknown {
  const doc = new Y.Doc()
  for (const u of updates) Y.applyUpdateV2(doc, u)
  const maps = docId === 'index' ? ['conversations', 'folders', 'settings', 'providers'] : ['messages']
  const out = Object.fromEntries(maps.map((m) => [m, doc.getMap(m).toJSON()]))
  doc.destroy()
  return out
}

export async function generate(out: string): Promise<void> {
  if (existsSync(out)) {
    throw new Error(`fixtures: ${out} exists; a released fixture is never rewritten (write a new directory)`)
  }
  const rng = seededRng(20_261_018)
  const clock = new Clock()
  const bucket = new MemoryBucket()

  // Device A creates the vault and writes.
  const vaultA = await newVault('a', rng, clock)
  const kit = await vaultA.create({ passphrase: PASSPHRASE })
  const a = await device('a', rng, clock, bucket, vaultA)
  a.ws.settings.set('defaultSystem', 'Answer briefly.')
  a.ws.providers.create({ kind: 'anthropic', label: 'Anthropic', syncKey: false })
  const folder = a.ws.folders.create({ name: 'Fixtures' })
  const conv = a.ws.conversations.create({ title: 'First conversation', folder })
  const thread = await a.ws.thread(conv)
  const first = newId(rng)
  thread.commit({
    id: first,
    parent: null,
    role: 'user',
    parts: [{ type: 'text', text: 'Bonjour, café 日本 🙂: what is aparte/1?' }],
    model: null,
    status: 'done',
  })
  thread.setLeaf(first)
  await a.sync()
  const answer = newId(rng)
  thread.commit({
    id: answer,
    parent: first,
    role: 'assistant',
    parts: [
      {
        type: 'reasoning',
        text: 'The user asks about the format.',
        providerMeta: { anthropic: { signature: 'c2ln' } },
      },
      { type: 'text', text: 'A frozen, encrypted sync format.' },
    ],
    model: { provider: 'p', id: 'claude-opus-5-5' },
    status: 'done',
    stop: 'end',
    effort: 'medium',
    usage: { input: 12, output: 7 },
  })
  thread.setLeaf(answer)
  await a.sync()
  const image = await a.blobs.put(photo(2_097_152 + 4096), 'image/jpeg')
  const withPhoto = newId(rng)
  thread.commit({
    id: withPhoto,
    parent: answer,
    role: 'user',
    parts: [{ type: 'image', blob: image, mediaType: 'image/jpeg', width: 64, height: 48, name: 'photo.jpg' }],
    model: null,
    status: 'done',
  })
  thread.setLeaf(withPhoto)
  await a.sync()
  a.ws.conversations.update(conv, { pinned: true })
  await a.sync()

  // Device B joins from the store, reads everything, writes, and A reads it back.
  const vaultB = await newVault('b', rng, clock)
  await vaultB.join(await readStoredVault(memoryStore(bucket)))
  await vaultB.unlock({ kind: 'passphrase', passphrase: PASSPHRASE, secretKey: kit.secretKey as string })
  const b = await device('b', rng, clock, bucket, vaultB)
  await b.sync()
  b.ws.conversations.update(conv, { title: 'Renamed on the second device' })
  const fromB = newId(rng)
  const threadB = await b.ws.thread(conv)
  threadB.commit({
    id: fromB,
    parent: withPhoto,
    role: 'user',
    parts: [{ type: 'text', text: 'Written on the second device.' }],
    model: null,
    status: 'done',
  })
  threadB.setLeaf(fromB)
  await b.sync()
  await a.sync()
  a.ws.conversations.update(conv, { archived: false })
  await a.sync()

  // What every object decodes to, read back through the reference readers.
  const subkeys = vaultA.subkeys()
  const tags = await docTags(subkeys)
  const objects: unknown[] = []
  const updates = new Map<DocId, Uint8Array[]>()
  for (const name of bucket.names()) {
    const bytes = bucket.read(name) as Bytes
    const parsed = parseName(name)
    if (parsed === null) throw new Error(`fixtures: ${name} is not an aparte/1 name`)
    const entry: Record<string, unknown> = { name, type: parsed.type, sha256: toHex(await sha256(bytes)) }
    const stream = streamName(name)
    if (stream !== null) {
      const opened = await openStream(subkeys, tags, name, stream, bytes)
      entry.header = opened.header
      entry.update = toHex(await sha256(opened.update))
      const list = updates.get(opened.header.doc) ?? []
      list.push(opened.update)
      updates.set(opened.header.doc, list)
    } else if (parsed.type === 'chunk') {
      const chunk = await openEnvelope(subkeys, { kind: 3, name, bytes })
      entry.size = chunk.length
      entry.plaintext = toHex(await sha256(chunk))
    } else if (parsed.type === 'manifest') {
      entry.manifest = JSON.parse(fromUtf8(await openEnvelope(subkeys, { kind: 4, name, bytes })))
    }
    objects.push(entry)
    const path = join(out, 'store', name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
  }
  const documents: Record<string, unknown> = {}
  for (const docId of DOC_IDS) {
    const list = updates.get(docId)
    if (list) documents[docId] = docJson(list, docId)
  }
  const fixture = {
    format: 'aparte/1',
    description:
      'Two devices of one vault synced through this store by the TypeScript reference. Open a passphrase keyslot with passphrase and secretKey (Argon2 parameters as in the slot), then every object.',
    passphrase: PASSPHRASE,
    secretKey: kit.secretKey,
    recoveryKey: kit.recoveryKey,
    vault: kit.vaultId,
    devices: {
      a: await deviceTag(subkeys, (await vaultA.localStore().get('device', 'id')) as Bytes),
      b: await deviceTag(subkeys, (await vaultB.localStore().get('device', 'id')) as Bytes),
    },
    docs: Object.fromEntries([...updates.keys()].map((d) => [d, tags.byDoc.get(d)])),
    photo: { blob: image, size: 2_097_152 + 4096, sha256: toHex(await sha256(photo(2_097_152 + 4096))) },
    objects,
    documents,
  }
  await writeFile(join(out, 'fixture.json'), `${JSON.stringify(fixture, null, 2)}\n`)
  a.ws.close()
  b.ws.close()
}

if (import.meta.main) {
  const out = process.argv[2] ? resolve(process.argv[2]) : FIXTURE_DIR
  await generate(out)
  console.log(`fixtures: wrote ${out}`)
}
