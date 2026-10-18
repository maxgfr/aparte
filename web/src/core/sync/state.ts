/*
 * The sync state this device keeps between rounds, as one encrypted local record (purpose `hwm`, id `sync`,
 * spec/FORMAT.md sections 10.3 and 11.3): what each destination has listed (for rollback), the gaps and unreturned
 * claims being watched (for withholding), checkpoint coverage, the keyslots known, and the alarms raised.
 *
 * Read afresh at the start of every round and written at its end, so two pages of the device never work from a stale
 * copy (rounds are serialized across pages by a lock). A record that does not parse is replaced by a fresh state: the
 * device then trusts the next listing again, as a new device does (section 10.4).
 */

import type { DocId } from '../contracts/crypto.ts'
import type { LocalStore } from '../contracts/store.ts'
import type { SyncAlarm } from '../contracts/sync.ts'
import { fromUtf8, utf8 } from '../crypto/bytes.ts'

/** `stag -> dtag -> seq`. */
export type TagSeqs = Record<string, Record<string, number>>

export interface DestRecord {
  /** Highest seq this destination ever listed, per (stag, dtag): a later listing below it is a rollback. */
  listed: TagSeqs
  /** `stag/dtag/seq` of a missing segment below a listed one -> when first seen missing. */
  gaps: Record<string, number>
  /** `stag/dtag/seq` named by a header and not returned -> when first seen missing. */
  unreturned: Record<string, number>
  /** The format marker was read back intact once: it is not read again. */
  fmtOk?: boolean
  lastOkAt?: number
}

export interface SyncState {
  v: 1
  /** Per (stag, dtag), the coverage of the checkpoints this device holds: segments at or below it are not needed. */
  covered: TagSeqs
  /** Per (stag, dtag), the highest seq a `seen` or `covers` of a header this device read names. */
  claims: TagSeqs
  /** Per document, the own seq of this device's last checkpoint. */
  ownCheckpoint: Partial<Record<DocId, number>>
  /** Per document, the last pending-queue position sealed into a segment. */
  sealed: Partial<Record<DocId, number>>
  /** Keyslot ids this device has had (to tell a slot another device added from one this device removed). */
  slots: string[]
  /** Keyslot ids this device removed and deleted from its destinations once: never imported again. */
  removedSlots: string[]
  dests: Record<string, DestRecord>
  alarms: SyncAlarm[]
  /** Alarm ids the user dismissed: the same finding does not come back. */
  dismissed: string[]
  /** Object name -> failed validations: after a few, the object is no longer fetched. */
  bad: Record<string, number>
}

export const STATE_ID = 'sync'

export function emptyState(): SyncState {
  return {
    v: 1,
    covered: {},
    claims: {},
    ownCheckpoint: {},
    sealed: {},
    slots: [],
    removedSlots: [],
    dests: {},
    alarms: [],
    dismissed: [],
    bad: {},
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

/** The record's state, or a fresh one when there is none or it does not parse. */
export async function loadState(store: LocalStore): Promise<SyncState> {
  const bytes = await store.get('hwm', STATE_ID)
  if (bytes === null) return emptyState()
  try {
    const value: unknown = JSON.parse(fromUtf8(bytes))
    if (!isRecord(value) || value.v !== 1) return emptyState()
    const fresh = emptyState()
    const out: SyncState = { ...fresh }
    for (const key of Object.keys(fresh) as (keyof SyncState)[]) {
      const v = value[key]
      if (v === undefined) continue
      if (Array.isArray(fresh[key]) !== Array.isArray(v)) return emptyState()
      ;(out as unknown as Record<string, unknown>)[key] = v
    }
    out.v = 1
    return out
  } catch {
    return emptyState()
  }
}

export async function saveState(store: LocalStore, state: SyncState): Promise<void> {
  await store.put('hwm', STATE_ID, utf8(JSON.stringify(state)))
}

export function getSeq(map: TagSeqs, stag: string, dtag: string): number {
  return map[stag]?.[dtag] ?? 0
}

export function raiseSeq(map: TagSeqs, stag: string, dtag: string, seq: number): void {
  let inner = map[stag]
  if (inner === undefined) {
    inner = {}
    map[stag] = inner
  }
  if (seq > (inner[dtag] ?? 0)) inner[dtag] = seq
}

export function destRecord(state: SyncState, dest: string): DestRecord {
  let rec = state.dests[dest]
  if (!rec) {
    rec = { listed: {}, gaps: {}, unreturned: {} }
    state.dests[dest] = rec
  }
  return rec
}
