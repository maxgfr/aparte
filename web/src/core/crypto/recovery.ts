/*
 * The recovery key and its text (spec/FORMAT.md section 6.9): the 52 characters of uppercase base32 in 13 groups of
 * 4. There is no checksum beyond the 4 zero trailing bits; a typo surfaces as wrong-secret when the slot is opened.
 */
import { type Bytes, InvalidInputError, type Rng } from '../contracts/crypto.ts'
import { base32Decode, base32Encode } from './bytes.ts'

const LENGTH = 32
/** ASCII only once spaces and hyphens are gone, so no case mapping can turn another character into a letter. */
const TEXT = /^[A-Za-z2-7]*$/

function requireKey(recoveryKey: Uint8Array): void {
  if (!(recoveryKey instanceof Uint8Array) || recoveryKey.length !== LENGTH) {
    throw new InvalidInputError(`A recovery key is ${LENGTH} bytes`)
  }
}

export function generateRecoveryKey(rng: Rng): Bytes {
  const key = rng.bytes(LENGTH)
  requireKey(key)
  return key
}

export function formatRecoveryKey(recoveryKey: Uint8Array): string {
  requireKey(recoveryKey)
  const text = base32Encode(recoveryKey).toUpperCase()
  return (text.match(/.{1,4}/g) ?? []).join('-')
}

export function parseRecoveryKey(text: string): Bytes {
  const compact = typeof text === 'string' ? text.replace(/[ -]/g, '') : ''
  if (!TEXT.test(compact)) throw new InvalidInputError('Not a recovery key')
  const key = base32Decode(compact.toLowerCase())
  if (key.length !== LENGTH) throw new InvalidInputError(`A recovery key is ${LENGTH} bytes`)
  return key
}
