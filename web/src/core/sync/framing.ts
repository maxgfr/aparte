/*
 * Payload framing of segments and checkpoints (spec/FORMAT.md sections 9.1 and 9.2):
 * `payload = u32be(hlen) || header || update`, the header JSON in writer order (section 3.4).
 *
 * The reader accepts only the writer form: it parses, checks the schema, serializes again and compares, so the web
 * app and the CLI (crates/aparte-format/src/framing.rs) always agree on what a payload says. Checks that need the
 * vault keys (`doc` against the name's `stag`) are made by the caller.
 */

import { type Bytes, CorruptError, type DocId, InvalidInputError } from '../contracts/crypto.ts'
import { concat, fromUtf8, readU32be, u32be, utf8 } from '../crypto/bytes.ts'

export const MAX_HEADER = 65_536
const MAX_SEQ = 9_999_999_999
const TAG16 = /^[a-z2-7]{16}$/
const ID26 = /^[a-z2-7]{26}$/
const DOC_IDS: ReadonlySet<string> = new Set([
  'index',
  ...Array.from({ length: 16 }, (_, i) => `c${String(i).padStart(2, '0')}`),
])

export type StreamKind = 'segment' | 'checkpoint'

/** `dtag -> seq`. */
export type SeqMap = Readonly<Record<string, number>>

export interface StreamHeader {
  readonly doc: DocId
  /** The writer's `dtag`. */
  readonly device: string
  readonly seq: number
  /** The writer's clock, Unix milliseconds; informative only. */
  readonly time: number
  /** Highest contiguous seq applied, for every other device with segments in this document. */
  readonly seen: SeqMap
  /** Manifest ids the update references. */
  readonly blobs: readonly string[]
  /** Checkpoints only: for every device, the writer included, the highest segment the state contains. */
  readonly covers?: SeqMap
}

export interface StreamPayload {
  readonly header: StreamHeader
  readonly update: Bytes
}

/** Bytewise order of ASCII strings, as section 9.1 sorts `seen`, `covers` and `blobs`. */
const bytewise = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

const isSeq = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= MAX_SEQ
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= MAX_SEQ

function sortedMap(map: SeqMap): Record<string, number> {
  const out: Record<string, number> = {}
  for (const key of Object.keys(map).sort(bytewise)) out[key] = map[key] as number
  return out
}

/** The schema rules beyond the JSON types; `fail` builds the error (invalid-input writing, corrupt reading). */
function check(kind: StreamKind, h: StreamHeader, fail: (m: string) => Error): void {
  if (!DOC_IDS.has(h.doc)) throw fail('Unknown document in a stream header')
  if (typeof h.device !== 'string' || !TAG16.test(h.device)) throw fail('A stream header device is not a dtag')
  if (!isSeq(h.seq)) throw fail('A stream header seq is out of range')
  if (typeof h.time !== 'number' || !Number.isSafeInteger(h.time) || h.time < 0) throw fail('Bad stream header time')
  for (const [dtag, seq] of Object.entries(h.seen)) {
    // `seen` lists the other devices only; 0 (nothing contiguous from 1) is allowed.
    if (!TAG16.test(dtag) || dtag === h.device || !isCount(seq)) throw fail('Bad stream header seen')
  }
  for (const [i, blob] of h.blobs.entries()) {
    if (typeof blob !== 'string' || !ID26.test(blob)) throw fail('Bad stream header blob')
    if (i > 0 && bytewise(h.blobs[i - 1] as string, blob) >= 0) throw fail('Stream header blobs are not sorted')
  }
  if (kind === 'segment') {
    if (h.covers !== undefined) throw fail('A segment header has covers')
    return
  }
  if (h.covers === undefined) throw fail('A checkpoint header needs covers')
  for (const [dtag, seq] of Object.entries(h.covers)) {
    if (!TAG16.test(dtag) || !isCount(seq)) throw fail('Bad checkpoint covers')
  }
  if (h.covers[h.device] !== h.seq) throw fail('A checkpoint must cover its own seq')
}

/** The header JSON in writer order: v, doc, device, seq, time, seen, blobs, then covers. */
function headerJson(kind: StreamKind, h: StreamHeader): string {
  const ordered: Record<string, unknown> = {
    v: 1,
    doc: h.doc,
    device: h.device,
    seq: h.seq,
    time: h.time,
    seen: sortedMap(h.seen),
    blobs: [...h.blobs],
  }
  if (kind === 'checkpoint') ordered.covers = sortedMap(h.covers ?? {})
  return JSON.stringify(ordered)
}

/** Builds a payload; `blobs` is sorted and deduplicated. InvalidInputError outside the schema or for an empty update. */
export function encodeStreamPayload(kind: StreamKind, header: StreamHeader, update: Uint8Array): Bytes {
  const h: StreamHeader = { ...header, blobs: [...new Set(header.blobs)].sort(bytewise) }
  check(kind, h, (m) => new InvalidInputError(m))
  if (update.length === 0) throw new InvalidInputError('A stream payload needs a non-empty update')
  const json = utf8(headerJson(kind, h))
  if (json.length > MAX_HEADER) throw new InvalidInputError('A stream header is above 65536 bytes')
  return concat(u32be(json.length), json, update)
}

const SEGMENT_MEMBERS = ['v', 'doc', 'device', 'seq', 'time', 'seen', 'blobs']
const CHECKPOINT_MEMBERS = [...SEGMENT_MEMBERS, 'covers']

function seqMap(value: unknown): Record<string, number> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(value)) {
    if (!isCount(v)) return null
    out[k] = v
  }
  return out
}

/** Parses a payload strictly; CorruptError for anything but the writer form of a valid header and a non-empty update. */
export function decodeStreamPayload(kind: StreamKind, payload: Uint8Array): StreamPayload {
  if (payload.length < 4) throw new CorruptError('Stream payload too short')
  const hlen = readU32be(payload, 0)
  if (hlen === 0 || hlen > MAX_HEADER || 4 + hlen >= payload.length) throw new CorruptError('Bad stream header length')
  const jsonBytes = payload.subarray(4, 4 + hlen)
  let text: string
  let value: unknown
  try {
    text = fromUtf8(jsonBytes)
    value = JSON.parse(text)
  } catch (cause) {
    throw new CorruptError('A stream header is not JSON', { cause })
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CorruptError('Bad stream header')
  const o = value as Record<string, unknown>
  const expected = kind === 'segment' ? SEGMENT_MEMBERS : CHECKPOINT_MEMBERS
  const keys = Object.keys(o)
  if (keys.length !== expected.length || !expected.every((k) => Object.hasOwn(o, k))) {
    throw new CorruptError('A stream header has missing or extra members')
  }
  if (o.v !== 1) throw new CorruptError('Unknown stream header version')
  const seen = seqMap(o.seen)
  const covers = kind === 'checkpoint' ? seqMap(o.covers) : undefined
  if (
    typeof o.doc !== 'string' ||
    typeof o.device !== 'string' ||
    typeof o.seq !== 'number' ||
    typeof o.time !== 'number' ||
    seen === null ||
    covers === null ||
    !Array.isArray(o.blobs) ||
    !o.blobs.every((b) => typeof b === 'string')
  ) {
    throw new CorruptError('A stream header member has the wrong type')
  }
  const header: StreamHeader = {
    doc: o.doc as DocId,
    device: o.device,
    seq: o.seq,
    time: o.time,
    seen,
    blobs: o.blobs as string[],
    ...(covers === undefined ? {} : { covers }),
  }
  check(kind, header, (m) => new CorruptError(m))
  if (headerJson(kind, header) !== text) throw new CorruptError('A stream header is not in writer form')
  return { header, update: new Uint8Array(payload.subarray(4 + hlen)) as Bytes }
}
