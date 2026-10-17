/*
 * The key schedule of spec/FORMAT.md section 5. Subkeys are non-extractable, so each one is checked by its behaviour
 * against the formula computed here with raw HKDF and HMAC over the inputs of spec/vectors/inputs.json.
 */
import { describe, expect, test } from 'bun:test'
import { type BytesModule, type KeysModule, type Subkeys, TamperedError } from '../contracts/crypto.ts'
import * as bytesImpl from './bytes.ts'
import * as keysImpl from './keys.ts'

const B: BytesModule = bytesImpl
const K: KeysModule = keysImpl

const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  mk: string
  vaultId: string
  otherVaultId: string
  envelopes: { name: string }[]
}
const mk = B.fromHex(inputs.mk)
const vaultId = B.fromHex(inputs.vaultId)
const utf8 = (s: string) => new TextEncoder().encode(s)

/** K_purpose computed from the spec formula with raw bytes. */
const rawSubkey = (purpose: string, vault = vaultId) =>
  K.hkdfSha256(mk, B.concat(utf8('aparte/1/vault'), vault), utf8(`aparte/1/${purpose}`))

const subkeys: Subkeys = await K.deriveSubkeys(mk, vaultId)
const message = utf8('dtag|any message')

describe('deriveSubkeys', () => {
  test('returns six non-extractable keys and the vault id', async () => {
    expect(subkeys.vaultId).toEqual(vaultId)
    for (const key of [
      subkeys.objEnc,
      subkeys.objName,
      subkeys.blobId,
      subkeys.localEnc,
      subkeys.localName,
      subkeys.check,
    ]) {
      expect(key).toBeInstanceOf(CryptoKey)
      expect(key.extractable).toBe(false)
      await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
    }
  })

  test('HMAC subkeys are HKDF(MK, "aparte/1/vault" || vaultId, "aparte/1/" || purpose)', async () => {
    const pairs: [CryptoKey, string][] = [
      [subkeys.objName, 'obj-name'],
      [subkeys.blobId, 'blob-id'],
      [subkeys.localName, 'local-name'],
      [subkeys.check, 'check'],
    ]
    for (const [key, purpose] of pairs) {
      expect(key.algorithm.name).toBe('HMAC')
      expect(await K.hmacSha256(key, message)).toEqual(await K.hmacSha256(await rawSubkey(purpose), message))
    }
  })

  test('every purpose gives a different key', async () => {
    const macs = await Promise.all(
      [subkeys.objName, subkeys.blobId, subkeys.localName, subkeys.check].map((k) => K.hmacSha256(k, message)),
    )
    expect(new Set(macs.map((m) => B.toHex(m))).size).toBe(4)
  })

  test('another vault id gives other keys from the same master key', async () => {
    const other = await K.deriveSubkeys(mk, B.fromHex(inputs.otherVaultId))
    expect(await K.hmacSha256(other.objName, message)).not.toEqual(await K.hmacSha256(subkeys.objName, message))
  })

  test('rejects a master key or vault id of the wrong length', async () => {
    await expect(K.deriveSubkeys(mk.subarray(0, 31), vaultId)).rejects.toThrow()
    await expect(K.deriveSubkeys(mk, vaultId.subarray(0, 15))).rejects.toThrow()
  })
})

describe('per-object and per-record keys', () => {
  const name = inputs.envelopes[0]?.name ?? ''
  const iv = new Uint8Array(12).fill(7)
  const plain = utf8('object plaintext')

  test('K_obj(name) = HKDF(K_obj-enc, vaultId, "aparte/1/obj|" || name), non-extractable AES-GCM', async () => {
    const key = await K.objectKey(subkeys, name)
    expect(key.extractable).toBe(false)
    expect(key.algorithm.name).toBe('AES-GCM')
    const raw = await K.hkdfSha256(await rawSubkey('obj-enc'), vaultId, utf8(`aparte/1/obj|${name}`))
    const sealed = await K.aesGcmEncrypt(key, iv, plain, new Uint8Array())
    expect(await K.aesGcmDecrypt(raw, iv, sealed, new Uint8Array())).toEqual(plain)
  })

  test('K_local(name) = HKDF(K_local-enc, vaultId, "aparte/1/local|" || name)', async () => {
    const localName = 'kkkkkkkkkkkkkkkkkkkkkkkkkk'
    const key = await K.localKey(subkeys, localName)
    expect(key.extractable).toBe(false)
    const raw = await K.hkdfSha256(await rawSubkey('local-enc'), vaultId, utf8(`aparte/1/local|${localName}`))
    const sealed = await K.aesGcmEncrypt(key, iv, plain, new Uint8Array())
    expect(await K.aesGcmDecrypt(raw, iv, sealed, new Uint8Array())).toEqual(plain)
  })

  test('each name has its own key, and local keys differ from object keys', async () => {
    const a = await K.aesGcmEncrypt(await K.objectKey(subkeys, `${name}x`), iv, plain, new Uint8Array())
    const b = await K.aesGcmEncrypt(await K.objectKey(subkeys, name), iv, plain, new Uint8Array())
    const c = await K.aesGcmEncrypt(await K.localKey(subkeys, name), iv, plain, new Uint8Array())
    expect(a).not.toEqual(b)
    expect(b).not.toEqual(c)
    await expect(K.aesGcmDecrypt(await K.localKey(subkeys, name), iv, b, new Uint8Array())).rejects.toBeInstanceOf(
      TamperedError,
    )
  })
})

describe('masterKeyCheck', () => {
  test('is HMAC(K_check, "aparte/1/check|" || vaultId)', async () => {
    const expected = await K.hmacSha256(await rawSubkey('check'), B.concat(utf8('aparte/1/check|'), vaultId))
    expect(await K.masterKeyCheck(subkeys)).toEqual(expected)
  })
})

describe('aes-gcm helpers', () => {
  test('the AAD is authenticated', async () => {
    const key = new Uint8Array(32).fill(1)
    const iv = new Uint8Array(12)
    const sealed = await K.aesGcmEncrypt(key, iv, utf8('x'), utf8('aad'))
    expect(sealed).toHaveLength(1 + 16)
    await expect(K.aesGcmDecrypt(key, iv, sealed, utf8('aae'))).rejects.toBeInstanceOf(TamperedError)
  })

  test('refuses an IV that is not 12 bytes', async () => {
    const key = new Uint8Array(32)
    await expect(K.aesGcmEncrypt(key, new Uint8Array(16), utf8('x'), new Uint8Array())).rejects.toThrow()
  })
})
