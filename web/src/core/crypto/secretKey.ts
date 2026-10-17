/*
 * The Secret Key and its Emergency Kit text (spec/FORMAT.md section 6.8): `A1-` and 30 base32 characters carrying the
 * 128 key bits and the first 22 bits of C = SHA-256("aparte/1/secret-key|" || SK)[0..3].
 */
import { type Bytes, InvalidInputError, type Rng } from '../contracts/crypto.ts'
import { base32Encode, concat, equal, utf8 } from './bytes.ts'
import { sha256 } from './keys.ts'

const LENGTH = 16
const PREFIX = 'A1'
const CHARS = 30
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const CHECKSUM_LABEL = utf8('aparte/1/secret-key|')
/** What a parser accepts once spaces and hyphens are gone: ASCII only, so no case mapping can produce a letter. */
const TEXT = /^[Aa]1[A-Za-z2-7]{30}$/

function requireKey(secretKey: Uint8Array): void {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== LENGTH) {
    throw new InvalidInputError(`A Secret Key is ${LENGTH} bytes`)
  }
}

async function checksum(secretKey: Uint8Array): Promise<Bytes> {
  return (await sha256(concat(CHECKSUM_LABEL, secretKey))).slice(0, 3)
}

export function generateSecretKey(rng: Rng): Bytes {
  const key = rng.bytes(LENGTH)
  requireKey(key)
  return key
}

export async function formatSecretKey(secretKey: Uint8Array): Promise<string> {
  requireKey(secretKey)
  const s = base32Encode(concat(secretKey, await checksum(secretKey)))
    .slice(0, CHARS)
    .toUpperCase()
  const groups = [0, 5, 10, 15, 20, 25].map((i) => s.slice(i, i + 5))
  return `${PREFIX}-${groups.join('-')}`
}

export async function parseSecretKey(text: string): Promise<Bytes> {
  const compact = typeof text === 'string' ? text.replace(/[ -]/g, '') : ''
  if (!TEXT.test(compact)) throw new InvalidInputError('Not a Secret Key')
  // 30 characters are 150 bits: the 128 key bits, then the first 22 bits of the checksum.
  let bits = 0n
  for (const c of compact.slice(2).toLowerCase()) bits = (bits << 5n) | BigInt(ALPHABET.indexOf(c))
  const key = new Uint8Array(LENGTH)
  let rest = bits >> 22n
  for (let i = LENGTH - 1; i >= 0; i--) {
    key[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  const typed = Number(bits & 0x3fffffn)
  const c = await checksum(key)
  const expected = (((c[0] ?? 0) << 16) | ((c[1] ?? 0) << 8) | (c[2] ?? 0)) >>> 2
  const pack = (n: number) => new Uint8Array([(n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
  if (!equal(pack(typed), pack(expected))) throw new InvalidInputError('The Secret Key checksum does not match')
  return key
}
