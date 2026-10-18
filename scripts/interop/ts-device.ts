/**
 * A device of the TypeScript reference (web/src/core), driven from the command line for the mixed end-to-end check
 * of scripts/check-interop.sh. It reads a sync store as the web app's GitHub store lays it out (a Git checkout: base64
 * files under `aparte/`), joins the vault as a new device, syncs, and prints what it sees as JSON; `write` also adds a
 * message and writes the objects it sealed into a folder (folder layout), for the CLI to push.
 *
 * Usage:
 *   bun scripts/interop/ts-device.ts read  <checkout> <passphrase> <secret-key>
 *   bun scripts/interop/ts-device.ts write <checkout> <passphrase> <secret-key> <text> <out-dir>
 *
 * Nothing under web/ is written: the store is copied into memory first.
 */
import '../../web/node_modules/fake-indexeddb/auto/index.mjs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { base32Encode, toHex } from '../../web/src/core/crypto/bytes.ts'
import { sha256 } from '../../web/src/core/crypto/keys.ts'
import { cryptoRng } from '../../web/src/core/crypto/rng.ts'
import { createLocalBlobs } from '../../web/src/core/media/blobs.ts'
import { openLocalDb } from '../../web/src/core/store/localStore.ts'
import { createSyncEngine } from '../../web/src/core/sync/engine.ts'
import { readStoredVault } from '../../web/src/core/sync/join.ts'
import { fromBase64 } from '../../web/src/core/sync/providers/github.ts'
import { MemoryBucket, memoryStore } from '../../web/src/core/sync/providers/memory.ts'
import { mirroredUpdates } from '../../web/src/core/sync/streams.ts'
import { openVault } from '../../web/src/core/vault/vault.ts'
import { openWorkspace } from '../../web/src/core/workspace/workspace.ts'

const [mode, checkout, passphrase, secretKey, text, outDir] = process.argv.slice(2)
if ((mode !== 'read' && mode !== 'write') || !checkout || !passphrase || !secretKey) {
  console.error('usage: ts-device.ts read|write <checkout> <passphrase> <secret-key> [<text> <out-dir>]')
  process.exit(2)
}

async function files(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir)) {
    const path = join(dir, entry)
    if ((await stat(path)).isDirectory()) out.push(...(await files(path)))
    else out.push(path)
  }
  return out
}

/** The objects of a checkout in the GitHub store layout: `aparte/<name>`, each file the base64 of the object. */
const bucket = new MemoryBucket()
const root = join(checkout, 'aparte')
for (const path of await files(root)) {
  const name = relative(root, path).split('\\').join('/')
  if (name === 'README.md') continue
  bucket.write(name, fromBase64((await readFile(path, 'utf8')).trim()))
}
const before = new Set(bucket.names())

const clock = { now: () => Date.now() }
const rng = cryptoRng()
const db = await openLocalDb({ name: `interop-${crypto.randomUUID()}` })
const vault = await openVault({
  db,
  rng,
  clock,
  timers: { set: () => 0, clear: () => undefined },
  autoLock: { idleMs: null, graceMs: 0 },
})
const remote = memoryStore(bucket, { id: 'interop' })
await vault.join(await readStoredVault(remote))
await vault.unlock({ kind: 'passphrase', passphrase, secretKey })
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
const keyslots = { vault: vault.status().vaultId as string, files: () => vault.keyslotFiles(), import: (f: Parameters<typeof vault.importKeyslots>[0]) => vault.importKeyslots(f) }
const engine = createSyncEngine({ store, subkeys, workspace: ws, rng, clock, lock: null, keyslots })
engine.addDestination(remote, 'interop')
await engine.round(remote.id)

if (mode === 'write') {
  if (!text || !outDir) throw new Error('write needs a text and an out-dir')
  const [conv] = ws.conversations.list()
  if (!conv) throw new Error('no conversation to answer')
  const thread = await ws.thread(conv.id)
  const id = base32Encode(rng.bytes(16))
  thread.commit({ id, parent: conv.leaf, role: 'user', parts: [{ type: 'text', text }], model: null, status: 'done' })
  thread.setLeaf(id, { ifLeaf: conv.leaf })
  await ws.flush()
  await engine.round(remote.id)
  for (const name of bucket.names()) {
    if (before.has(name)) continue
    const path = join(outDir, ...name.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bucket.read(name) as Uint8Array)
  }
}

const blobs = createLocalBlobs({ objects: store.objects, subkeys, rng })
const conversations = []
for (const conv of ws.conversations.list()) {
  const thread = await ws.thread(conv.id)
  const path = []
  for (const m of thread.path()) {
    const parts = []
    for (const p of m.parts) {
      if (p.type === 'image' || p.type === 'file') {
        const bytes = await blobs.get(p.blob)
        parts.push({ ...p, bytes: bytes?.length ?? null, sha256: bytes ? toHex(await sha256(bytes)) : null })
      } else parts.push(p)
    }
    path.push({ id: m.id, role: m.role, status: m.status, model: m.model, usage: m.usage ?? null, stop: m.stop ?? null, parts })
  }
  conversations.push({ id: conv.id, title: conv.title, system: conv.system, leaf: conv.leaf, path })
}
console.log(JSON.stringify({ alarms: engine.status().alarms, conversations }))
ws.close()
