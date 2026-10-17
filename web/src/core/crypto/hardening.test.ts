/*
 * Behaviour the contract states but the vector tests do not pin: inputs are never mutated, deflate-raw is used only
 * when it helps, canonical form is byte-exact, and size limits hold on the writing side too.
 */
import { describe, expect, test } from 'bun:test'
import { CorruptError, InvalidInputError } from '../contracts/crypto.ts'
import { argon2id } from './argon2.ts'
import { fromUtf8, utf8 } from './bytes.ts'
import { openEnvelope, sealEnvelope } from './envelope.ts'
import { deriveSubkeys } from './keys.ts'
import { createKeyslot, parseKeyslot, serializeKeyslot } from './keyslot.ts'
import { cryptoRng, seededRng } from './rng.ts'

const mk = Uint8Array.from({ length: 32 }, (_, i) => i)
const vaultId = new Uint8Array(16).fill(0xf0)
const subkeys = await deriveSubkeys(mk, vaultId)
const segment = 'd/aaaaaaaaaaaaaaaa/s/bbbbbbbbbbbbbbbb/0000000/0000000001-cccccccc'

describe('argon2id', () => {
  test('leaves the caller arrays intact', async () => {
    const password = utf8('password')
    const salt = new Uint8Array(16).fill(7)
    const secret = new Uint8Array(8).fill(3)
    await argon2id({ password, salt, secret, m: 64, t: 1, p: 1, length: 32 })
    expect(fromUtf8(password)).toBe('password')
    expect(salt.every((b) => b === 7)).toBe(true)
    expect(secret.every((b) => b === 3)).toBe(true)
  })

  test('refuses parameters hash-wasm cannot run', async () => {
    const base = { password: utf8('x'), salt: new Uint8Array(16), m: 64, t: 1, p: 1, length: 32 }
    await expect(argon2id({ ...base, salt: new Uint8Array(4) })).rejects.toBeInstanceOf(InvalidInputError)
    await expect(argon2id({ ...base, m: 7 })).rejects.toBeInstanceOf(InvalidInputError)
    await expect(argon2id({ ...base, t: 1.5 })).rejects.toBeInstanceOf(InvalidInputError)
  })
})

describe('envelope', () => {
  test('deflate-raw is skipped when it does not make the payload smaller', async () => {
    const payload = seededRng(1).bytes(300)
    const sealed = await sealEnvelope(
      subkeys,
      { kind: 1, name: segment, payload, compression: 'deflate-raw' },
      cryptoRng(),
    )
    expect(sealed[6]).toBe(0)
    expect(await openEnvelope(subkeys, { kind: 1, name: segment, bytes: sealed })).toEqual(payload)
  })

  test('sealing leaves the payload intact', async () => {
    const payload = utf8('aparte '.repeat(100))
    const before = payload.slice()
    await sealEnvelope(subkeys, { kind: 1, name: segment, payload, compression: 'deflate-raw' }, cryptoRng())
    expect(payload).toEqual(before)
  })

  test('refuses a blob chunk above 2 MiB and a name that is not printable ASCII', async () => {
    const chunk = 'b/aa/aaaaaaaaaaaaaaaaaaaaaaaaaa'
    await expect(
      sealEnvelope(subkeys, { kind: 3, name: chunk, payload: new Uint8Array(2_097_153) }, cryptoRng()),
    ).rejects.toBeInstanceOf(InvalidInputError)
    await expect(
      sealEnvelope(subkeys, { kind: 3, name: 'b/aa/é', payload: new Uint8Array(1) }, cryptoRng()),
    ).rejects.toBeInstanceOf(InvalidInputError)
  })
})

const slot = await createKeyslot(
  { kind: 'recovery', mk, vaultId, recoveryKey: new Uint8Array(32).fill(9) },
  { rng: seededRng(2) },
)

describe('keyslot canonical form', () => {
  test('a number written another way is not canonical', async () => {
    const passphrase = await createKeyslot(
      { kind: 'passphrase', mk, vaultId, passphrase: 'p', secretKey: null, argon2: { m: 19456, t: 2, p: 1 } },
      { rng: seededRng(3), argon2: async () => new Uint8Array(32) },
    )
    const text = fromUtf8(serializeKeyslot(passphrase)).replace('"t":2', '"t":2.0')
    expect(() => parseKeyslot(utf8(text))).toThrow(CorruptError)
  })

  test('a UTF-8 BOM or an escaped character makes the file non-canonical', () => {
    const text = fromUtf8(serializeKeyslot(slot))
    expect(() => parseKeyslot(utf8(`﻿${text}`))).toThrow(CorruptError)
    expect(() => parseKeyslot(utf8(text.replace('"keyslot"', '"key\\u0073lot"')))).toThrow(CorruptError)
  })

  test('a malformed expected name is corrupt', () => {
    expect(() => parseKeyslot(serializeKeyslot(slot), { name: `keys/${slot.slot}.JSON` })).toThrow(CorruptError)
  })
})
