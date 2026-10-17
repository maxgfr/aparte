/*
 * Published known answers for the primitives the format is built on (spec/kat). They pin the platform primitives as
 * keys.ts exposes them: if WebCrypto or the wrapper around it drifts, these fail before any vector does.
 */
import { describe, expect, test } from 'bun:test'
import { type BytesModule, type KeysModule, TamperedError } from '../contracts/crypto.ts'
import * as bytesImpl from './bytes.ts'
import * as keysImpl from './keys.ts'

const B: BytesModule = bytesImpl
const K: KeysModule = keysImpl

const kat = async <T>(file: string): Promise<T> =>
  (await Bun.file(new URL(`../../../../spec/kat/${file}`, import.meta.url)).json()) as T

interface HkdfCase {
  tcId: number
  ikm: string
  salt: string
  info: string
  length: number
  prk: string
  okm: string
}
interface HmacCase {
  tcId: number
  key: string
  data: string
  mac: string
  truncateBytes?: number
}
interface GcmCase {
  tcId: number
  comment: string
  key: string
  iv: string
  aad: string
  msg: string
  ct: string
  tag: string
  result: 'valid' | 'invalid'
}

const hkdf = await kat<{ source: string; tests: HkdfCase[] }>('hkdf-sha256.json')
const hmac = await kat<{ source: string; tests: HmacCase[] }>('hmac-sha256.json')
const gcm = await kat<{ source: string; keySize: number; ivSize: number; tagSize: number; tests: GcmCase[] }>(
  'aes-256-gcm.json',
)
const hex = (s: string) => B.fromHex(s)

describe('known-answer files', () => {
  test('record their source and hold the expected cases', () => {
    expect(hkdf.source).toBe('https://www.rfc-editor.org/rfc/rfc5869.txt')
    expect(hkdf.tests.map((t) => t.tcId)).toEqual([1, 2, 3])
    expect(hmac.source).toBe('https://www.rfc-editor.org/rfc/rfc4231.txt')
    expect(hmac.tests.map((t) => t.tcId)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(gcm.source).toContain('wycheproof/main/testvectors_v1/aes_gcm_test.json')
    expect([gcm.keySize, gcm.ivSize, gcm.tagSize]).toEqual([256, 96, 128])
    expect(gcm.tests.length).toBeGreaterThanOrEqual(30)
    expect(gcm.tests.some((t) => t.result === 'valid')).toBe(true)
    expect(gcm.tests.some((t) => t.result === 'invalid')).toBe(true)
  })
})

describe('SHA-256 (FIPS 180-4)', () => {
  test('known digests', async () => {
    expect(B.toHex(await K.sha256(new Uint8Array()))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(B.toHex(await K.sha256(new TextEncoder().encode('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('HKDF-SHA256 (RFC 5869)', () => {
  test.each(hkdf.tests)('test case $tcId', async (c) => {
    const okm = await K.hkdfSha256(hex(c.ikm), hex(c.salt), hex(c.info), c.length)
    expect(B.toHex(okm)).toBe(c.okm)
  })

  test('defaults to 32 bytes', async () => {
    const c = hkdf.tests[0] as HkdfCase
    const okm = await K.hkdfSha256(hex(c.ikm), hex(c.salt), hex(c.info))
    expect(B.toHex(okm)).toBe(c.okm.slice(0, 64))
  })
})

describe('HMAC-SHA256 (RFC 4231)', () => {
  test.each(hmac.tests)('test case $tcId', async (c) => {
    const mac = B.toHex(await K.hmacSha256(hex(c.key), hex(c.data)))
    expect(c.truncateBytes ? mac.slice(0, c.truncateBytes * 2) : mac).toBe(c.mac)
  })

  test('a raw key and the equivalent HMAC CryptoKey agree', async () => {
    const c = hmac.tests[1] as HmacCase
    const key = await crypto.subtle.importKey('raw', hex(c.key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    expect(B.toHex(await K.hmacSha256(key, hex(c.data)))).toBe(c.mac)
  })
})

describe('AES-256-GCM (Wycheproof)', () => {
  const valid = gcm.tests.filter((t) => t.result === 'valid')
  const invalid = gcm.tests.filter((t) => t.result === 'invalid')

  test.each(valid)('valid $tcId: $comment', async (c) => {
    const sealed = await K.aesGcmEncrypt(hex(c.key), hex(c.iv), hex(c.msg), hex(c.aad))
    expect(B.toHex(sealed)).toBe(c.ct + c.tag)
    const opened = await K.aesGcmDecrypt(hex(c.key), hex(c.iv), hex(c.ct + c.tag), hex(c.aad))
    expect(B.toHex(opened)).toBe(c.msg)
  })

  test.each(invalid)('invalid $tcId: $comment', async (c) => {
    await expect(K.aesGcmDecrypt(hex(c.key), hex(c.iv), hex(c.ct + c.tag), hex(c.aad))).rejects.toBeInstanceOf(
      TamperedError,
    )
  })
})
