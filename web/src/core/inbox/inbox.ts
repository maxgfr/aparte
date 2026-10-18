/*
 * The share inbox format of spec/FORMAT.md section 16 (contract: web/src/core/contracts/inbox.ts): the inbox key file,
 * the item payload that carries a share, and the sealed item the service worker stores while the vault is locked.
 *
 *   key file  {"format":"aparte/1","type":"inbox-key","vault":…,"key":…,"wrap":{"iv":…,"ct":…}}\n
 *   item      "APX1" 01 000000 || epk (32) || iv (12) || AES-GCM(K, iv, u32be(n) || payload || zeros, aad)
 *             K   = HKDF(X25519(e, P), salt = vaultId || epk || P, info = "aparte/1/inbox")
 *             aad = header (52) || vaultId || P
 *
 * Every parser is strict (a single canonical form) and every secret byte string is zeroed once used. Pure: WebCrypto
 * only, so the service worker runs it as it is.
 */
import {
  type Bytes,
  CorruptError,
  InvalidInputError,
  type Rng,
  TamperedError,
  UnsupportedFormatError,
} from '../contracts/crypto.ts'
import type {
  InboxKeyFile,
  InboxKeyPair,
  InboxRecipient,
  SharedContent,
  SharedFileInfo,
  ShareHeader,
} from '../contracts/inbox.ts'
import {
  base32Decode,
  base32Encode,
  base64urlDecode,
  base64urlEncode,
  concat,
  copy,
  equal,
  fromUtf8,
  isWellFormed,
  readU32be,
  u32be,
  utf8,
  zero,
} from '../crypto/bytes.ts'
import { aesGcmDecrypt, aesGcmEncrypt, hkdfSha256, importAesKey } from '../crypto/keys.ts'
import { paddedSize } from '../crypto/padme.ts'

export const MAX_ITEMS = 32
export const MAX_ITEM_PAYLOAD = 67108864

/** The local record name whose K_local wraps the inbox private key (no local record can have it: section 11.3). */
export const INBOX_WRAP_NAME = 'inbox-key'

const MAGIC = [0x41, 0x50, 0x58, 0x31]
const VERSION = 1
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const ID_BYTES = 16
/** magic (4), version (1), reserved (3), epk (32), iv (12). */
export const ITEM_HEADER_BYTES = 52
const MIN_ITEM_BYTES = ITEM_HEADER_BYTES + 64 + TAG_BYTES
/** The share header is at most 1 MiB of JSON (a long shared text fits). */
const MAX_HEADER_BYTES = 1048576
/** Files in one share at most. */
export const MAX_FILES = 16
const MAX_NAME = 255
const MAX_TYPE = 127
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/

/** PKCS #8 prefix of an X25519 private key (RFC 8410): the 32-byte scalar follows. */
const PKCS8_X25519 = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
])
const X25519 = { name: 'X25519' } as const

const subtle = (): SubtleCrypto => globalThis.crypto.subtle

const keyAad = (vault: string, key: string): Bytes => utf8(`aparte/1|inbox-key|${vault}|${key}`)
const ITEM_INFO = utf8('aparte/1/inbox')

function draw(rng: Rng, n: number, what: string): Bytes {
  const bytes = rng.bytes(n)
  if (bytes.length !== n) throw new InvalidInputError(`The RNG returned ${what} of the wrong length`)
  return bytes
}

/** Imports a 32-byte X25519 scalar as a private key; `extractable` only to read its public key back. */
async function importPrivate(scalar: Uint8Array, extractable: boolean): Promise<CryptoKey> {
  const pkcs8 = concat(PKCS8_X25519, scalar)
  try {
    return await subtle().importKey('pkcs8', pkcs8, X25519, extractable, ['deriveBits'])
  } finally {
    zero(pkcs8)
  }
}

/** The public key of a 32-byte scalar. */
async function publicOf(scalar: Uint8Array): Promise<Bytes> {
  const key = await importPrivate(scalar, true)
  const jwk = await subtle().exportKey('jwk', key)
  if (typeof jwk.x !== 'string') throw new InvalidInputError('X25519 public key unavailable')
  return base64urlDecode(jwk.x)
}

/** X25519(private, public), refusing a public key that yields the all-zero secret (a low-order point). */
async function sharedSecret(privateKey: CryptoKey, publicKey: Uint8Array): Promise<Bytes> {
  let bits: ArrayBuffer
  try {
    const peer = await subtle().importKey('raw', copy(publicKey), X25519, true, [])
    bits = await subtle().deriveBits({ name: 'X25519', public: peer }, privateKey, 256)
  } catch (cause) {
    throw new CorruptError('The X25519 public key is not usable', { cause })
  }
  const secret = new Uint8Array(bits)
  if (secret.every((b) => b === 0)) throw new CorruptError('The X25519 public key is of low order')
  return secret
}

async function itemKey(secret: Uint8Array, vaultId: Uint8Array, epk: Uint8Array, recipient: Uint8Array) {
  const raw = await hkdfSha256(secret, concat(vaultId, epk, recipient), ITEM_INFO)
  try {
    return await importAesKey(raw)
  } finally {
    zero(raw)
  }
}

function requireBytes(bytes: Uint8Array, length: number, what: string): void {
  if (bytes.length !== length) throw new InvalidInputError(`${what} must be ${length} bytes`)
}

// Key file

/** Writer serialization (spec/FORMAT.md section 3.4) plus a final line feed. */
export function serializeInboxKey(file: InboxKeyFile): Bytes {
  const ordered = {
    format: file.format,
    type: file.type,
    vault: file.vault,
    key: file.key,
    wrap: { iv: file.wrap.iv, ct: file.wrap.ct },
  }
  return utf8(`${JSON.stringify(ordered)}\n`)
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function decodeField(text: unknown, length: number, base: 'b32' | 'b64'): Bytes {
  if (typeof text !== 'string') throw new CorruptError('A key file field is not a string')
  let bytes: Bytes
  try {
    bytes = base === 'b32' ? base32Decode(text) : base64urlDecode(text)
  } catch (cause) {
    throw new CorruptError('A key file field does not decode', { cause })
  }
  if (bytes.length !== length) throw new CorruptError('A key file field has the wrong length')
  return bytes
}

export function parseInboxKey(bytes: Uint8Array): InboxKeyFile {
  let value: unknown
  try {
    value = JSON.parse(fromUtf8(bytes))
  } catch (cause) {
    throw new CorruptError('The inbox key file is not JSON', { cause })
  }
  if (!isRecord(value) || !isRecord(value.wrap)) throw new CorruptError('The inbox key file is not an object')
  if (value.type !== 'inbox-key') throw new CorruptError('Not an inbox key file')
  if (value.format !== 'aparte/1') throw new UnsupportedFormatError('An inbox key of another format')
  decodeField(value.vault, ID_BYTES, 'b32')
  decodeField(value.key, KEY_BYTES, 'b64')
  decodeField(value.wrap.iv, IV_BYTES, 'b64')
  decodeField(value.wrap.ct, KEY_BYTES + TAG_BYTES, 'b64')
  const file: InboxKeyFile = {
    format: 'aparte/1',
    type: 'inbox-key',
    vault: value.vault as string,
    key: value.key as string,
    wrap: { iv: value.wrap.iv as string, ct: value.wrap.ct as string },
  }
  // A file is valid only in its canonical form: an extra member, another order or other spacing is corrupt.
  if (!equal(serializeInboxKey(file), bytes)) throw new CorruptError('The inbox key file is not canonical')
  return file
}

export function recipientOf(file: InboxKeyFile): InboxRecipient {
  return { vaultId: decodeField(file.vault, ID_BYTES, 'b32'), publicKey: decodeField(file.key, KEY_BYTES, 'b64') }
}

export async function createInboxKey(input: {
  readonly vaultId: Uint8Array
  readonly wrapKey: CryptoKey
  readonly rng: Rng
}): Promise<{ readonly file: Bytes; readonly pair: InboxKeyPair }> {
  requireBytes(input.vaultId, ID_BYTES, 'A vault id')
  const scalar = draw(input.rng, KEY_BYTES, 'an X25519 scalar')
  try {
    const publicKey = await publicOf(scalar)
    const iv = draw(input.rng, IV_BYTES, 'an IV')
    const vault = base32Encode(input.vaultId)
    const key = base64urlEncode(publicKey)
    const ct = await aesGcmEncrypt(input.wrapKey, iv, scalar, keyAad(vault, key))
    const file = serializeInboxKey({
      format: 'aparte/1',
      type: 'inbox-key',
      vault,
      key,
      wrap: { iv: base64urlEncode(iv), ct: base64urlEncode(ct) },
    })
    const privateKey = await importPrivate(scalar, false)
    return { file, pair: { vaultId: copy(input.vaultId), publicKey, privateKey } }
  } finally {
    zero(scalar)
  }
}

export async function unwrapInboxKey(
  file: InboxKeyFile,
  input: { readonly vaultId: Uint8Array; readonly wrapKey: CryptoKey },
): Promise<InboxKeyPair> {
  const recipient = recipientOf(file)
  if (!equal(recipient.vaultId, input.vaultId)) throw new CorruptError('The inbox key belongs to another vault')
  const iv = decodeField(file.wrap.iv, IV_BYTES, 'b64')
  const ct = decodeField(file.wrap.ct, KEY_BYTES + TAG_BYTES, 'b64')
  const scalar = await aesGcmDecrypt(input.wrapKey, iv, ct, keyAad(file.vault, file.key))
  try {
    // The public key is plaintext anyone on the origin can rewrite: it must be the one of the wrapped scalar.
    if (!equal(await publicOf(scalar), recipient.publicKey)) {
      throw new TamperedError('The inbox public key does not match its private key')
    }
    const privateKey = await importPrivate(scalar, false)
    return { vaultId: recipient.vaultId, publicKey: recipient.publicKey, privateKey }
  } finally {
    zero(scalar)
  }
}

// Item payload

function checkText(value: unknown, what: string, max = Number.POSITIVE_INFINITY): string {
  if (typeof value !== 'string' || value === '' || value.length > max || !isWellFormed(value)) {
    throw new InvalidInputError(`${what} must be non-empty, well-formed text`)
  }
  return value
}

function checkFile(file: unknown): SharedFileInfo {
  if (!isRecord(file)) throw new InvalidInputError('A shared file entry is not an object')
  const name = checkText(file.name, 'A shared file name', MAX_NAME)
  const type = checkText(file.type, 'A shared file type', MAX_TYPE)
  if (!MEDIA_TYPE.test(type)) throw new InvalidInputError('A shared file type is not a lowercase media type')
  const size = file.size
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw new InvalidInputError('A shared file size must be a non-negative integer')
  }
  return { name, type, size }
}

/** The header in writer order, optional members omitted; InvalidInputError when a member breaks a rule. */
function canonicalHeader(header: ShareHeader): ShareHeader {
  if (header.v !== 1) throw new InvalidInputError('A share header has version 1')
  if (!Number.isSafeInteger(header.time) || header.time < 0) throw new InvalidInputError('A share time is a timestamp')
  if (!Array.isArray(header.files) || header.files.length > MAX_FILES) {
    throw new InvalidInputError(`A share holds at most ${MAX_FILES} files`)
  }
  return {
    v: 1,
    time: header.time,
    ...(header.title === undefined ? {} : { title: checkText(header.title, 'A share title') }),
    ...(header.text === undefined ? {} : { text: checkText(header.text, 'A share text') }),
    ...(header.url === undefined ? {} : { url: checkText(header.url, 'A share URL') }),
    files: header.files.map(checkFile),
  }
}

export function encodeShare(content: SharedContent): Bytes {
  const header = canonicalHeader(content.header)
  if (content.files.length !== header.files.length) throw new InvalidInputError('One body per shared file')
  header.files.forEach((f, i) => {
    if (content.files[i]?.length !== f.size) throw new InvalidInputError('A shared file size does not match its bytes')
  })
  const json = utf8(JSON.stringify(header))
  if (json.length > MAX_HEADER_BYTES) throw new InvalidInputError('The share header is above 1 MiB')
  const payload = concat(u32be(json.length), json, ...content.files)
  if (payload.length > MAX_ITEM_PAYLOAD) throw new InvalidInputError('The share is above 64 MiB')
  return payload
}

export function decodeShare(payload: Uint8Array): SharedContent {
  if (payload.length < 4) throw new CorruptError('A share payload is shorter than its length prefix')
  const hlen = readU32be(payload, 0)
  if (hlen < 1 || hlen > MAX_HEADER_BYTES || 4 + hlen > payload.length) {
    throw new CorruptError('A share header length is out of bounds')
  }
  const json = payload.subarray(4, 4 + hlen)
  let header: ShareHeader
  try {
    const value: unknown = JSON.parse(fromUtf8(json))
    if (!isRecord(value)) throw new CorruptError('A share header is not an object')
    header = canonicalHeader(value as unknown as ShareHeader)
  } catch (cause) {
    throw cause instanceof CorruptError ? cause : new CorruptError('A share header breaks the format', { cause })
  }
  if (!equal(utf8(JSON.stringify(header)), json)) throw new CorruptError('A share header is not canonical')
  const body = payload.subarray(4 + hlen)
  const total = header.files.reduce((sum, f) => sum + f.size, 0)
  if (total !== body.length) throw new CorruptError('The shared files do not add up to the payload')
  const files: Bytes[] = []
  let offset = 0
  for (const f of header.files) {
    files.push(copy(body.subarray(offset, offset + f.size)))
    offset += f.size
  }
  return { header, files }
}

// Sealed items

export async function sealItem(recipient: InboxRecipient, payload: Uint8Array, rng: Rng): Promise<Bytes> {
  requireBytes(recipient.vaultId, ID_BYTES, 'A vault id')
  requireBytes(recipient.publicKey, KEY_BYTES, 'An inbox public key')
  if (payload.length > MAX_ITEM_PAYLOAD) throw new InvalidInputError('An item payload is above 2^26 bytes')
  const scalar = draw(rng, KEY_BYTES, 'an X25519 scalar')
  let secret: Bytes | null = null
  const plaintext = new Uint8Array(paddedSize(payload.length))
  try {
    const epk = await publicOf(scalar)
    secret = await sharedSecret(await importPrivate(scalar, false), recipient.publicKey)
    const iv = draw(rng, IV_BYTES, 'an IV')
    const header = concat(new Uint8Array([...MAGIC, VERSION, 0, 0, 0]), epk, iv)
    const key = await itemKey(secret, recipient.vaultId, epk, recipient.publicKey)
    plaintext.set(u32be(payload.length), 0)
    plaintext.set(payload, 4)
    const sealed = await aesGcmEncrypt(key, iv, plaintext, concat(header, recipient.vaultId, recipient.publicKey))
    return concat(header, sealed)
  } finally {
    zero(scalar, secret, plaintext)
  }
}

export async function openItem(pair: InboxKeyPair, bytes: Uint8Array): Promise<Bytes> {
  if (bytes.length < MIN_ITEM_BYTES) throw new CorruptError(`An inbox item is shorter than ${MIN_ITEM_BYTES} bytes`)
  if (MAGIC.some((b, i) => bytes[i] !== b)) throw new CorruptError('Not an APX1 inbox item')
  if (bytes[4] !== VERSION) throw new UnsupportedFormatError(`Inbox item version ${bytes[4]}`)
  if (bytes[5] !== 0 || bytes[6] !== 0 || bytes[7] !== 0) throw new CorruptError('Reserved inbox item bytes are set')
  const header = bytes.subarray(0, ITEM_HEADER_BYTES)
  const epk = bytes.subarray(8, 8 + KEY_BYTES)
  const iv = bytes.subarray(8 + KEY_BYTES, ITEM_HEADER_BYTES)
  const secret = await sharedSecret(pair.privateKey, epk)
  let plaintext: Bytes
  try {
    const key = await itemKey(secret, pair.vaultId, epk, pair.publicKey)
    plaintext = await aesGcmDecrypt(
      key,
      iv,
      bytes.subarray(ITEM_HEADER_BYTES),
      concat(header, pair.vaultId, pair.publicKey),
    )
  } finally {
    zero(secret)
  }
  try {
    const size = plaintext.length
    const n = readU32be(plaintext, 0)
    if (n > size - 4 || n > MAX_ITEM_PAYLOAD) throw new CorruptError('Item payload length beyond the plaintext')
    if (size !== paddedSize(n)) throw new CorruptError('Item plaintext padded to the wrong size')
    for (let i = 4 + n; i < size; i++) if (plaintext[i] !== 0) throw new CorruptError('Non-zero item padding')
    return plaintext.slice(4, 4 + n)
  } finally {
    zero(plaintext)
  }
}

/** A fresh item id: base32 of 16 random bytes. */
export function newItemId(rng: Rng): string {
  return base32Encode(draw(rng, ID_BYTES, 'an id'))
}
