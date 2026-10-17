/*
 * WebCrypto primitives and the key schedule of spec/FORMAT.md section 5. Every key this module returns is a
 * non-extractable CryptoKey; raw key bytes are only ever imported, and every transient copy is zeroed once imported.
 */
import { type Bytes, InvalidInputError, type Subkeys, TamperedError } from '../contracts/crypto.ts'
import { concat, copy, utf8, zero } from './bytes.ts'

const subtle = (): SubtleCrypto => globalThis.crypto.subtle

const HMAC_SHA256: HmacImportParams = { name: 'HMAC', hash: 'SHA-256' }
const AES_GCM_256: AesKeyAlgorithm = { name: 'AES-GCM', length: 256 }

/** HKDF-SHA-256 outputs at most 255 blocks of 32 bytes (RFC 5869). */
const HKDF_MAX = 255 * 32

/**
 * `data` as a BufferSource WebCrypto accepts. Inputs may be backed by a SharedArrayBuffer, which WebCrypto refuses;
 * those are copied, and the second element says whether the caller must zero that copy.
 */
function source(data: Uint8Array): [Bytes, boolean] {
  if (data.buffer instanceof ArrayBuffer) return [data as Bytes, false]
  return [copy(data), true]
}

/** Runs `use` on a WebCrypto-ready view of `data`, zeroing any copy made for it. */
async function withSource<T>(data: Uint8Array, use: (bytes: Bytes) => Promise<T>): Promise<T> {
  const [bytes, copied] = source(data)
  try {
    return await use(bytes)
  } finally {
    if (copied) zero(bytes)
  }
}

function requireLength(bytes: Uint8Array, length: number, what: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new InvalidInputError(`${what} must be ${length} bytes`)
  }
}

export async function sha256(data: Uint8Array): Promise<Bytes> {
  return withSource(data, async (bytes) => new Uint8Array(await subtle().digest('SHA-256', bytes)))
}

/** Imports raw bytes as a non-extractable HMAC-SHA-256 key that can only sign. */
export function importHmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return withSource(raw, (bytes) => subtle().importKey('raw', bytes, HMAC_SHA256, false, ['sign']))
}

/** Imports raw bytes as a non-extractable HKDF key, for deriveBits and deriveKey. */
export function importHkdfKey(raw: Uint8Array): Promise<CryptoKey> {
  return withSource(raw, (bytes) => subtle().importKey('raw', bytes, 'HKDF', false, ['deriveBits', 'deriveKey']))
}

/** Imports 32 raw bytes as a non-extractable AES-256-GCM key. */
export function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  requireLength(raw, 32, 'An AES-256 key')
  return withSource(raw, (bytes) => subtle().importKey('raw', bytes, AES_GCM_256, false, ['encrypt', 'decrypt']))
}

export async function hmacSha256(key: Uint8Array | CryptoKey, data: Uint8Array): Promise<Bytes> {
  const cryptoKey = key instanceof Uint8Array ? await importHmacKey(key) : key
  return withSource(data, async (bytes) => new Uint8Array(await subtle().sign('HMAC', cryptoKey, bytes)))
}

function hkdfParams(salt: Uint8Array, info: Uint8Array): HkdfParams {
  return { name: 'HKDF', hash: 'SHA-256', salt: copy(salt), info: copy(info) }
}

/** HKDF bytes from an HKDF CryptoKey. */
export async function hkdfBits(ikm: CryptoKey, salt: Uint8Array, info: Uint8Array, length = 32): Promise<Bytes> {
  if (!Number.isInteger(length) || length < 1 || length > HKDF_MAX) {
    throw new InvalidInputError(`HKDF length must be 1 to ${HKDF_MAX} bytes`)
  }
  return new Uint8Array(await subtle().deriveBits(hkdfParams(salt, info), ikm, length * 8))
}

export async function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length = 32): Promise<Bytes> {
  return hkdfBits(await importHkdfKey(ikm), salt, info, length)
}

/** HKDF(ikm, salt, info) imported directly as a non-extractable HMAC-SHA-256 key: the 32 bytes never surface. */
export function hkdfHmacKey(ikm: CryptoKey, salt: Uint8Array, info: Uint8Array): Promise<CryptoKey> {
  return subtle().deriveKey(hkdfParams(salt, info), ikm, { ...HMAC_SHA256, length: 256 }, false, ['sign'])
}

/** HKDF(ikm, salt, info) imported directly as a non-extractable AES-256-GCM key. */
export function hkdfAesKey(ikm: CryptoKey, salt: Uint8Array, info: Uint8Array): Promise<CryptoKey> {
  return subtle().deriveKey(hkdfParams(salt, info), ikm, AES_GCM_256, false, ['encrypt', 'decrypt'])
}

/**
 * HKDF(ikm, salt, info) as a non-extractable HKDF key. WebCrypto cannot deriveKey an HKDF key (its length is
 * undefined), so the 32 bytes are derived, imported and zeroed (spec/FORMAT.md section 5.2).
 */
export async function hkdfHkdfKey(ikm: CryptoKey, salt: Uint8Array, info: Uint8Array): Promise<CryptoKey> {
  const raw = await hkdfBits(ikm, salt, info)
  try {
    return await importHkdfKey(raw)
  } finally {
    zero(raw)
  }
}

function gcmParams(iv: Uint8Array, aad: Uint8Array): AesGcmParams {
  requireLength(iv, 12, 'An AES-GCM IV')
  return { name: 'AES-GCM', iv: copy(iv), additionalData: copy(aad), tagLength: 128 }
}

export async function aesGcmEncrypt(
  key: Uint8Array | CryptoKey,
  iv: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Bytes> {
  const params = gcmParams(iv, aad)
  const cryptoKey = key instanceof Uint8Array ? await importAesKey(key) : key
  return withSource(plaintext, async (bytes) => new Uint8Array(await subtle().encrypt(params, cryptoKey, bytes)))
}

export async function aesGcmDecrypt(
  key: Uint8Array | CryptoKey,
  iv: Uint8Array,
  sealed: Uint8Array,
  aad: Uint8Array,
): Promise<Bytes> {
  const params = gcmParams(iv, aad)
  const cryptoKey = key instanceof Uint8Array ? await importAesKey(key) : key
  if (sealed.length < 16) throw new TamperedError('AES-GCM input shorter than its tag')
  try {
    return await withSource(sealed, async (bytes) => new Uint8Array(await subtle().decrypt(params, cryptoKey, bytes)))
  } catch (cause) {
    throw new TamperedError('AES-GCM tag does not verify', { cause })
  }
}

const VAULT_SALT = utf8('aparte/1/vault')

/** HKDF(ikm = MK, salt = "aparte/1/vault" || vaultId, info = "aparte/1/" || purpose), spec/FORMAT.md section 5.2. */
function subkeyInfo(purpose: string): Bytes {
  return utf8(`aparte/1/${purpose}`)
}

export async function deriveSubkeys(mk: Uint8Array, vaultId: Uint8Array): Promise<Subkeys> {
  requireLength(mk, 32, 'The master key')
  requireLength(vaultId, 16, 'The vault id')
  const master = await importHkdfKey(mk)
  const salt = concat(VAULT_SALT, vaultId)
  const hmac = (purpose: string) => hkdfHmacKey(master, salt, subkeyInfo(purpose))
  const hkdf = (purpose: string) => hkdfHkdfKey(master, salt, subkeyInfo(purpose))
  const [objEnc, objName, blobId, localEnc, localName, check] = await Promise.all([
    hkdf('obj-enc'),
    hmac('obj-name'),
    hmac('blob-id'),
    hkdf('local-enc'),
    hmac('local-name'),
    hmac('check'),
  ])
  return { vaultId: copy(vaultId), objEnc, objName, blobId, localEnc, localName, check }
}

/** Names are ASCII by construction (spec/FORMAT.md sections 8 and 11.3); anything else is a caller bug. */
const ASCII_NAME = /^[\x21-\x7e]+$/

export function nameBytes(name: string): Bytes {
  if (!ASCII_NAME.test(name)) throw new InvalidInputError('An object or record name must be printable ASCII')
  return utf8(name)
}

export function objectKey(subkeys: Subkeys, name: string): Promise<CryptoKey> {
  return hkdfAesKey(subkeys.objEnc, subkeys.vaultId, concat(utf8('aparte/1/obj|'), nameBytes(name)))
}

export function localKey(subkeys: Subkeys, localName: string): Promise<CryptoKey> {
  return hkdfAesKey(subkeys.localEnc, subkeys.vaultId, concat(utf8('aparte/1/local|'), nameBytes(localName)))
}

export function masterKeyCheck(subkeys: Subkeys): Promise<Bytes> {
  return hmacSha256(subkeys.check, concat(utf8('aparte/1/check|'), subkeys.vaultId))
}
