/*
 * The envelope of spec/FORMAT.md section 7: `header (20) || AES-GCM(key, iv, u32be(n) || payload' || zeros, aad)`,
 * with `aad = header || vaultId || name`. Opening runs the checks of section 7.5 in their order, so the error tells
 * which step failed; steps 8 to 11 run on authenticated plaintext and make it canonical.
 */
import {
  type Bytes,
  CorruptError,
  type EnvelopeHeader,
  type EnvelopeKind,
  InvalidInputError,
  type OpenInput,
  type Rng,
  type SealInput,
  type Subkeys,
  UnsupportedFormatError,
} from '../contracts/crypto.ts'
import { concat, copy, readU32be, u32be, zero } from './bytes.ts'
import { aesGcmDecrypt, aesGcmEncrypt, localKey, nameBytes, objectKey } from './keys.ts'
import { paddedSize } from './padme.ts'

const MAGIC = [0x41, 0x50, 0x54, 0x31]
const VERSION = 1
const EPOCH = 0
const HEADER_LENGTH = 20
const IV_LENGTH = 12
const TAG_LENGTH = 16
/** Header, the 64-byte minimum plaintext and the tag. */
const MIN_LENGTH = HEADER_LENGTH + 64 + TAG_LENGTH
const FLAG_DEFLATE = 0x01
/** n, and the inflated size of a compressed payload, are at most 2^26 bytes. */
export const MAX_PAYLOAD = 2 ** 26
/** A blob chunk carries at most 2 MiB of a file (spec/FORMAT.md section 8.6). */
export const MAX_CHUNK = 2_097_152

const isKind = (kind: number): kind is EnvelopeKind => Number.isInteger(kind) && kind >= 1 && kind <= 6
const compressible = (kind: EnvelopeKind): boolean => kind === 1 || kind === 2

/** Steps 1 to 6 of section 7.5; `expected`, when given, is checked at step 4. */
function checkHeader(bytes: Uint8Array, expected?: EnvelopeKind): EnvelopeHeader {
  if (bytes.length < MIN_LENGTH) throw new CorruptError('Envelope shorter than 100 bytes')
  if (MAGIC.some((b, i) => bytes[i] !== b)) throw new CorruptError('Not an APT1 envelope')
  if (bytes[4] !== VERSION) throw new UnsupportedFormatError(`Envelope version ${bytes[4]}`)
  const kind = bytes[5] ?? 0
  if (!isKind(kind)) throw new CorruptError(`Unknown envelope kind ${kind}`)
  if (expected !== undefined && kind !== expected)
    throw new CorruptError(`Envelope of kind ${kind}, ${expected} expected`)
  const flags = bytes[6] ?? 0
  if ((flags & ~FLAG_DEFLATE) !== 0) throw new CorruptError('Unknown envelope flags')
  if (flags & FLAG_DEFLATE && !compressible(kind)) throw new CorruptError(`Kind ${kind} cannot be compressed`)
  if (bytes[7] !== EPOCH) throw new UnsupportedFormatError(`Key epoch ${bytes[7]}`)
  return { version: VERSION, kind, flags, epoch: EPOCH, iv: copy(bytes.subarray(8, 8 + IV_LENGTH)) }
}

export function parseEnvelopeHeader(bytes: Uint8Array): EnvelopeHeader {
  return checkHeader(bytes)
}

function keyFor(subkeys: Subkeys, kind: EnvelopeKind, name: string): Promise<CryptoKey> {
  return kind === 6 ? localKey(subkeys, name) : objectKey(subkeys, name)
}

function aadFor(subkeys: Subkeys, header: Uint8Array, name: string): Bytes {
  return concat(header, subkeys.vaultId, nameBytes(name))
}

/** Concatenates the chunks of a stream. */
async function collect(readable: ReadableStream<Uint8Array>): Promise<Bytes> {
  const chunks: Uint8Array[] = []
  const reader = readable.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return concat(...chunks)
}

/** Feeds `bytes` to a transform stream's writable side; failures surface on the readable side, so they are muted. */
function feed(writable: WritableStream<BufferSource>, bytes: Uint8Array): void {
  const writer = writable.getWriter()
  writer.write(copy(bytes)).catch(() => undefined)
  writer.close().catch(() => undefined)
}

export async function deflateRaw(payload: Uint8Array): Promise<Bytes> {
  const stream = new CompressionStream('deflate-raw')
  feed(stream.writable, payload)
  return collect(stream.readable)
}

/**
 * Inflates a deflate-raw stream that must end exactly at the end of `bytes` (DecompressionStream rejects trailing
 * data and a truncated stream) into at most `limit` bytes. The limit is enforced while streaming: the reader is
 * cancelled as soon as the output passes it, so a compression bomb never materialises.
 */
export async function inflateRaw(bytes: Uint8Array, limit = MAX_PAYLOAD): Promise<Bytes> {
  const stream = new DecompressionStream('deflate-raw')
  feed(stream.writable, bytes)
  const reader = stream.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        throw new CorruptError(`Compressed payload inflates beyond ${limit} bytes`)
      }
      chunks.push(value)
    }
  } catch (cause) {
    if (cause instanceof CorruptError) throw cause
    throw new CorruptError('Invalid deflate-raw stream', { cause })
  }
  return concat(...chunks)
}

export async function sealEnvelope(subkeys: Subkeys, input: SealInput, rng: Rng): Promise<Bytes> {
  const { kind, name, payload } = input
  const compression = input.compression ?? 'none'
  if (!isKind(kind)) throw new InvalidInputError(`Unknown envelope kind ${kind}`)
  if (compression !== 'none' && !compressible(kind)) {
    throw new InvalidInputError(`Kind ${kind} cannot be compressed`)
  }
  if (payload.length > MAX_PAYLOAD) throw new InvalidInputError('Payload above 2^26 bytes')
  if (kind === 3 && payload.length > MAX_CHUNK) throw new InvalidInputError('Blob chunk above 2 MiB')
  const nameAscii = nameBytes(name)

  let stored: Uint8Array = payload
  let flags = 0
  if (compression === 'precompressed') {
    flags = FLAG_DEFLATE
  } else if (compression === 'deflate-raw') {
    // spec/FORMAT.md section 7.6: the flag is set only when deflate-raw makes the payload smaller.
    const deflated = await deflateRaw(payload)
    if (deflated.length < payload.length) {
      stored = deflated
      flags = FLAG_DEFLATE
    }
  }

  const iv = rng.bytes(IV_LENGTH)
  if (iv.length !== IV_LENGTH) throw new InvalidInputError('The RNG returned an IV of the wrong length')
  const header = concat(new Uint8Array([...MAGIC, VERSION, kind, flags, EPOCH]), iv)
  const plaintext = new Uint8Array(paddedSize(stored.length))
  plaintext.set(u32be(stored.length), 0)
  plaintext.set(stored, 4)
  try {
    const sealed = await aesGcmEncrypt(
      await keyFor(subkeys, kind, name),
      iv,
      plaintext,
      concat(header, subkeys.vaultId, nameAscii),
    )
    return concat(header, sealed)
  } finally {
    zero(plaintext)
    if (stored !== payload) zero(stored)
  }
}

export async function openEnvelope(subkeys: Subkeys, input: OpenInput): Promise<Bytes> {
  const { kind, name, bytes } = input
  const parsed = checkHeader(bytes, kind)
  const header = bytes.subarray(0, HEADER_LENGTH)
  const plaintext = await aesGcmDecrypt(
    await keyFor(subkeys, kind, name),
    parsed.iv,
    bytes.subarray(HEADER_LENGTH),
    aadFor(subkeys, header, name),
  )
  try {
    const size = plaintext.length
    const n = readU32be(plaintext, 0)
    if (n > size - 4 || n > MAX_PAYLOAD) throw new CorruptError('Payload length beyond the plaintext')
    if (size !== paddedSize(n)) throw new CorruptError('Plaintext padded to the wrong size')
    for (let i = 4 + n; i < size; i++) if (plaintext[i] !== 0) throw new CorruptError('Non-zero padding')
    const stored = plaintext.slice(4, 4 + n)
    if (!(parsed.flags & FLAG_DEFLATE)) return stored
    try {
      return await inflateRaw(stored)
    } finally {
      zero(stored)
    }
  } finally {
    zero(plaintext)
  }
}
