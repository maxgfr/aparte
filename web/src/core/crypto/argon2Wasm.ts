/*
 * The Argon2id computation itself (hash-wasm, RFC 9106, version 0x13), shared by the worker and the in-process path.
 * It checks only what hash-wasm needs to run; the vault bounds are the keyslot layer's job.
 */
import { argon2id } from 'hash-wasm'
import { type Bytes, InvalidInputError } from '../contracts/crypto.ts'
import { copy, zero } from './bytes.ts'

/** What crosses the worker boundary: plain numbers and byte arrays, so it survives a structured clone. */
export interface Argon2Request {
  readonly password: Uint8Array
  readonly salt: Uint8Array
  readonly secret?: Uint8Array | undefined
  readonly m: number
  readonly t: number
  readonly p: number
  readonly length: number
}

/** The answer a worker posts back: the tag, or the failure's error code and message. */
export type Argon2Response =
  | { readonly ok: true; readonly tag: Uint8Array }
  | { readonly ok: false; readonly code: string | null; readonly message: string }

const isUint = (n: number, min: number, max: number): boolean => Number.isInteger(n) && n >= min && n <= max

/** Throws InvalidInputError when hash-wasm would refuse the request. */
export function checkArgon2Request(r: Argon2Request): void {
  if (!(r.password instanceof Uint8Array) || !(r.salt instanceof Uint8Array)) {
    throw new InvalidInputError('Argon2 password and salt must be bytes')
  }
  if (r.secret !== undefined && !(r.secret instanceof Uint8Array)) throw new InvalidInputError('Argon2 secret')
  if (r.salt.length < 8) throw new InvalidInputError('Argon2 salt shorter than 8 bytes')
  if (!isUint(r.p, 1, 0xffffff)) throw new InvalidInputError('Argon2 lanes out of range')
  if (!isUint(r.t, 1, 0xffffffff)) throw new InvalidInputError('Argon2 passes out of range')
  if (!isUint(r.m, 8 * r.p, 0xffffffff)) throw new InvalidInputError('Argon2 memory out of range')
  if (!isUint(r.length, 4, 0xffffffff)) throw new InvalidInputError('Argon2 tag length out of range')
}

/** Runs Argon2id in the calling thread and returns the tag in a buffer of its own. */
export async function computeArgon2id(r: Argon2Request): Promise<Bytes> {
  checkArgon2Request(r)
  const tag = await argon2id({
    password: r.password,
    salt: r.salt,
    ...(r.secret && r.secret.length > 0 ? { secret: r.secret } : {}),
    iterations: r.t,
    parallelism: r.p,
    memorySize: r.m,
    hashLength: r.length,
    outputType: 'binary',
  })
  const out = copy(tag)
  zero(tag)
  return out
}
