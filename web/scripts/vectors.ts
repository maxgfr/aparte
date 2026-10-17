/*
 * The aparte/1 reference vectors (spec/vectors/README.md). Reads spec/vectors/inputs.json and writes keys.json,
 * keyslots.json, envelopes.json, names.json, padme.json, framing.json and text.json into an output directory (by
 * default spec/vectors). Every value comes from the crypto modules of src/core/crypto with a queued RNG, and every
 * intermediate value the modules keep inside non-extractable keys is recomputed here with raw HKDF and HMAC exactly as
 * spec/FORMAT.md states; the generator refuses to write a file when the two disagree.
 *
 * Usage: bun scripts/vectors.ts [out-dir]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  AparteError,
  type Argon2Module,
  type Bytes,
  type BytesModule,
  type DocId,
  type EnvelopeKind,
  type EnvelopeModule,
  type JsonValue,
  type Keyslot,
  type KeyslotModule,
  type KeysModule,
  type NamesModule,
  type PadmeModule,
  type RecoveryModule,
  type RngModule,
  type SecretKeyModule,
  type Subkeys,
} from '../src/core/contracts/crypto.ts'
import * as argon2Impl from '../src/core/crypto/argon2.ts'
import * as bytesImpl from '../src/core/crypto/bytes.ts'
import * as envelopeImpl from '../src/core/crypto/envelope.ts'
import * as keysImpl from '../src/core/crypto/keys.ts'
import * as keyslotImpl from '../src/core/crypto/keyslot.ts'
import * as namesImpl from '../src/core/crypto/names.ts'
import * as padmeImpl from '../src/core/crypto/padme.ts'
import * as recoveryImpl from '../src/core/crypto/recovery.ts'
import * as rngImpl from '../src/core/crypto/rng.ts'
import * as secretKeyImpl from '../src/core/crypto/secretKey.ts'

const A: Argon2Module = argon2Impl
const B: BytesModule = bytesImpl
const E: EnvelopeModule = envelopeImpl
const K: KeysModule = keysImpl
const KS: KeyslotModule = keyslotImpl
const N: NamesModule = namesImpl
const P: PadmeModule = padmeImpl
const R: RngModule = rngImpl
const RK: RecoveryModule = recoveryImpl
const S: SecretKeyModule = secretKeyImpl

export const VECTORS_DIR = resolve(import.meta.dir, '../../spec/vectors')
export const INPUTS_PATH = resolve(VECTORS_DIR, 'inputs.json')

/** The generated files, in the order of the table of spec/vectors/README.md. */
export const VECTOR_FILES = [
  'keys.json',
  'keyslots.json',
  'envelopes.json',
  'names.json',
  'padme.json',
  'framing.json',
  'text.json',
] as const
export type VectorFile = (typeof VECTOR_FILES)[number]

// The shape of inputs.json (only the members the generator reads).

type DeviceName = 'a' | 'b'

interface SlotCase {
  id: string
  kind: 'passphrase' | 'recovery' | 'passkey'
  passphrase?: 'ascii' | 'unicode'
  secretKey?: boolean
  slotId: string
  salt?: string
  iv: string
  credentialId?: string
  rpId?: string
  prfSalt?: string
  prfOutput?: string
}

interface MaliciousCase {
  id: string
  path: string
  value?: JsonValue
  delete?: boolean
}

interface KeyslotTextCase {
  id: string
  find: string
  replace: string
}

interface EnvelopeCase {
  id: string
  kind: EnvelopeKind
  compression: 'none' | 'precompressed'
  iv: string
  name: string
  payload: string
  deflated?: string
}

interface TamperCase {
  id: string
  op: 'xor' | 'set' | 'append' | 'truncate' | 'open-as' | 'open-with-vault' | 'raw'
  offset?: number
  mask?: string
  value?: string
  length?: number
  name?: string
  vault?: 'otherVaultId'
  iv?: string
  plaintext?: string
  flags?: string
}

interface StreamCase {
  doc: DocId
  device: DeviceName
  seq: number
  payload: string
}

interface SegmentHeaderInput {
  v: number
  doc: string
  device: string
  seq: number
  time: number
  seen: Record<string, number>
  blobs: string[]
  covers?: Record<string, number>
}

export interface VectorInputs {
  format: string
  mk: string
  vaultId: string
  otherVaultId: string
  deviceIds: Record<DeviceName, string>
  argon2: { m: number; t: number; p: number }
  passphrases: { ascii: string; unicode: string; unicodeEquivalent: string; wrong: string }
  secretKey: string
  recoveryKey: string
  keyslots: SlotCase[]
  maliciousKeyslots: { base: string; cases: MaliciousCase[] }
  keyslotTexts: { base: string; cases: KeyslotTextCase[] }
  envelopes: EnvelopeCase[]
  tamper: { base: string; cases: TamperCase[] }
  names: {
    docIds: DocId[]
    convIds: string[]
    segments: StreamCase[]
    checkpoints: StreamCase[]
    chunks: string[]
    manifests: string[]
    secrets: { id: string; seq: number; payload: string }[]
    local: { purpose: string; id: string }[]
  }
  padme: number[]
  framing: {
    segment: { header: SegmentHeaderInput; update: string }
    checkpoint: { header: SegmentHeaderInput; update: string }
    local: { purpose: string; id: string; value: string }
  }
  text: { base32: string[]; base32Invalid: string[]; base64url: string[]; base64urlInvalid: string[] }
}

const SUBKEY_PURPOSES = ['obj-enc', 'obj-name', 'blob-id', 'local-enc', 'local-name', 'check'] as const
type SubkeyPurpose = (typeof SUBKEY_PURPOSES)[number]

const MAGIC = [0x41, 0x50, 0x54, 0x31]

const utf8 = (text: string): Bytes => B.utf8(text)

/** Stops the generation: a vector the formula of the spec disagrees with is never written. */
function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`vectors: ${message}`)
}

function find<T extends { id: string }>(cases: readonly T[], id: string): T {
  const found = cases.find((c) => c.id === id)
  check(found !== undefined, `no case ${id}`)
  return found
}

/** The stable code of the AparteError the call throws; any other outcome stops the generation. */
async function errorOf(label: string, run: () => unknown): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof AparteError) return error.code
    throw error
  }
  throw new Error(`vectors: ${label} was expected to be rejected`)
}

/** Bytewise order of the UTF-8 encodings, as spec/FORMAT.md section 9.1 sorts `seen`, `covers` and `blobs`. */
function bytewise(a: string, b: string): number {
  const x = utf8(a)
  const y = utf8(b)
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return x.length - y.length
}

function sortedRecord(record: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(
    Object.keys(record)
      .sort(bytewise)
      .map((key) => [key, record[key] as number]),
  )
}

/** The raw bytes behind the non-extractable keys of one vault, from the formulas of spec/FORMAT.md section 5. */
interface RawKeys {
  readonly vaultId: Bytes
  readonly subkeys: Readonly<Record<SubkeyPurpose, Bytes>>
  objectKey(name: string): Promise<Bytes>
  localKey(name: string): Promise<Bytes>
}

async function rawKeys(mk: Bytes, vaultId: Bytes): Promise<RawKeys> {
  const salt = B.concat(utf8('aparte/1/vault'), vaultId)
  const entries = await Promise.all(
    SUBKEY_PURPOSES.map(async (purpose) => [purpose, await K.hkdfSha256(mk, salt, utf8(`aparte/1/${purpose}`))]),
  )
  const subkeys = Object.fromEntries(entries) as Record<SubkeyPurpose, Bytes>
  return {
    vaultId,
    subkeys,
    objectKey: (name) => K.hkdfSha256(subkeys['obj-enc'], vaultId, utf8(`aparte/1/obj|${name}`)),
    localKey: (name) => K.hkdfSha256(subkeys['local-enc'], vaultId, utf8(`aparte/1/local|${name}`)),
  }
}

interface Context {
  readonly inputs: VectorInputs
  readonly mk: Bytes
  readonly vaultId: Bytes
  readonly subkeys: Subkeys
  readonly raw: RawKeys
}

// keys.json

async function keysVectors(ctx: Context, localNames: readonly string[]) {
  const { raw, subkeys, inputs } = ctx
  const mkCheck = await K.masterKeyCheck(subkeys)
  const expected = await K.hmacSha256(raw.subkeys.check, B.concat(utf8('aparte/1/check|'), ctx.vaultId))
  check(B.equal(mkCheck, expected), 'masterKeyCheck differs from HMAC(K_check, "aparte/1/check|" || vaultId)')

  const objectKeys = []
  for (const c of inputs.envelopes) {
    if (c.kind !== 6) objectKeys.push({ name: c.name, key: await raw.objectKey(c.name) })
  }
  const localKeys = []
  for (const name of [...inputs.envelopes.filter((c) => c.kind === 6).map((c) => c.name), ...localNames]) {
    localKeys.push({ name, key: await raw.localKey(name) })
  }
  return {
    mk: ctx.mk,
    vaultId: ctx.vaultId,
    vault: B.base32Encode(ctx.vaultId),
    subkeys: raw.subkeys,
    mkCheck,
    objectKeys,
    localKeys,
  }
}

// keyslots.json

async function createSlot(ctx: Context, c: SlotCase): Promise<Keyslot> {
  const { inputs, mk, vaultId } = ctx
  const rng = R.queueRng(
    c.kind === 'passphrase'
      ? [B.fromHex(c.slotId), B.fromHex(c.salt ?? ''), B.fromHex(c.iv)]
      : [B.fromHex(c.slotId), B.fromHex(c.iv)],
  )
  let slot: Keyslot
  if (c.kind === 'passphrase') {
    slot = await KS.createKeyslot(
      {
        kind: 'passphrase',
        mk,
        vaultId,
        passphrase: inputs.passphrases[c.passphrase ?? 'ascii'],
        secretKey: c.secretKey ? B.fromHex(inputs.secretKey) : null,
        argon2: inputs.argon2,
      },
      { rng },
    )
  } else if (c.kind === 'recovery') {
    slot = await KS.createKeyslot(
      { kind: 'recovery', mk, vaultId, recoveryKey: B.fromHex(inputs.recoveryKey) },
      { rng },
    )
  } else {
    slot = await KS.createKeyslot(
      {
        kind: 'passkey',
        mk,
        vaultId,
        prfOutput: B.fromHex(c.prfOutput ?? ''),
        credentialId: B.fromHex(c.credentialId ?? ''),
        rpId: c.rpId ?? '',
        prfSalt: B.fromHex(c.prfSalt ?? ''),
      },
      { rng },
    )
  }
  check(rng.remaining() === 0, `keyslot ${c.id} did not draw every queued value`)
  return slot
}

async function slotVector(ctx: Context, c: SlotCase, slot: Keyslot) {
  const { inputs, mk, vaultId } = ctx
  const slotId = B.fromHex(c.slotId)
  const salt = c.kind === 'passphrase' ? B.fromHex(c.salt ?? '') : null
  let argon2: Bytes | null = null
  let ikm: Bytes
  if (c.kind === 'passphrase') {
    argon2 = await A.argon2id({
      password: KS.normalizePassphrase(inputs.passphrases[c.passphrase ?? 'ascii']),
      salt: salt ?? new Uint8Array(),
      ...inputs.argon2,
      length: 32,
    })
    ikm = c.secretKey ? B.concat(argon2, B.fromHex(inputs.secretKey)) : argon2
  } else if (c.kind === 'recovery') {
    ikm = B.fromHex(inputs.recoveryKey)
  } else {
    ikm = B.fromHex(c.prfOutput ?? '')
  }
  const kek = await K.hkdfSha256(ikm, B.concat(vaultId, slotId), utf8(`aparte/1/kek|${c.kind}`))
  const kWrap = await K.hkdfSha256(kek, vaultId, utf8('aparte/1/wrap'))
  const kCommit = await K.hkdfSha256(kek, vaultId, utf8('aparte/1/commit'))
  const commit = await K.hmacSha256(kCommit, B.concat(utf8('aparte/1/commit|'), vaultId, slotId))
  const aad = KS.keyslotAad(slot)
  const wrapCt = B.base64urlDecode(slot.wrap.ct)
  const file = KS.serializeKeyslot(slot)
  const name = N.keyslotName(slotId)

  check(
    B.equal(KS.serializeKeyslot(KS.parseKeyslot(file, { name })), file),
    `keyslot ${c.id}: the file does not parse back to itself under ${name}`,
  )
  check(slot.slot === B.base32Encode(slotId), `keyslot ${c.id}: slot is not the base32 of slotId`)
  check(B.equal(B.base64urlDecode(slot.commit), commit), `keyslot ${c.id}: commit differs from the formula`)
  check(B.equal(B.base64urlDecode(slot.wrap.iv), B.fromHex(c.iv)), `keyslot ${c.id}: wrap.iv is not the queued IV`)
  const canon = B.canonicalJson(slot.kdf as unknown as JsonValue)
  check(
    B.equal(aad, utf8(`aparte/1|keyslot|${slot.vault}|${slot.slot}|${c.kind}|${canon}`)),
    `keyslot ${c.id}: aad differs from the formula`,
  )
  check(B.equal(await K.aesGcmDecrypt(kWrap, B.fromHex(c.iv), wrapCt, aad), mk), `keyslot ${c.id}: wrap is not MK`)

  return {
    id: c.id,
    kind: c.kind,
    slotId,
    ...(salt ? { salt } : {}),
    iv: B.fromHex(c.iv),
    name,
    ...(argon2 ? { argon2 } : {}),
    ikm,
    kek,
    kWrap,
    kCommit,
    commit,
    aad,
    wrapCt,
    mkCheck: B.base64urlDecode(slot.mkCheck),
    file,
  }
}

/** The base file with one member set in place, removed, or appended last (inputs.json maliciousKeyslots). */
function maliciousFile(base: Bytes, c: MaliciousCase): Bytes {
  const object = JSON.parse(B.fromUtf8(base)) as Record<string, unknown>
  const path = c.path.split('.')
  const last = path.pop() as string
  let target = object
  for (const key of path) target = target[key] as Record<string, unknown>
  if (c.delete) delete target[last]
  else target[last] = c.value
  return utf8(`${JSON.stringify(object)}\n`)
}

async function keyslotsVectors(ctx: Context) {
  const { inputs } = ctx
  const slots = new Map<string, Keyslot>()
  const keyslots = []
  for (const c of inputs.keyslots) {
    const slot = await createSlot(ctx, c)
    slots.set(c.id, slot)
    keyslots.push(await slotVector(ctx, c, slot))
  }

  const base = slots.get(inputs.maliciousKeyslots.base)
  check(base !== undefined, `no keyslot ${inputs.maliciousKeyslots.base}`)
  const baseFile = KS.serializeKeyslot(base)
  const malicious = []
  for (const c of inputs.maliciousKeyslots.cases) {
    const file = maliciousFile(baseFile, c)
    malicious.push({ id: c.id, file, error: await errorOf(`malicious keyslot ${c.id}`, () => KS.parseKeyslot(file)) })
  }

  const textBase = slots.get(inputs.keyslotTexts.base)
  check(textBase !== undefined, `no keyslot ${inputs.keyslotTexts.base}`)
  const baseText = B.fromUtf8(KS.serializeKeyslot(textBase))
  const texts = []
  for (const c of inputs.keyslotTexts.cases) {
    check(baseText.includes(c.find), `keyslot text ${c.id}: the base file has no ${c.find}`)
    const file = utf8(baseText.replace(c.find, () => c.replace))
    texts.push({ id: c.id, file, error: await errorOf(`keyslot text ${c.id}`, () => KS.parseKeyslot(file)) })
  }

  return {
    keyslots,
    secretKeyText: await S.formatSecretKey(B.fromHex(inputs.secretKey)),
    recoveryKeyText: RK.formatRecoveryKey(B.fromHex(inputs.recoveryKey)),
    malicious,
    texts,
  }
}

// envelopes.json

function seal(ctx: Context, c: EnvelopeCase): Promise<Bytes> {
  const precompressed = c.compression === 'precompressed'
  return E.sealEnvelope(
    ctx.subkeys,
    {
      kind: c.kind,
      name: c.name,
      payload: B.fromHex(precompressed ? (c.deflated ?? '') : c.payload),
      compression: c.compression,
    },
    R.queueRng([B.fromHex(c.iv)]),
  )
}

const aadOf = (header: Uint8Array, vaultId: Uint8Array, name: string): Bytes => B.concat(header, vaultId, utf8(name))

async function envelopeVector(ctx: Context, c: EnvelopeCase) {
  const sealed = await seal(ctx, c)
  const header = sealed.slice(0, 20)
  const aad = aadOf(header, ctx.vaultId, c.name)
  const key = c.kind === 6 ? await ctx.raw.localKey(c.name) : await ctx.raw.objectKey(c.name)
  const plaintext = await K.aesGcmDecrypt(key, header.subarray(8, 20), sealed.subarray(20), aad)
  const stored = B.fromHex(c.compression === 'precompressed' ? (c.deflated ?? '') : c.payload)

  check(B.equal(header.subarray(8, 20), B.fromHex(c.iv)), `envelope ${c.id}: the IV is not the queued one`)
  check(plaintext.length === P.paddedSize(stored.length), `envelope ${c.id}: plaintext size is not the padded size`)
  check(B.readU32be(plaintext, 0) === stored.length, `envelope ${c.id}: the length prefix differs`)
  check(B.equal(plaintext.subarray(4, 4 + stored.length), stored), `envelope ${c.id}: the stored payload differs`)
  check(
    plaintext.subarray(4 + stored.length).every((b) => b === 0),
    `envelope ${c.id}: the padding is not zero`,
  )
  const payload = await E.openEnvelope(ctx.subkeys, { kind: c.kind, name: c.name, bytes: sealed })
  check(B.toHex(payload) === c.payload, `envelope ${c.id}: opening does not return the payload`)

  return { id: c.id, kind: c.kind, compression: c.compression, name: c.name, header, aad, plaintext, sealed, payload }
}

async function tamperVector(ctx: Context, base: EnvelopeCase, sealed: Bytes, t: TamperCase) {
  let bytes: Bytes = sealed.slice()
  let name = base.name
  let vaultId = ctx.vaultId
  let subkeys = ctx.subkeys
  const at = (offset: number) => (offset < 0 ? bytes.length + offset : offset)
  switch (t.op) {
    case 'xor': {
      const i = at(t.offset ?? 0)
      bytes[i] = (bytes[i] ?? 0) ^ (B.fromHex(t.mask ?? '00')[0] ?? 0)
      break
    }
    case 'set':
      bytes[at(t.offset ?? 0)] = B.fromHex(t.value ?? '00')[0] ?? 0
      break
    case 'append':
      bytes = B.concat(bytes, B.fromHex(t.value ?? ''))
      break
    case 'truncate': {
      const length = t.length ?? 0
      bytes = bytes.slice(0, length < 0 ? bytes.length + length : length)
      break
    }
    case 'open-as':
      name = t.name ?? ''
      break
    case 'open-with-vault':
      vaultId = B.fromHex(ctx.inputs[t.vault ?? 'otherVaultId'])
      subkeys = await K.deriveSubkeys(ctx.mk, vaultId)
      break
    case 'raw': {
      // A validly encrypted envelope around a plaintext the writer would never produce.
      const iv = B.fromHex(t.iv ?? '')
      const header = B.concat(new Uint8Array([...MAGIC, 1, base.kind, Number.parseInt(t.flags ?? '00', 16), 0]), iv)
      const ct = await K.aesGcmEncrypt(
        await ctx.raw.objectKey(base.name),
        iv,
        B.fromHex(t.plaintext ?? ''),
        aadOf(header, ctx.vaultId, base.name),
      )
      bytes = B.concat(header, ct)
      break
    }
  }
  const error = await errorOf(`tamper ${t.id}`, () => E.openEnvelope(subkeys, { kind: base.kind, name, bytes }))
  return { id: t.id, kind: base.kind, name, vaultId, bytes, error }
}

async function envelopesVectors(ctx: Context) {
  const envelopes = []
  for (const c of ctx.inputs.envelopes) envelopes.push(await envelopeVector(ctx, c))
  const base = find(ctx.inputs.envelopes, ctx.inputs.tamper.base)
  const sealed = await seal(ctx, base)
  const tamper = []
  for (const t of ctx.inputs.tamper.cases) tamper.push(await tamperVector(ctx, base, sealed, t))
  return { envelopes, tamper }
}

// names.json

async function namesVectors(ctx: Context) {
  const { inputs, subkeys } = ctx
  const device = (d: DeviceName) => B.fromHex(inputs.deviceIds[d])
  const stream = (c: StreamCase) => ({
    docId: c.doc,
    deviceId: device(c.device),
    seq: c.seq,
    payload: B.fromHex(c.payload),
  })

  const devices = []
  for (const d of ['a', 'b'] as const) {
    devices.push({ device: d, deviceId: device(d), dtag: await N.deviceTag(subkeys, device(d)) })
  }
  const docs = []
  for (const docId of inputs.names.docIds) docs.push({ docId, stag: await N.docTag(subkeys, docId) })
  const shards = []
  for (const hex of inputs.names.convIds) {
    shards.push({ convId: B.fromHex(hex), shard: await N.shardOf(subkeys, B.fromHex(hex)) })
  }
  const segments = []
  for (const c of inputs.names.segments) {
    const name = await N.segmentName(subkeys, stream(c))
    check(N.parseName(name)?.type === 'segment', `segment name ${name} does not parse`)
    segments.push({ doc: c.doc, device: c.device, seq: c.seq, name })
  }
  const checkpoints = []
  for (const c of inputs.names.checkpoints) {
    const name = await N.checkpointName(subkeys, stream(c))
    check(N.parseName(name)?.type === 'checkpoint', `checkpoint name ${name} does not parse`)
    checkpoints.push({ doc: c.doc, device: c.device, seq: c.seq, name })
  }
  const chunks = []
  for (const hex of inputs.names.chunks) {
    const id = await N.chunkId(subkeys, B.fromHex(hex))
    chunks.push({ id, name: N.chunkName(id) })
  }
  const manifests = []
  for (const text of inputs.names.manifests) {
    const id = await N.manifestId(subkeys, utf8(text))
    manifests.push({ id, name: N.manifestName(id) })
  }
  const secrets = []
  for (const s of inputs.names.secrets) {
    const secretId = B.fromHex(s.id)
    secrets.push({
      secretId,
      seq: s.seq,
      ktag: await N.secretTag(subkeys, secretId),
      name: await N.secretVersionName(subkeys, { secretId, seq: s.seq, payload: B.fromHex(s.payload) }),
    })
  }
  const local = []
  for (const l of inputs.names.local) {
    local.push({ purpose: l.purpose, id: l.id, name: await N.localName(subkeys, l.purpose, l.id) })
  }
  return { devices, docs, shards, segments, checkpoints, chunks, manifests, secrets, local }
}

// padme.json

function padmeVectors(inputs: VectorInputs) {
  return {
    padme: inputs.padme.map((length) => ({ length, padme: P.padme(length), paddedSize: P.paddedSize(length) })),
  }
}

// framing.json

/** The header of spec/FORMAT.md section 9.1 (and 9.2 with `covers`) in writer order. */
function streamHeader(h: SegmentHeaderInput): Bytes {
  const header: Record<string, JsonValue> = {
    v: h.v,
    doc: h.doc,
    device: h.device,
    seq: h.seq,
    time: h.time,
    seen: sortedRecord(h.seen),
    blobs: [...h.blobs].sort(bytewise),
  }
  if (h.covers) header.covers = sortedRecord(h.covers)
  return utf8(JSON.stringify(header))
}

function streamPayload(input: { header: SegmentHeaderInput; update: string }) {
  const header = streamHeader(input.header)
  const update = B.fromHex(input.update)
  check(header.length >= 1 && header.length <= 65536, 'a segment header is 1 to 65536 bytes')
  check(update.length > 0, 'a segment update is not empty')
  return { header, payload: B.concat(B.u32be(header.length), header, update) }
}

async function framingVectors(ctx: Context) {
  const { local } = ctx.inputs.framing
  const purpose = utf8(local.purpose)
  const id = utf8(local.id)
  check(/^[a-z][a-z0-9-]{0,31}$/.test(local.purpose), 'a local record purpose matches [a-z][a-z0-9-]{0,31}')
  check(id.length <= 1024, 'a local record id is at most 1024 bytes')
  return {
    segment: streamPayload(ctx.inputs.framing.segment),
    checkpoint: streamPayload(ctx.inputs.framing.checkpoint),
    local: {
      purpose: local.purpose,
      id: local.id,
      name: await N.localName(ctx.subkeys, local.purpose, local.id),
      payload: B.concat(
        new Uint8Array([purpose.length]),
        purpose,
        new Uint8Array([id.length >> 8, id.length & 0xff]),
        id,
        B.fromHex(local.value),
      ),
    },
  }
}

// text.json

async function textVectors(inputs: VectorInputs) {
  const roundTrip = (encode: (b: Uint8Array) => string, decode: (t: string) => Bytes) => (hex: string) => {
    const text = encode(B.fromHex(hex))
    check(B.toHex(decode(text)) === hex, `text sample ${hex} does not round trip`)
    return { hex: B.fromHex(hex), text }
  }
  const invalid = async (decode: (t: string) => Bytes, samples: readonly string[]) => {
    const out = []
    for (const text of samples) out.push({ text, error: await errorOf(`decoding ${text}`, () => decode(text)) })
    return out
  }
  return {
    base32: inputs.text.base32.map(roundTrip(B.base32Encode, B.base32Decode)),
    base32Invalid: await invalid(B.base32Decode, inputs.text.base32Invalid),
    base64url: inputs.text.base64url.map(roundTrip(B.base64urlEncode, B.base64urlDecode)),
    base64urlInvalid: await invalid(B.base64urlDecode, inputs.text.base64urlInvalid),
  }
}

/** JSON with 2-space indentation and a final line feed, byte strings as lowercase hex. */
export function stringifyVector(value: unknown): string {
  return `${JSON.stringify(value, (_, v: unknown) => (v instanceof Uint8Array ? B.toHex(v) : v), 2)}\n`
}

/** Computes the content of every generated file, byte strings still as bytes. */
export async function computeVectors(inputs: VectorInputs) {
  check(inputs.format === 'aparte/1', `inputs of format ${inputs.format}`)
  const mk = B.fromHex(inputs.mk)
  const vaultId = B.fromHex(inputs.vaultId)
  const ctx: Context = {
    inputs,
    mk,
    vaultId,
    subkeys: await K.deriveSubkeys(mk, vaultId),
    raw: await rawKeys(mk, vaultId),
  }
  const names = await namesVectors(ctx)
  return {
    'keys.json': await keysVectors(
      ctx,
      names.local.map((l) => l.name),
    ),
    'keyslots.json': await keyslotsVectors(ctx),
    'envelopes.json': await envelopesVectors(ctx),
    'names.json': names,
    'padme.json': padmeVectors(inputs),
    'framing.json': await framingVectors(ctx),
    'text.json': await textVectors(inputs),
  } satisfies Record<VectorFile, unknown>
}

export type Vectors = Awaited<ReturnType<typeof computeVectors>>

/** The file texts by name, in VECTOR_FILES order. */
export function serializeVectors(vectors: Vectors): Record<VectorFile, string> {
  return Object.fromEntries(VECTOR_FILES.map((file) => [file, stringifyVector(vectors[file])])) as Record<
    VectorFile,
    string
  >
}

export async function generateVectors(inputs: VectorInputs): Promise<Record<VectorFile, string>> {
  return serializeVectors(await computeVectors(inputs))
}

export async function readInputs(path = INPUTS_PATH): Promise<VectorInputs> {
  return (await Bun.file(path).json()) as VectorInputs
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length > 1 || args[0]?.startsWith('-')) {
    console.error('usage: bun scripts/vectors.ts [out-dir]')
    process.exit(2)
  }
  const out = resolve(args[0] ?? VECTORS_DIR)
  const files = await generateVectors(await readInputs())
  await mkdir(out, { recursive: true })
  for (const file of VECTOR_FILES) await writeFile(resolve(out, file), files[file])
  console.log(`vectors: wrote ${VECTOR_FILES.length} files to ${out}`)
}
