/*
 * The sync engine (contract: web/src/core/contracts/sync.ts), ported from the cursus engine onto the aparte/1 store of
 * spec/FORMAT.md: immutable segments per (document, device), checkpoints, content-addressed blobs, keyslots, and the
 * anti-rollback rules of section 10.3.
 *
 * A round with one destination:
 * 1. seals the pending queue of every document into one segment each (persisted in the object mirror first);
 * 2. lists the destination completely and checks it: format marker, another vault, keyslots, forks, rollback, gaps
 *    and unreturned claims;
 * 3. downloads what this device lacks (blobs first, then checkpoints for documents it has nothing of, then segments),
 *    authenticates every object against its name, stores it in the mirror and applies it to the loaded documents;
 * 4. writes a checkpoint for a loaded document with many segments since the last one;
 * 5. uploads, in the order of section 10.2, everything the mirror holds that the destination does not list.
 *
 * Invariants:
 * - Nothing is ever deleted locally because a store stopped returning it; an alarm is raised instead.
 * - An object enters the mirror only once it authenticated under its name (the mirror is the outbox and what the
 *   workspace replays at load), and only the format marker and keyslots go out in clear.
 * - Rounds are serialized on this device across pages (lock `aparte-sync`), and the sync state is read afresh at the
 *   start of each one. A round holds the vault lock, so an auto-lock never cuts a write in half.
 */

import {
  AparteError,
  type Bytes,
  type DocId,
  InvalidStateError,
  LockedError,
  type Rng,
  type Subkeys,
} from '../contracts/crypto.ts'
import type { LocalStore } from '../contracts/store.ts'
import {
  type DestState,
  type DestStatus,
  type RemoteEntry,
  RemoteError,
  type RemoteStore,
  type RoundResult,
  type SyncAlarm,
  type SyncEngine,
  type SyncStatus,
} from '../contracts/sync.ts'
import type { Clock, KeyslotFile } from '../contracts/vault.ts'
import type { Workspace } from '../contracts/workspace.ts'
import { equal, fromUtf8, utf8 } from '../crypto/bytes.ts'
import { openEnvelope, sealEnvelope } from '../crypto/envelope.ts'
import {
  checkpointName,
  chunkId,
  chunkName,
  deviceTag,
  manifestId,
  manifestName,
  parseName,
  segmentName,
} from '../crypto/names.ts'
import { encodeStreamPayload, type SeqMap, type StreamHeader } from './framing.ts'
import { type DestRecord, destRecord, getSeq, loadState, raiseSeq, type SyncState, saveState } from './state.ts'
import { DOC_IDS, type DocTags, docTags, openStream, type StreamName, streamName } from './streams.ts'
import { blobRefs, mergeUpdates } from './updates.ts'

export const FMT_NAME = 'fmt/1'
export const FMT_BYTES = utf8('aparte/1\n')
/** Segments since the last checkpoint that make a loaded document worth a new one. */
export const CHECKPOINT_EVERY = 256
/** How long a gap or an unreturned claim must persist across listings before it raises an alarm (section 10.3). */
export const WITHHOLD_MS = 10 * 60_000
/** Failed validations after which an object is no longer fetched. */
export const MAX_BAD = 3
const CONCURRENCY = 6
/** Gaps watched per (document, device): a hostile listing cannot make the state grow without bound. */
const MAX_GAPS = 64
const KEYSLOT = /^keys\/([a-z2-7]{26})\.json$/

export interface KeyslotPort {
  /** base32 vaultId of the unlocked vault. */
  readonly vault: string
  /** This device's keyslot files. */
  files(): Promise<readonly KeyslotFile[]>
  /** Adds keyslots another device created; returns the slots added (see Vault.importKeyslots). */
  import(files: readonly KeyslotFile[]): Promise<readonly string[]>
}

export type SyncWorkspace = Pick<Workspace, 'applyRemote' | 'state' | 'isLoaded'>

export type LockFn = <T>(name: string, fn: () => Promise<T>) => Promise<T>

export interface SyncEngineDeps {
  readonly store: LocalStore
  readonly subkeys: Subkeys
  readonly workspace: SyncWorkspace
  readonly keyslots: KeyslotPort
  readonly rng: Rng
  readonly clock: Clock
  /**
   * Exclusive lock shared by the pages of the device: `aparte-pending:<doc>` (the workspace queue's) and
   * `aparte-sync` (rounds). Null runs directly (tests, one page).
   */
  readonly lock?: LockFn | null
  /** Holds the vault lock while a round runs; returns the release. Absent: nothing is held. */
  readonly hold?: (reason: string) => () => void
  readonly checkpointEvery?: number
  readonly withholdMs?: number
  readonly concurrency?: number
  /** Called after a round stored blob objects (photos that can now show). */
  readonly onBlobs?: () => void
}

export interface SyncEngineImpl extends SyncEngine {
  /** Seals every document's pending queue into segments now; returns the number of segments written. */
  seal(): Promise<number>
  /** The device tag this device writes under (after any fork rotation). */
  deviceTag(): Promise<string>
}

interface Dest {
  readonly store: RemoteStore
  readonly transient: boolean
  status: DestStatus
}

interface Me {
  readonly id: Bytes
  readonly dtag: string
}

/** What the mirror holds, indexed once per round and kept up to date as the round adds objects. */
interface LocalIndex {
  readonly names: Set<string>
  /** stag -> dtag -> seqs of segments. */
  readonly segments: Map<string, Map<string, Set<number>>>
  readonly manifests: Set<string>
}

const STATE_FOR: Record<RemoteError['kind'], DestState> = {
  auth: 'needs-auth',
  permission: 'needs-permission',
  'not-found': 'error',
  network: 'backoff',
  cors: 'error',
  quota: 'error',
  'rate-limited': 'backoff',
  'clock-skew': 'backoff',
  incompatible: 'error',
}

const bytewise = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** Runs `fn` over `items`, at most `n` at a time; the first failure rejects (the others finish first). */
async function pool<T>(items: readonly T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let failure: { error: unknown } | null = null
  const worker = async (): Promise<void> => {
    while (failure === null && next < items.length) {
      const item = items[next++] as T
      try {
        await fn(item)
      } catch (error) {
        failure ??= { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  if (failure !== null) throw (failure as { error: unknown }).error
}

function addSegment(index: LocalIndex, stag: string, dtag: string, seq: number): void {
  let devices = index.segments.get(stag)
  if (!devices) {
    devices = new Map()
    index.segments.set(stag, devices)
  }
  let seqs = devices.get(dtag)
  if (!seqs) {
    seqs = new Set()
    devices.set(dtag, seqs)
  }
  seqs.add(seq)
}

/** Highest h with every segment of (floor, h] present: what a device has applied contiguously. */
function contiguous(seqs: ReadonlySet<number> | undefined, floor: number): number {
  let h = floor
  if (!seqs) return h
  while (seqs.has(h + 1)) h++
  return h
}

export function createSyncEngine(deps: SyncEngineDeps): SyncEngineImpl {
  const { store, subkeys, workspace, keyslots, rng, clock } = deps
  const checkpointEvery = Math.max(2, deps.checkpointEvery ?? CHECKPOINT_EVERY)
  const withholdMs = deps.withholdMs ?? WITHHOLD_MS
  const concurrency = Math.max(1, deps.concurrency ?? CONCURRENCY)
  const withLock: LockFn = (name, fn) => (deps.lock ? deps.lock(name, fn) : fn())

  const dests = new Map<string, Dest>()
  const listeners = new Set<(status: SyncStatus) => void>()
  let alarms: readonly SyncAlarm[] = []
  let snapshot: SyncStatus = Object.freeze({ dests: [], alarms })
  let closed = false
  /** Blob ids each stream object references (immutable once read). */
  const blobsOf = new Map<string, readonly string[]>()
  /** Chunk ids of each manifest (immutable once read). */
  const chunksOf = new Map<string, readonly string[]>()
  /** One round at a time on this page; the lock serializes the pages. */
  let tail: Promise<unknown> = Promise.resolve()

  const live = (): void => {
    if (closed) throw new LockedError('The sync engine is closed')
  }

  const emit = (): void => {
    snapshot = Object.freeze({
      dests: Object.freeze([...dests.values()].map((d) => d.status)),
      alarms,
    })
    for (const fn of [...listeners]) {
      try {
        fn(snapshot)
      } catch (error) {
        queueMicrotask(() => {
          throw error
        })
      }
    }
  }

  const setStatus = (d: Dest, patch: Partial<DestStatus>): void => {
    const next: Record<string, unknown> = { ...d.status, ...patch }
    for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k]
    d.status = Object.freeze(next) as unknown as DestStatus
    emit()
  }

  const dest = (id: string): Dest => {
    const d = dests.get(id)
    if (!d) throw new InvalidStateError(`Unknown destination ${id}`)
    return d
  }

  // Identity

  const identity = async (): Promise<Me> => {
    let id = await store.get('device', 'id')
    if (id === null || id.length !== 16) {
      id = rng.bytes(16)
      await store.put('device', 'id', id)
    }
    return { id, dtag: await deviceTag(subkeys, id) }
  }

  /** A clone of this device wrote under its tag: this device takes a new id (spec/FORMAT.md section 10.3). */
  const rotate = async (): Promise<Me> => {
    const id = rng.bytes(16)
    await store.put('device', 'id', id)
    return { id, dtag: await deviceTag(subkeys, id) }
  }

  // Alarms

  const raise = (state: SyncState, alarm: Omit<SyncAlarm, 'at'>): void => {
    if (state.dismissed.includes(alarm.id) || state.alarms.some((a) => a.id === alarm.id)) return
    state.alarms.push({ ...alarm, at: clock.now() })
  }

  const publishAlarms = (state: SyncState): void => {
    alarms = Object.freeze(state.alarms.map((a) => Object.freeze({ ...a })))
    emit()
  }

  // The local mirror

  const indexLocal = async (): Promise<LocalIndex> => {
    const names = new Set(await store.objects.names())
    const index: LocalIndex = { names, segments: new Map(), manifests: new Set() }
    for (const name of names) {
      const parsed = parseName(name)
      if (parsed?.type === 'segment') addSegment(index, parsed.stag, parsed.dtag, parsed.seq)
      else if (parsed?.type === 'manifest') index.manifests.add(parsed.id)
    }
    return index
  }

  /** Per device, the highest seq applied contiguously in a document: mirror segments above checkpoint coverage. */
  const hwm = (state: SyncState, index: LocalIndex, stag: string): Map<string, number> => {
    const out = new Map<string, number>()
    const devices = index.segments.get(stag)
    const floors = state.covered[stag] ?? {}
    for (const dtag of new Set([...(devices?.keys() ?? []), ...Object.keys(floors)])) {
      out.set(dtag, contiguous(devices?.get(dtag), floors[dtag] ?? 0))
    }
    return out
  }

  const ownSeq = (index: LocalIndex, stag: string, dtag: string): number => {
    const seqs = index.segments.get(stag)?.get(dtag)
    let max = 0
    for (const s of seqs ?? []) if (s > max) max = s
    return max
  }

  const headerFor = (
    state: SyncState,
    index: LocalIndex,
    tags: DocTags,
    docId: DocId,
    me: Me,
    seq: number,
    update: Uint8Array,
  ): StreamHeader => {
    const stag = tags.byDoc.get(docId) as string
    const seen: Record<string, number> = {}
    for (const [dtag, h] of hwm(state, index, stag)) if (dtag !== me.dtag) seen[dtag] = h
    const blobs = [...blobRefs(update)].filter((id) => index.manifests.has(id))
    return { doc: docId, device: me.dtag, seq, time: clock.now(), seen, blobs }
  }

  // Sealing

  const sealDoc = (state: SyncState, index: LocalIndex, tags: DocTags, me: Me, docId: DocId): Promise<boolean> =>
    withLock(`aparte-pending:${docId}`, async () => {
      const queue = await store.pending.list(docId)
      const last = queue.at(-1)
      if (last === undefined) return false
      const after = state.sealed[docId] ?? 0
      // Positions only grow while the queue keeps a record; a queue that restarted below the mark is all new.
      const fresh = last.n < after ? queue : queue.filter((r) => r.n > after)
      if (fresh.length === 0) return false
      const update = mergeUpdates(fresh.map((r) => r.update))
      const stag = tags.byDoc.get(docId) as string
      const seq = ownSeq(index, stag, me.dtag) + 1
      const header = headerFor(state, index, tags, docId, me, seq, update)
      const payload = encodeStreamPayload('segment', header, update)
      const name = await segmentName(subkeys, { docId, deviceId: me.id, seq, payload })
      const envelope = await sealEnvelope(subkeys, { kind: 1, name, payload, compression: 'deflate-raw' }, rng)
      // Persisted locally before any upload: a retry sends these very bytes (spec/FORMAT.md section 10.2).
      await store.objects.put(name, envelope)
      index.names.add(name)
      addSegment(index, stag, me.dtag, seq)
      blobsOf.set(name, header.blobs)
      state.sealed[docId] = last.n
      await saveState(store, state)
      // The last record stays as the position anchor, so positions keep growing; it is marked sealed above.
      await store.pending.drop(docId, last.n - 1)
      return true
    })

  const sealAll = async (state: SyncState, index: LocalIndex, me: Me): Promise<number> => {
    const tags = await docTags(subkeys)
    let n = 0
    for (const docId of DOC_IDS) if (await sealDoc(state, index, tags, me, docId)) n++
    return n
  }

  // Checkpoints

  const maybeCheckpoint = async (state: SyncState, index: LocalIndex, me: Me): Promise<void> => {
    const tags = await docTags(subkeys)
    for (const docId of DOC_IDS) {
      if (!workspace.isLoaded(docId)) continue
      const stag = tags.byDoc.get(docId) as string
      const seq = ownSeq(index, stag, me.dtag)
      if (seq === 0 || (state.ownCheckpoint[docId] ?? 0) >= seq) continue
      const floors = state.covered[stag] ?? {}
      let uncovered = 0
      for (const [dtag, seqs] of index.segments.get(stag) ?? []) {
        for (const s of seqs) if (s > (floors[dtag] ?? 0)) uncovered++
      }
      if (uncovered < checkpointEvery) continue
      const update = await workspace.state(docId)
      const covers: Record<string, number> = {}
      for (const [dtag, h] of hwm(state, index, stag)) covers[dtag] = h
      covers[me.dtag] = seq
      const base = headerFor(state, index, tags, docId, me, seq, update)
      const header: StreamHeader = { ...base, covers }
      const payload = encodeStreamPayload('checkpoint', header, update)
      const name = await checkpointName(subkeys, { docId, deviceId: me.id, seq, payload })
      const envelope = await sealEnvelope(subkeys, { kind: 2, name, payload, compression: 'deflate-raw' }, rng)
      await store.objects.put(name, envelope)
      index.names.add(name)
      blobsOf.set(name, header.blobs)
      state.ownCheckpoint[docId] = seq
      for (const [dtag, s] of Object.entries(covers)) raiseSeq(state.covered, stag, dtag, s)
    }
  }

  // Checks of a complete listing (spec/FORMAT.md section 10.3)

  interface Listed {
    readonly entries: ReadonlyMap<string, RemoteEntry>
    /** stag -> dtag -> seq -> names (segments). */
    readonly segments: Map<string, Map<string, Map<number, string[]>>>
    readonly checkpoints: { readonly name: string; readonly parsed: StreamName }[]
  }

  const readListing = (entries: readonly RemoteEntry[]): Listed => {
    const byName = new Map<string, RemoteEntry>()
    const segments = new Map<string, Map<string, Map<number, string[]>>>()
    const checkpoints: { name: string; parsed: StreamName }[] = []
    for (const entry of entries) {
      // A name that does not match the grammar exactly (a sync client's "x 2" copy) is ignored, never read.
      if (parseName(entry.name) === null) continue
      byName.set(entry.name, entry)
      const parsed = streamName(entry.name)
      if (parsed === null) continue
      if (parsed.type === 'checkpoint') {
        checkpoints.push({ name: entry.name, parsed })
        continue
      }
      let devices = segments.get(parsed.stag)
      if (!devices) {
        devices = new Map()
        segments.set(parsed.stag, devices)
      }
      let seqs = devices.get(parsed.dtag)
      if (!seqs) {
        seqs = new Map()
        devices.set(parsed.dtag, seqs)
      }
      const names = seqs.get(parsed.seq) ?? []
      names.push(entry.name)
      seqs.set(parsed.seq, names)
    }
    return { entries: byName, segments, checkpoints }
  }

  const maxListed = (listed: Listed, stag: string, dtag: string): number => {
    let max = 0
    for (const s of listed.segments.get(stag)?.get(dtag)?.keys() ?? []) if (s > max) max = s
    return max
  }

  const judge = async (state: SyncState, rec: DestRecord, destId: string, listed: Listed): Promise<void> => {
    const tags = await docTags(subkeys)
    const now = clock.now()
    const docOf = (stag: string): DocId | undefined => tags.byTag.get(stag)
    const withDoc = (stag: string) => {
      const doc = docOf(stag)
      return doc === undefined ? {} : { doc }
    }

    // Rollback: a device's highest listed segment below what this destination listed before.
    for (const [stag, devices] of Object.entries(rec.listed)) {
      for (const [dtag, before] of Object.entries(devices)) {
        const highest = maxListed(listed, stag, dtag)
        if (highest < before) {
          raise(state, {
            id: `rollback:${destId}:${stag}:${dtag}:${before}`,
            kind: 'rollback',
            dest: destId,
            ...withDoc(stag),
            detail: `${stag}/${dtag}: highest segment ${highest}, ${before} listed before`,
          })
        }
      }
    }

    // Forks, and gaps below listed segments.
    const gapsNow = new Set<string>()
    for (const [stag, devices] of listed.segments) {
      for (const [dtag, seqs] of devices) {
        let max = 0
        for (const [seq, names] of seqs) {
          if (seq > max) max = seq
          if (names.length > 1) {
            raise(state, {
              id: `fork:${stag}:${dtag}:${seq}`,
              kind: 'fork',
              dest: destId,
              ...withDoc(stag),
              detail: `${stag}/${dtag}: ${names.length} segments for seq ${seq}`,
            })
          }
        }
        raiseSeq(rec.listed, stag, dtag, max)
        const floor = getSeq(state.covered, stag, dtag)
        let watched = 0
        for (let seq = floor + 1; seq < max && watched < MAX_GAPS; seq++) {
          if (seqs.has(seq)) continue
          watched++
          gapsNow.add(`${stag}/${dtag}/${seq}`)
        }
      }
    }
    for (const key of Object.keys(rec.gaps)) if (!gapsNow.has(key)) delete rec.gaps[key]
    for (const key of gapsNow) {
      const first = rec.gaps[key]
      if (first === undefined) rec.gaps[key] = now
      else if (now - first >= withholdMs) {
        const [stag = ''] = key.split('/')
        raise(state, {
          id: `withheld:${destId}:${key}`,
          kind: 'withheld',
          dest: destId,
          ...withDoc(stag),
          detail: `${key} is missing below a listed segment since ${new Date(first).toISOString()}`,
        })
      }
    }
  }

  /** After the download, with the claims of the headers just read: a header named a segment the store does not return. */
  const judgeClaims = async (state: SyncState, rec: DestRecord, destId: string, listed: Listed): Promise<void> => {
    const tags = await docTags(subkeys)
    const now = clock.now()
    const withDoc = (stag: string) => {
      const doc = tags.byTag.get(stag)
      return doc === undefined ? {} : { doc }
    }
    const unreturnedNow = new Set<string>()
    for (const [stag, devices] of Object.entries(state.claims)) {
      for (const [dtag, claimed] of Object.entries(devices)) {
        if (claimed > maxListed(listed, stag, dtag) && claimed > getSeq(state.covered, stag, dtag)) {
          unreturnedNow.add(`${stag}/${dtag}/${claimed}`)
        }
      }
    }
    for (const key of Object.keys(rec.unreturned)) if (!unreturnedNow.has(key)) delete rec.unreturned[key]
    for (const key of unreturnedNow) {
      const first = rec.unreturned[key]
      if (first === undefined) rec.unreturned[key] = now
      else if (now - first >= withholdMs) {
        const [stag = ''] = key.split('/')
        raise(state, {
          id: `unreturned:${destId}:${key}`,
          kind: 'unreturned',
          dest: destId,
          ...withDoc(stag),
          detail: `${key} is named by another device but not returned`,
        })
      }
    }
  }

  // Keyslots and the format marker

  const syncKeyslots = async (
    state: SyncState,
    rec: DestRecord,
    d: Dest,
    listed: Listed,
  ): Promise<{ readonly put: KeyslotFile[]; readonly fmt: boolean }> => {
    const local = await keyslots.files()
    const localIds = new Set(local.map((f) => KEYSLOT.exec(f.name)?.[1] ?? ''))
    const known = new Set(state.slots)
    const removed = new Set(state.removedSlots)
    const toImport: KeyslotFile[] = []
    for (const [name, entry] of listed.entries) {
      const slot = KEYSLOT.exec(name)?.[1]
      if (slot === undefined || localIds.has(slot)) continue
      if (removed.has(slot)) continue
      if (known.has(slot)) {
        // This device removed the slot: it goes from the destination once, where the store can delete it.
        await d.store.delete(name)
        removed.add(slot)
        continue
      }
      const bytes = await d.store.get(entry)
      if (bytes === null) continue
      let vault: unknown
      try {
        vault = (JSON.parse(fromUtf8(bytes)) as { vault?: unknown }).vault
      } catch {
        continue
      }
      if (vault !== keyslots.vault) {
        throw new RemoteError('incompatible', 'This destination holds another vault')
      }
      toImport.push({ name, bytes })
    }
    const added = toImport.length === 0 ? [] : await keyslots.import(toImport)
    state.slots = [...new Set([...localIds, ...added, ...known])].filter((s) => s !== '' && !removed.has(s)).sort()
    state.removedSlots = [...removed].sort()

    let fmt = false
    const marker = listed.entries.get(FMT_NAME)
    if (marker && rec.fmtOk === true) fmt = true
    else if (marker) {
      const bytes = await d.store.get(marker)
      if (bytes !== null && !equal(bytes, FMT_BYTES)) {
        throw new RemoteError('incompatible', 'This destination holds another format than aparte/1')
      }
      fmt = bytes !== null
      if (fmt) rec.fmtOk = true
    }
    return { put: local.filter((f) => !listed.entries.has(f.name)), fmt }
  }

  // Download

  const download = async (
    state: SyncState,
    d: Dest,
    index: LocalIndex,
    listed: Listed,
  ): Promise<{ down: number; blobs: number }> => {
    const tags = await docTags(subkeys)
    const chunks: string[] = []
    const manifests: string[] = []
    const checkpoints: string[] = []
    const segments: { name: string; parsed: StreamName }[] = []
    const secrets: string[] = []
    for (const name of listed.entries.keys()) {
      if (index.names.has(name) || (state.bad[name] ?? 0) >= MAX_BAD) continue
      const parsed = parseName(name)
      if (parsed === null) continue
      if (parsed.type === 'chunk') chunks.push(name)
      else if (parsed.type === 'manifest') manifests.push(name)
      else if (parsed.type === 'secret') secrets.push(name)
      else if (parsed.type === 'segment') segments.push({ name, parsed })
    }
    // A document this device holds nothing of starts from its checkpoints, then needs only the segments above them.
    const fresh = (stag: string): boolean =>
      !index.segments.has(stag) && Object.keys(state.covered[stag] ?? {}).length === 0
    for (const { name, parsed } of listed.checkpoints) {
      if (!index.names.has(name) && fresh(parsed.stag) && (state.bad[name] ?? 0) < MAX_BAD) checkpoints.push(name)
    }

    let down = 0
    let blobs = 0
    const bad = (name: string, error: unknown): void => {
      if (!(error instanceof AparteError)) throw error
      state.bad[name] = (state.bad[name] ?? 0) + 1
      if ((state.bad[name] ?? 0) >= MAX_BAD) {
        raise(state, {
          id: `tampered:${d.status.id}:${name}`,
          kind: 'tampered',
          dest: d.status.id,
          detail: `${name}: ${error.code}`,
        })
      }
    }
    const pull = (name: string): Promise<Bytes | null> => d.store.get(listed.entries.get(name) as RemoteEntry)
    const keep = async (name: string, bytes: Uint8Array): Promise<void> => {
      await store.objects.put(name, bytes)
      index.names.add(name)
      delete state.bad[name]
      down++
    }

    // Blobs first: a message that arrives shows its photo at once.
    await pool(manifests, concurrency, async (name) => {
      const bytes = await pull(name)
      if (bytes === null) return
      try {
        const id = (parseName(name) as { id: string }).id
        const payload = await openEnvelope(subkeys, { kind: 4, name, bytes })
        if ((await manifestId(subkeys, payload)) !== id) throw new TamperedLike('A manifest does not match its id')
        await keep(name, bytes)
        index.manifests.add(id)
        blobs++
      } catch (error) {
        bad(name, error)
      }
    })
    await pool(chunks, concurrency, async (name) => {
      const bytes = await pull(name)
      if (bytes === null) return
      try {
        const id = (parseName(name) as { id: string }).id
        const payload = await openEnvelope(subkeys, { kind: 3, name, bytes })
        if ((await chunkId(subkeys, payload)) !== id) throw new TamperedLike('A chunk does not match its id')
        await keep(name, bytes)
        blobs++
      } catch (error) {
        bad(name, error)
      }
    })
    await pool(secrets, concurrency, async (name) => {
      const bytes = await pull(name)
      if (bytes === null) return
      try {
        // Secret versions are kept and relayed; reading their values is the secrets layer's job.
        await openEnvelope(subkeys, { kind: 5, name, bytes })
        await keep(name, bytes)
      } catch (error) {
        bad(name, error)
      }
    })

    const apply = async (doc: DocId, update: Uint8Array): Promise<void> => {
      if (workspace.isLoaded(doc)) await workspace.applyRemote(doc, update)
    }
    const claim = (stag: string, header: StreamHeader): void => {
      const named: SeqMap[] = [header.seen, header.covers ?? {}]
      for (const map of named) for (const [dtag, seq] of Object.entries(map)) raiseSeq(state.claims, stag, dtag, seq)
    }

    await pool(checkpoints, concurrency, async (name) => {
      const parsed = streamName(name) as StreamName
      const bytes = await pull(name)
      if (bytes === null) return
      try {
        const opened = await openStream(subkeys, tags, name, parsed, bytes)
        await keep(name, bytes)
        blobsOf.set(name, opened.header.blobs)
        claim(parsed.stag, opened.header)
        for (const [dtag, seq] of Object.entries(opened.header.covers ?? {})) {
          raiseSeq(state.covered, parsed.stag, dtag, seq)
        }
        await apply(opened.header.doc, opened.update)
      } catch (error) {
        bad(name, error)
      }
    })

    const needed = segments
      .filter(({ parsed }) => parsed.seq > getSeq(state.covered, parsed.stag, parsed.dtag))
      .sort(
        (a, b) =>
          bytewise(a.parsed.stag, b.parsed.stag) ||
          bytewise(a.parsed.dtag, b.parsed.dtag) ||
          a.parsed.seq - b.parsed.seq,
      )
    await pool(needed, concurrency, async ({ name, parsed }) => {
      const bytes = await pull(name)
      if (bytes === null) return
      try {
        const opened = await openStream(subkeys, tags, name, parsed, bytes)
        await keep(name, bytes)
        addSegment(index, parsed.stag, parsed.dtag, parsed.seq)
        blobsOf.set(name, opened.header.blobs)
        claim(parsed.stag, opened.header)
        await apply(opened.header.doc, opened.update)
      } catch (error) {
        bad(name, error)
      }
    })
    return { down, blobs }
  }

  // Upload (spec/FORMAT.md section 10.2)

  const streamBlobs = async (name: string, bytes: Uint8Array): Promise<readonly string[] | null> => {
    const cached = blobsOf.get(name)
    if (cached) return cached
    const parsed = streamName(name)
    if (parsed === null) return null
    try {
      const opened = await openStream(subkeys, await docTags(subkeys), name, parsed, bytes)
      blobsOf.set(name, opened.header.blobs)
      return opened.header.blobs
    } catch {
      return null
    }
  }

  const manifestChunks = async (name: string, bytes: Uint8Array): Promise<readonly string[] | null> => {
    const cached = chunksOf.get(name)
    if (cached) return cached
    try {
      const payload = await openEnvelope(subkeys, { kind: 4, name, bytes })
      const parsed = JSON.parse(fromUtf8(payload)) as { chunks?: unknown }
      if (!Array.isArray(parsed.chunks) || !parsed.chunks.every((c) => typeof c === 'string')) return null
      const chunks = parsed.chunks as string[]
      chunksOf.set(name, chunks)
      return chunks
    } catch {
      return null
    }
  }

  const upload = async (
    d: Dest,
    rec: DestRecord,
    index: LocalIndex,
    listed: Listed,
    keyslotFiles: readonly KeyslotFile[],
    hasFmt: boolean,
    me: Me,
  ): Promise<{ up: number; deferred: number }> => {
    const remote = new Set(listed.entries.keys())
    let up = 0
    const missing = [...index.names].filter((n) => !remote.has(n)).sort(bytewise)
    let queued = missing.length + keyslotFiles.length + (hasFmt ? 0 : 1)
    let queuedBytes = 0
    const progress = (): void => {
      const pace = d.store.pace
      const etaMs = pace ? (pace.queuedWrites + pace.writesFor(queued, queuedBytes)) * pace.msPerWrite : undefined
      setStatus(d, { queued, queuedBytes, etaMs })
    }
    const put = async (name: string, bytes: Uint8Array): Promise<void> => {
      await d.store.put(name, bytes)
      queued = Math.max(0, queued - 1)
      queuedBytes = Math.max(0, queuedBytes - bytes.length)
      up++
      progress()
    }

    // The marker and the keyslots come first, confirmed by a listing: no object is any use without them.
    if (!hasFmt || keyslotFiles.length > 0) {
      if (!hasFmt) await put(FMT_NAME, FMT_BYTES)
      for (const file of keyslotFiles) await put(file.name, file.bytes)
      await d.store.flush()
      const check = new Set((await d.store.list('')).map((e) => e.name))
      const confirmed = check.has(FMT_NAME) && keyslotFiles.every((f) => check.has(f.name))
      if (!confirmed) throw new RemoteError('network', 'The destination does not list the keyslots it was sent')
      for (const name of check) remote.add(name)
    }

    const byType = (type: string): string[] => missing.filter((n) => parseName(n)?.type === type)
    const chunks = byType('chunk')
    const manifests = byType('manifest')
    const secrets = byType('secret')
    const streams = [...byType('checkpoint'), ...byType('segment')]
    for (const name of missing) queuedBytes += (await store.objects.get(name))?.length ?? 0
    progress()

    let deferred = 0
    const phase = async (names: readonly string[], ready: (name: string, bytes: Bytes) => Promise<boolean>) => {
      const sent: string[] = []
      for (const name of names) {
        const bytes = await store.objects.get(name)
        if (bytes === null) continue
        if (!(await ready(name, bytes))) {
          deferred++
          continue
        }
        await put(name, bytes)
        sent.push(name)
      }
      if (sent.length > 0) await d.store.flush()
      for (const name of sent) remote.add(name)
    }

    await phase(chunks, async () => true)
    await phase(manifests, async (name, bytes) => {
      const ids = await manifestChunks(name, bytes)
      return ids?.every((id) => remote.has(chunkName(id))) ?? false
    })
    await phase(secrets, async () => true)
    await phase(streams, async (name, bytes) => {
      const ids = await streamBlobs(name, bytes)
      return ids?.every((id) => remote.has(manifestName(id))) ?? false
    })
    // Own segments now on the destination count for its rollback mark, as listed ones do.
    for (const name of remote) {
      const parsed = streamName(name)
      if (parsed?.type === 'segment' && parsed.dtag === me.dtag)
        raiseSeq(rec.listed, parsed.stag, parsed.dtag, parsed.seq)
    }
    return { up, deferred }
  }

  // Round

  const runRound = async (destId: string): Promise<RoundResult> => {
    live()
    const d = dest(destId)
    let release: () => void = () => undefined
    try {
      if (deps.hold) release = deps.hold('sync')
    } catch (cause) {
      // The vault is locking: no round starts now, and the one after the next unlock catches up.
      throw new LockedError('The vault is locking', { cause })
    }
    setStatus(d, { state: 'syncing' })
    try {
      const result = await withLock('aparte-sync', async () => {
        const state = await loadState(store)
        const index = await indexLocal()
        let me = await identity()
        await sealAll(state, index, me)
        live()

        const listed = readListing(await d.store.list(''))
        const rec = destRecord(state, destId)
        // A marker that is no longer listed is checked again once it reappears.
        if (!listed.entries.has(FMT_NAME)) rec.fmtOk = false
        const { put: keyslotFiles, fmt } = await syncKeyslots(state, rec, d, listed)

        // A segment or checkpoint under this device's tag that this device never wrote: a clone writes as it.
        const foreign = [...listed.entries.keys()].filter((name) => {
          const parsed = streamName(name)
          return parsed !== null && parsed.dtag === me.dtag && !index.names.has(name)
        })
        if (foreign.length > 0) {
          raise(state, {
            id: `fork:${me.dtag}`,
            kind: 'fork',
            dest: destId,
            detail: `${foreign.length} objects under this device's tag ${me.dtag} were written elsewhere`,
          })
          me = await rotate()
        }

        await judge(state, rec, destId, listed)
        const { down, blobs } = await download(state, d, index, listed)
        await judgeClaims(state, rec, destId, listed)
        live()
        await maybeCheckpoint(state, index, me)
        const { up, deferred } = await upload(d, rec, index, listed, keyslotFiles, fmt, me)
        rec.lastOkAt = clock.now()
        if (d.transient) delete state.dests[destId]
        await saveState(store, state)
        publishAlarms(state)
        if (blobs > 0) deps.onBlobs?.()
        return { down, up, deferred }
      })
      let info = d.status.info
      if (d.store.info) {
        try {
          info = await d.store.info()
        } catch {
          // Facts about the destination are a bonus; a round that synced is a success without them.
        }
      }
      setStatus(d, {
        state: 'idle',
        lastOkAt: clock.now(),
        error: undefined,
        nextTryAt: undefined,
        queued: result.deferred,
        info,
      })
      return result
    } catch (error) {
      if (error instanceof LockedError || closed) {
        setStatus(d, { state: 'idle' })
        throw error
      }
      const at = clock.now()
      if (error instanceof RemoteError) {
        // A refused permission is a browser grant for a folder, and the credentials' scope everywhere else.
        const state = error.kind === 'permission' && d.store.kind !== 'folder' ? 'needs-auth' : STATE_FOR[error.kind]
        setStatus(d, { state, error: { kind: error.kind, message: error.message, at } })
      } else {
        const message = error instanceof Error ? error.message : String(error)
        setStatus(d, { state: 'error', error: { kind: 'internal', message, at } })
      }
      throw error
    } finally {
      release()
    }
  }

  const engine: SyncEngineImpl = {
    round(destId) {
      const run = tail.then(
        () => runRound(destId),
        () => runRound(destId),
      )
      tail = run.catch(() => undefined)
      return run
    },
    async seal() {
      live()
      return withLock('aparte-sync', async () => {
        const state = await loadState(store)
        const index = await indexLocal()
        const n = await sealAll(state, index, await identity())
        return n
      })
    },
    async deviceTag() {
      live()
      return (await identity()).dtag
    },
    status() {
      return snapshot
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    addDestination(remote, label, options) {
      live()
      if (dests.has(remote.id)) return
      dests.set(remote.id, {
        store: remote,
        transient: options?.transient === true,
        status: Object.freeze({ id: remote.id, kind: remote.kind, label, state: 'idle', queued: 0, queuedBytes: 0 }),
      })
      emit()
      void loadState(store).then(
        (state) => {
          if (closed) return
          const lastOkAt = state.dests[remote.id]?.lastOkAt
          const d = dests.get(remote.id)
          if (d && lastOkAt !== undefined && d.status.lastOkAt === undefined) setStatus(d, { lastOkAt })
          if (alarms.length === 0 && state.alarms.length > 0) publishAlarms(state)
        },
        () => undefined,
      )
    },
    removeDestination(id) {
      dests.delete(id)
      emit()
    },
    destinations() {
      return [...dests.keys()]
    },
    noteSchedule(id, nextTryAt) {
      const d = dests.get(id)
      if (d) setStatus(d, { nextTryAt })
    },
    async dismissAlarm(id) {
      live()
      await withLock('aparte-sync', async () => {
        const state = await loadState(store)
        state.alarms = state.alarms.filter((a) => a.id !== id)
        if (!state.dismissed.includes(id)) state.dismissed.push(id)
        await saveState(store, state)
        publishAlarms(state)
      })
    },
    close() {
      closed = true
      listeners.clear()
      dests.clear()
      blobsOf.clear()
      chunksOf.clear()
    },
  }
  return engine
}

/** An object whose content does not match its keyed name: reported as `tampered` (spec/FORMAT.md section 12). */
class TamperedLike extends AparteError {
  constructor(message: string) {
    super('tampered', message)
  }
}
