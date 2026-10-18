/*
 * Shared setup of the sync tests (imported only by *.test.ts files): devices of one vault, each with its own
 * fake-indexeddb database, workspace, device id and engine, around one shared MemoryBucket.
 */

import * as Y from 'yjs'
import type { Bytes, Rng } from '../contracts/crypto.ts'
import type { LocalDb, LocalStore } from '../contracts/store.ts'
import type { RemoteStore } from '../contracts/sync.ts'
import type { KeyslotFile } from '../contracts/vault.ts'
import type { Workspace } from '../contracts/workspace.ts'
import { base32Encode, utf8 } from '../crypto/bytes.ts'
import { cryptoRng } from '../crypto/rng.ts'
import { createLocalBlobs, type LocalBlobs } from '../media/blobs.ts'
import { createLocalStore, openLocalDb } from '../store/localStore.ts'
import { FakeClock, testSubkeys } from '../workspace/testkit.ts'
import { openWorkspace } from '../workspace/workspace.ts'
import { createSyncEngine, type KeyslotPort, type SyncEngineDeps, type SyncEngineImpl } from './engine.ts'
import { type MemoryBucket, type MemoryStore, memoryStore } from './providers/memory.ts'
import { mirroredUpdates } from './streams.ts'

export const VAULT = '6dy7f47u6x3pp6hz7l57z7p674'

/** A keyslot port over an in-memory list: enough for the engine, which only reads `vault` from a remote file. */
export function fakeKeyslots(
  vault = VAULT,
  slots: readonly string[] = ['a'.repeat(26)],
): KeyslotPort & {
  readonly all: KeyslotFile[]
} {
  const all: KeyslotFile[] = slots.map((slot) => ({
    name: `keys/${slot}.json`,
    bytes: utf8(`{"vault":"${vault}","slot":"${slot}"}\n`) as Bytes,
  }))
  return {
    vault,
    all,
    async files() {
      return [...all]
    },
    async import(files) {
      const added: string[] = []
      for (const f of files) {
        if (all.some((x) => x.name === f.name)) continue
        all.push(f)
        added.push(f.name.slice(5, 31))
      }
      return added
    },
  }
}

let count = 0

export interface Device {
  readonly name: string
  readonly db: LocalDb
  readonly store: LocalStore
  ws: Workspace
  readonly engine: SyncEngineImpl
  readonly remote: MemoryStore
  readonly blobs: LocalBlobs
  readonly keyslots: ReturnType<typeof fakeKeyslots>
  /** Closes the workspace and opens it again from the device's storage (a reload). */
  reload(): Promise<void>
  sync(): Promise<{ down: number; up: number; deferred: number }>
}

export async function device(
  bucket: MemoryBucket,
  options: {
    readonly clock?: FakeClock
    readonly remote?: (inner: MemoryStore) => RemoteStore
    readonly deviceId?: Uint8Array
    readonly engine?: Partial<SyncEngineDeps>
    readonly rng?: Rng
    readonly keyslots?: ReturnType<typeof fakeKeyslots>
  } = {},
): Promise<Device> {
  const name = `sync-${++count}-${crypto.randomUUID()}`
  const db = await openLocalDb({ name })
  const subkeys = await testSubkeys()
  const rng = options.rng ?? cryptoRng()
  const store = createLocalStore({ db, subkeys, rng })
  await store.put('device', 'id', options.deviceId ?? rng.bytes(16))
  const clock = options.clock ?? new FakeClock()
  const open = () =>
    openWorkspace({
      store,
      subkeys,
      rng,
      clock,
      channel: null,
      lock: null,
      base: (docId) => mirroredUpdates(store.objects, subkeys, docId),
    })
  const raw = memoryStore(bucket, { id: 'memory' })
  const remote = options.remote ? options.remote(raw) : raw
  const keyslots = options.keyslots ?? fakeKeyslots()
  const self: Device = {
    name,
    db,
    store,
    ws: await open(),
    engine: undefined as unknown as SyncEngineImpl,
    remote: raw,
    blobs: createLocalBlobs({ objects: store.objects, subkeys, rng }),
    keyslots,
    async reload() {
      await self.ws.flush()
      self.ws.close()
      self.ws = await open()
    },
    async sync() {
      await self.ws.flush()
      return self.engine.round(remote.id)
    },
  }
  ;(self as { engine: SyncEngineImpl }).engine = createSyncEngine({
    store,
    subkeys,
    // The engine always reaches the device's current workspace, across reloads.
    workspace: {
      applyRemote: (doc, update) => self.ws.applyRemote(doc, update),
      state: (doc) => self.ws.state(doc),
      isLoaded: (doc) => self.ws.isLoaded(doc),
    },
    keyslots,
    rng,
    clock,
    lock: null,
    ...options.engine,
  })
  self.engine.addDestination(remote, 'memory')
  return self
}

/** The index document's maps as JSON, to compare two devices. */
export async function indexJson(ws: Workspace): Promise<unknown> {
  const doc = new Y.Doc()
  Y.applyUpdateV2(doc, await ws.state('index'))
  const out = { conversations: doc.getMap('conversations').toJSON(), folders: doc.getMap('folders').toJSON() }
  doc.destroy()
  return out
}

/** A shard's messages as JSON. */
export async function shardJson(ws: Workspace, shard: Parameters<Workspace['state']>[0]): Promise<unknown> {
  const doc = new Y.Doc()
  Y.applyUpdateV2(doc, await ws.state(shard))
  const out = doc.getMap('messages').toJSON()
  doc.destroy()
  return out
}

export const newId = (): string => base32Encode(cryptoRng().bytes(16))

/** Deterministic bytes, `n` of them, for photos and other blobs. */
export function noise(n: number, seed: number): Bytes {
  const out = new Uint8Array(n)
  let x = seed >>> 0 || 1
  for (let i = 0; i < n; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 0xff
  }
  return out as Bytes
}
