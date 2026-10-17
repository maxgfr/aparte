/*
 * Object names of spec/FORMAT.md section 8 and local record names of section 11.3. Every tag is a truncated base32
 * HMAC under a vault subkey, so the store sees stable, unlinkable names; a name depends on the plaintext payload,
 * never on the ciphertext. parseName accepts exactly the grammar of section 8.8 and nothing else.
 */
import {
  type DocId,
  InvalidInputError,
  type ParsedName,
  type SecretNameInput,
  type ShardId,
  type StreamNameInput,
  type Subkeys,
} from '../contracts/crypto.ts'
import { base32Decode, base32Encode, concat, utf8 } from './bytes.ts'
import { hmacSha256, sha256 } from './keys.ts'

const MAX_SEQ = 9_999_999_999
/** A local record id is at most 1024 bytes of UTF-8 (spec/FORMAT.md section 9.6). */
const MAX_LOCAL_ID = 1024
const PURPOSE = /^[a-z][a-z0-9-]{0,31}$/
const ID26 = /^[a-z2-7]{26}$/

const DOC_IDS: ReadonlySet<string> = new Set([
  'index',
  ...Array.from({ length: 16 }, (_, i) => `c${String(i).padStart(2, '0')}`),
])

function requireId(bytes: Uint8Array, what: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) throw new InvalidInputError(`${what} must be 16 bytes`)
}

function requireSeq(seq: number): void {
  if (!Number.isSafeInteger(seq) || seq < 1 || seq > MAX_SEQ) {
    throw new InvalidInputError(`A sequence number runs from 1 to ${MAX_SEQ}`)
  }
}

function requireDocId(docId: string): asserts docId is DocId {
  if (!DOC_IDS.has(docId)) throw new InvalidInputError(`Unknown document ${docId}`)
}

const seq10 = (seq: number): string => String(seq).padStart(10, '0')
const bucket7 = (seq: number): string => String(Math.floor(seq / 1000)).padStart(7, '0')

/** b32(HMAC(key, message))[0..chars]. */
async function tag(key: CryptoKey, message: Uint8Array, chars: number): Promise<string> {
  return base32Encode(await hmacSha256(key, message)).slice(0, chars)
}

export function keyslotName(slotId: Uint8Array): string {
  requireId(slotId, 'A slot id')
  return `keys/${base32Encode(slotId)}.json`
}

export function deviceTag(subkeys: Subkeys, deviceId: Uint8Array): Promise<string> {
  requireId(deviceId, 'A device id')
  return tag(subkeys.objName, concat(utf8('dtag|'), deviceId), 16)
}

export function docTag(subkeys: Subkeys, docId: DocId): Promise<string> {
  requireDocId(docId)
  return tag(subkeys.objName, utf8(`doc|${docId}`), 16)
}

export async function shardOf(subkeys: Subkeys, convId: Uint8Array): Promise<ShardId> {
  requireId(convId, 'A conversation id')
  const mac = await hmacSha256(subkeys.objName, concat(utf8('shard|'), convId))
  return `c${String((mac[0] ?? 0) & 0x0f).padStart(2, '0')}` as ShardId
}

/** The r8 suffix: b32(HMAC(K_obj-name, label || tags || seq10 || SHA-256(payload)))[0..8]. */
async function suffix(subkeys: Subkeys, prefix: string, payload: Uint8Array): Promise<string> {
  return tag(subkeys.objName, concat(utf8(prefix), await sha256(payload)), 8)
}

async function streamParts(subkeys: Subkeys, input: StreamNameInput): Promise<[string, string]> {
  requireDocId(input.docId)
  requireSeq(input.seq)
  return Promise.all([docTag(subkeys, input.docId), deviceTag(subkeys, input.deviceId)])
}

export async function segmentName(subkeys: Subkeys, input: StreamNameInput): Promise<string> {
  const [stag, dtag] = await streamParts(subkeys, input)
  const seq = seq10(input.seq)
  const r8 = await suffix(subkeys, `seg|${stag}${dtag}${seq}`, input.payload)
  return `d/${stag}/s/${dtag}/${bucket7(input.seq)}/${seq}-${r8}`
}

export async function checkpointName(subkeys: Subkeys, input: StreamNameInput): Promise<string> {
  const [stag, dtag] = await streamParts(subkeys, input)
  const seq = seq10(input.seq)
  const r8 = await suffix(subkeys, `ckpt|${stag}${dtag}${seq}`, input.payload)
  return `d/${stag}/c/${dtag}/${seq}-${r8}`
}

async function blobTag(subkeys: Subkeys, label: string, content: Uint8Array): Promise<string> {
  return tag(subkeys.blobId, concat(utf8(label), await sha256(content)), 26)
}

function blobName(prefix: 'b' | 'm', id: string): string {
  if (!ID26.test(id)) throw new InvalidInputError('A blob id is 26 base32 characters')
  return `${prefix}/${id.slice(0, 2)}/${id}`
}

export function chunkId(subkeys: Subkeys, chunk: Uint8Array): Promise<string> {
  return blobTag(subkeys, 'chunk|', chunk)
}

export function chunkName(id: string): string {
  return blobName('b', id)
}

export function manifestId(subkeys: Subkeys, manifest: Uint8Array): Promise<string> {
  return blobTag(subkeys, 'manifest|', manifest)
}

export function manifestName(id: string): string {
  return blobName('m', id)
}

export function secretTag(subkeys: Subkeys, secretId: Uint8Array): Promise<string> {
  requireId(secretId, 'A secret id')
  return tag(subkeys.objName, concat(utf8('secret|'), secretId), 16)
}

export async function secretVersionName(subkeys: Subkeys, input: SecretNameInput): Promise<string> {
  requireSeq(input.seq)
  const ktag = await secretTag(subkeys, input.secretId)
  const seq = seq10(input.seq)
  const r8 = await suffix(subkeys, `sec|${ktag}${seq}`, input.payload)
  return `k/${ktag}/${seq}-${r8}`
}

export async function localName(subkeys: Subkeys, purpose: string, id: string): Promise<string> {
  if (!PURPOSE.test(purpose)) throw new InvalidInputError('A local record purpose matches [a-z][a-z0-9-]{0,31}')
  const idBytes = utf8(id)
  if (idBytes.length > MAX_LOCAL_ID) throw new InvalidInputError(`A local record id is at most ${MAX_LOCAL_ID} bytes`)
  return tag(subkeys.localName, concat(utf8(`${purpose}|`), idBytes), 26)
}

// Grammar of spec/FORMAT.md section 8.8. JavaScript's `$` without the `m` flag matches only at the very end, and `\d`
// without the `u` flag is ASCII, so each pattern accepts exactly its form.

const KEYSLOT = /^keys\/([a-z2-7]{26})\.json$/
const SEGMENT = /^d\/([a-z2-7]{16})\/s\/([a-z2-7]{16})\/(\d{7})\/(\d{10})-([a-z2-7]{8})$/
const CHECKPOINT = /^d\/([a-z2-7]{16})\/c\/([a-z2-7]{16})\/(\d{10})-([a-z2-7]{8})$/
const BLOB = /^([bm])\/([a-z2-7]{2})\/([a-z2-7]{26})$/
const SECRET = /^k\/([a-z2-7]{16})\/(\d{10})-([a-z2-7]{8})$/

/** Strict base32 of exactly 16 bytes: the last character must have zero low bits. */
function isId(text: string): boolean {
  try {
    return base32Decode(text).length === 16
  } catch {
    return false
  }
}

export function parseName(name: string): ParsedName | null {
  if (name === 'fmt/1') return { type: 'fmt' }
  let m = KEYSLOT.exec(name)
  if (m) {
    const slot = m[1] ?? ''
    return isId(slot) ? { type: 'keyslot', slot } : null
  }
  m = SEGMENT.exec(name)
  if (m) {
    const seq = Number(m[4])
    if (seq < 1 || m[3] !== bucket7(seq)) return null
    return { type: 'segment', stag: m[1] ?? '', dtag: m[2] ?? '', seq, r: m[5] ?? '' }
  }
  m = CHECKPOINT.exec(name)
  if (m) {
    const seq = Number(m[3])
    if (seq < 1) return null
    return { type: 'checkpoint', stag: m[1] ?? '', dtag: m[2] ?? '', seq, r: m[4] ?? '' }
  }
  m = BLOB.exec(name)
  if (m) {
    const id = m[3] ?? ''
    if (m[2] !== id.slice(0, 2)) return null
    return m[1] === 'b' ? { type: 'chunk', id } : { type: 'manifest', id }
  }
  m = SECRET.exec(name)
  if (m) {
    const seq = Number(m[2])
    if (seq < 1) return null
    return { type: 'secret', ktag: m[1] ?? '', seq, r: m[3] ?? '' }
  }
  return null
}
