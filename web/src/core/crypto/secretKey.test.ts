import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import {
  type BytesModule,
  InvalidInputError,
  type KeysModule,
  type RngModule,
  type SecretKeyModule,
} from '../contracts/crypto.ts'
import * as bytesImpl from './bytes.ts'
import * as keysImpl from './keys.ts'
import * as rngImpl from './rng.ts'
import * as secretKeyImpl from './secretKey.ts'

const B: BytesModule = bytesImpl
const K: KeysModule = keysImpl
const R: RngModule = rngImpl
const S: SecretKeyModule = secretKeyImpl

const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  secretKey: string
}
const sk = B.fromHex(inputs.secretKey)
const SHAPE = /^A1(-[A-Z2-7]{5}){6}$/

/** spec/FORMAT.md section 6.8, computed here from the definition. */
async function expectedText(secretKey: Uint8Array): Promise<string> {
  const checksum = (await K.sha256(B.concat(new TextEncoder().encode('aparte/1/secret-key|'), secretKey))).subarray(
    0,
    3,
  )
  const s = B.base32Encode(B.concat(secretKey, checksum)).slice(0, 30).toUpperCase()
  return `A1-${[0, 5, 10, 15, 20, 25].map((i) => s.slice(i, i + 5)).join('-')}`
}

describe('formatSecretKey', () => {
  test('is A1 and six groups of five, with a 22-bit checksum', async () => {
    const text = await S.formatSecretKey(sk)
    expect(text).toMatch(SHAPE)
    expect(text).toBe(await expectedText(sk))
  })

  test('refuses a key that is not 16 bytes', async () => {
    await expect(S.formatSecretKey(new Uint8Array(15))).rejects.toBeInstanceOf(InvalidInputError)
  })
})

describe('parseSecretKey', () => {
  test('round trips any key', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 16, maxLength: 16 }), async (key) => {
        expect(await S.parseSecretKey(await S.formatSecretKey(key))).toEqual(key)
      }),
    )
  })

  test('ignores case, spaces and hyphens', async () => {
    const text = await S.formatSecretKey(sk)
    expect(await S.parseSecretKey(text.toLowerCase())).toEqual(sk)
    expect(await S.parseSecretKey(text.replaceAll('-', ''))).toEqual(sk)
    expect(await S.parseSecretKey(` ${text.replaceAll('-', ' ')} `)).toEqual(sk)
  })

  test('detects any single mistyped character', async () => {
    const text = await S.formatSecretKey(sk)
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
    for (let i = 3; i < text.length; i++) {
      const c = text.charAt(i)
      if (c === '-') continue
      const typo = alphabet.charAt((alphabet.indexOf(c) + 1) % 32)
      await expect(S.parseSecretKey(text.slice(0, i) + typo + text.slice(i + 1))).rejects.toBeInstanceOf(
        InvalidInputError,
      )
    }
  })

  test.each([
    '',
    'A1',
    'A2-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA',
    'B1-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA',
    'A1-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAA',
    'A1-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAAA',
    'A1-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAA0',
    'A1-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAA8',
    'A1-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAA!',
  ])('rejects %p', async (text) => {
    await expect(S.parseSecretKey(text)).rejects.toBeInstanceOf(InvalidInputError)
  })
})

describe('generateSecretKey', () => {
  test('draws 16 bytes from the injected RNG', () => {
    const rng = R.queueRng([sk])
    expect(S.generateSecretKey(rng)).toEqual(sk)
    expect(rng.remaining()).toBe(0)
    expect(S.generateSecretKey(R.cryptoRng())).toHaveLength(16)
  })
})
