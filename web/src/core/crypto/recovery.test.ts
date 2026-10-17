import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import { type BytesModule, InvalidInputError, type RecoveryModule, type RngModule } from '../contracts/crypto.ts'
import * as bytesImpl from './bytes.ts'
import * as recoveryImpl from './recovery.ts'
import * as rngImpl from './rng.ts'

const B: BytesModule = bytesImpl
const RK: RecoveryModule = recoveryImpl
const R: RngModule = rngImpl

const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  recoveryKey: string
}
const key = B.fromHex(inputs.recoveryKey)
const SHAPE = /^[A-Z2-7]{4}(-[A-Z2-7]{4}){12}$/

describe('formatRecoveryKey', () => {
  test('is the uppercase base32 of the 32 bytes in 13 groups of 4', () => {
    const text = RK.formatRecoveryKey(key)
    expect(text).toMatch(SHAPE)
    expect(text.replaceAll('-', '').toLowerCase()).toBe(B.base32Encode(key))
  })

  test('refuses a key that is not 32 bytes', () => {
    expect(() => RK.formatRecoveryKey(new Uint8Array(16))).toThrow(InvalidInputError)
  })
})

describe('parseRecoveryKey', () => {
  test('round trips any key', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), (k) => {
        expect(RK.parseRecoveryKey(RK.formatRecoveryKey(k))).toEqual(k)
      }),
    )
  })

  test('ignores case, spaces and hyphens', () => {
    const text = RK.formatRecoveryKey(key)
    expect(RK.parseRecoveryKey(text.toLowerCase())).toEqual(key)
    expect(RK.parseRecoveryKey(text.replaceAll('-', ' '))).toEqual(key)
    expect(RK.parseRecoveryKey(text.replaceAll('-', ''))).toEqual(key)
  })

  test('rejects a wrong length, a character outside the alphabet and non-zero trailing bits', () => {
    const text = RK.formatRecoveryKey(key).replaceAll('-', '')
    expect(() => RK.parseRecoveryKey(text.slice(0, 51))).toThrow(InvalidInputError)
    expect(() => RK.parseRecoveryKey(`${text}A`)).toThrow(InvalidInputError)
    expect(() => RK.parseRecoveryKey(`${text.slice(0, 51)}1`)).toThrow(InvalidInputError)
    // The 52nd character carries 1 data bit and 4 bits that must be zero: B (value 1) is never valid there.
    expect(() => RK.parseRecoveryKey(`${text.slice(0, 51)}B`)).toThrow(InvalidInputError)
    expect(() => RK.parseRecoveryKey('')).toThrow(InvalidInputError)
  })
})

describe('generateRecoveryKey', () => {
  test('draws 32 bytes from the injected RNG', () => {
    const rng = R.queueRng([key])
    expect(RK.generateRecoveryKey(rng)).toEqual(key)
    expect(rng.remaining()).toBe(0)
  })
})
