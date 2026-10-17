/*
 * Keyslots of spec/FORMAT.md section 6, with the small Argon2 parameters of spec/vectors/inputs.json. The full
 * derivation (Argon2, KEK, commitment, wrap, AAD, mkCheck) is recomputed here from the primitives, so keyslot.ts is
 * pinned to the spec; then every rejection path is checked, including that a hostile parameter never reaches Argon2.
 */
import { describe, expect, test } from 'bun:test'
import {
  type Argon2Fn,
  type Argon2Module,
  type BytesModule,
  CorruptError,
  InvalidInputError,
  type Keyslot,
  type KeyslotModule,
  type KeysModule,
  type RngModule,
  type SlotSecret,
  TamperedError,
  UnsupportedKeyslotError,
  WrongSecretError,
} from '../contracts/crypto.ts'
import * as argon2Impl from './argon2.ts'
import * as bytesImpl from './bytes.ts'
import * as keysImpl from './keys.ts'
import * as keyslotImpl from './keyslot.ts'
import * as rngImpl from './rng.ts'

const A: Argon2Module = argon2Impl
const B: BytesModule = bytesImpl
const K: KeysModule = keysImpl
const KS: KeyslotModule = keyslotImpl
const R: RngModule = rngImpl

interface SlotCase {
  id: string
  kind: 'passphrase' | 'recovery' | 'passkey'
  passphrase?: 'ascii' | 'unicode'
  secretKey?: boolean
  slotId: string
  salt?: string
  iv: string
  credentialId?: string
  rpId?: string
  prfSalt?: string
  prfOutput?: string
}
interface MaliciousCase {
  id: string
  path: string
  value?: unknown
  delete?: boolean
}
const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  mk: string
  vaultId: string
  otherVaultId: string
  argon2: { m: number; t: number; p: number }
  passphrases: { ascii: string; unicode: string; unicodeEquivalent: string; wrong: string }
  secretKey: string
  recoveryKey: string
  keyslots: SlotCase[]
  maliciousKeyslots: { base: string; cases: MaliciousCase[] }
}

const mk = B.fromHex(inputs.mk)
const vaultId = B.fromHex(inputs.vaultId)
const sk = B.fromHex(inputs.secretKey)
const recoveryKey = B.fromHex(inputs.recoveryKey)
const utf8 = (s: string) => new TextEncoder().encode(s)
const slotCase = (id: string) => inputs.keyslots.find((c) => c.id === id) as SlotCase

async function create(c: SlotCase): Promise<{ slot: Keyslot; undrawn: number }> {
  const rng = R.queueRng(
    c.kind === 'passphrase'
      ? [B.fromHex(c.slotId), B.fromHex(c.salt ?? ''), B.fromHex(c.iv)]
      : [B.fromHex(c.slotId), B.fromHex(c.iv)],
  )
  let slot: Keyslot
  if (c.kind === 'passphrase') {
    slot = await KS.createKeyslot(
      {
        kind: 'passphrase',
        mk,
        vaultId,
        passphrase: inputs.passphrases[c.passphrase ?? 'ascii'],
        secretKey: c.secretKey ? sk : null,
        argon2: inputs.argon2,
      },
      { rng },
    )
  } else if (c.kind === 'recovery') {
    slot = await KS.createKeyslot({ kind: 'recovery', mk, vaultId, recoveryKey }, { rng })
  } else {
    slot = await KS.createKeyslot(
      {
        kind: 'passkey',
        mk,
        vaultId,
        prfOutput: B.fromHex(c.prfOutput ?? ''),
        credentialId: B.fromHex(c.credentialId ?? ''),
        rpId: c.rpId ?? '',
        prfSalt: B.fromHex(c.prfSalt ?? ''),
      },
      { rng },
    )
  }
  return { slot, undrawn: rng.remaining() }
}

const slots = new Map<string, Keyslot>()
const undrawn = new Map<string, number>()
for (const c of inputs.keyslots) {
  const created = await create(c)
  slots.set(c.id, created.slot)
  undrawn.set(c.id, created.undrawn)
}
const slotOf = (id: string) => slots.get(id) as Keyslot

const passphraseSecret = (passphrase: string, secretKey: Uint8Array | null = sk): SlotSecret => ({
  kind: 'passphrase',
  passphrase,
  secretKey,
})
const open = (slot: Keyslot, secret: SlotSecret, argon2?: Argon2Fn) =>
  KS.openKeyslot(slot, secret, { vaultId, ...(argon2 ? { argon2 } : {}) })

/** A copy of the base slot's JSON with one member changed, serialized in writer order. */
function mutated(base: Keyslot, change: (o: Record<string, unknown>) => void): { text: string; object: Keyslot } {
  const object = JSON.parse(B.fromUtf8(KS.serializeKeyslot(base))) as Record<string, unknown>
  change(object)
  return { text: `${JSON.stringify(object)}\n`, object: object as unknown as Keyslot }
}

function countingArgon2(): { fn: Argon2Fn; calls: () => number } {
  let calls = 0
  return {
    fn: (input) => {
      calls++
      return A.argon2id(input)
    },
    calls: () => calls,
  }
}

describe('constants', () => {
  test('default and bounds of the Argon2 parameters', () => {
    expect(KS.DEFAULT_ARGON2).toEqual({ m: 65536, t: 3, p: 1 })
    expect(KS.ARGON2_BOUNDS).toEqual({ m: [19456, 262144], t: [2, 10], p: [1, 4] })
  })
})

describe('normalizePassphrase', () => {
  test('is UTF-8 of NFKC, so equivalent spellings give the same bytes', () => {
    const { unicode, unicodeEquivalent } = inputs.passphrases
    expect(unicode).not.toBe(unicodeEquivalent)
    expect(KS.normalizePassphrase(unicode)).toEqual(utf8(unicode.normalize('NFKC')))
    expect(KS.normalizePassphrase(unicodeEquivalent)).toEqual(KS.normalizePassphrase(unicode))
    expect(B.fromUtf8(KS.normalizePassphrase('ﬁ Ⅻ ＃'))).toBe('fi XII #')
  })

  test.each(['', '\ud800'])('refuses %p', (passphrase) => {
    expect(() => KS.normalizePassphrase(passphrase)).toThrow(InvalidInputError)
  })
})

describe('creating', () => {
  test('draws slotId, then salt (passphrase only), then the IV, and nothing else', () => {
    for (const c of inputs.keyslots) expect(undrawn.get(c.id)).toBe(0)
  })

  test('a passphrase slot follows the spec derivation exactly', async () => {
    const c = slotCase('passphrase-secret-key')
    const slot = slotOf(c.id)
    const slotId = B.fromHex(c.slotId)
    expect(slot.format).toBe('aparte/1')
    expect(slot.type).toBe('keyslot')
    expect(slot.vault).toBe(B.base32Encode(vaultId))
    expect(slot.slot).toBe(B.base32Encode(slotId))
    expect(slot.kind).toBe('passphrase')
    expect(slot.kdf).toEqual({
      alg: 'argon2id',
      v: 19,
      ...inputs.argon2,
      salt: B.base64urlEncode(B.fromHex(c.salt ?? '')),
      secretKey: true,
    })
    expect(slot.wrap.iv).toBe(B.base64urlEncode(B.fromHex(c.iv)))

    const a = await A.argon2id({
      password: KS.normalizePassphrase(inputs.passphrases.unicode),
      salt: B.fromHex(c.salt ?? ''),
      ...inputs.argon2,
      length: 32,
    })
    const kek = await K.hkdfSha256(B.concat(a, sk), B.concat(vaultId, slotId), utf8('aparte/1/kek|passphrase'))
    const kWrap = await K.hkdfSha256(kek, vaultId, utf8('aparte/1/wrap'))
    const kCommit = await K.hkdfSha256(kek, vaultId, utf8('aparte/1/commit'))
    const commit = await K.hmacSha256(kCommit, B.concat(utf8('aparte/1/commit|'), vaultId, slotId))
    expect(B.base64urlDecode(slot.commit)).toEqual(commit)

    const aad = utf8(`aparte/1|keyslot|${slot.vault}|${slot.slot}|passphrase|${B.canonicalJson({ ...slot.kdf })}`)
    expect(KS.keyslotAad(slot)).toEqual(aad)
    const ct = B.base64urlDecode(slot.wrap.ct)
    expect(ct).toHaveLength(48)
    expect(await K.aesGcmDecrypt(kWrap, B.fromHex(c.iv), ct, aad)).toEqual(mk)

    const check = await K.masterKeyCheck(await K.deriveSubkeys(mk, vaultId))
    expect(B.base64urlDecode(slot.mkCheck)).toEqual(check)
  })

  test('a slot without the Secret Key uses IKM = A', async () => {
    const c = slotCase('passphrase-only')
    const slot = slotOf(c.id)
    const slotId = B.fromHex(c.slotId)
    expect(slot.kdf).toMatchObject({ secretKey: false })
    const a = await A.argon2id({
      password: KS.normalizePassphrase(inputs.passphrases.ascii),
      salt: B.fromHex(c.salt ?? ''),
      ...inputs.argon2,
      length: 32,
    })
    const kek = await K.hkdfSha256(a, B.concat(vaultId, slotId), utf8('aparte/1/kek|passphrase'))
    const kCommit = await K.hkdfSha256(kek, vaultId, utf8('aparte/1/commit'))
    const commit = await K.hmacSha256(kCommit, B.concat(utf8('aparte/1/commit|'), vaultId, slotId))
    expect(B.base64urlDecode(slot.commit)).toEqual(commit)
  })

  test('a recovery slot uses IKM = R and kdf {"alg":"recovery"}', async () => {
    const c = slotCase('recovery')
    const slot = slotOf(c.id)
    const slotId = B.fromHex(c.slotId)
    expect(slot.kind).toBe('recovery')
    expect(slot.kdf).toEqual({ alg: 'recovery' })
    const kek = await K.hkdfSha256(recoveryKey, B.concat(vaultId, slotId), utf8('aparte/1/kek|recovery'))
    const kWrap = await K.hkdfSha256(kek, vaultId, utf8('aparte/1/wrap'))
    const aad = utf8(`aparte/1|keyslot|${slot.vault}|${slot.slot}|recovery|{"alg":"recovery"}`)
    expect(KS.keyslotAad(slot)).toEqual(aad)
    expect(await K.aesGcmDecrypt(kWrap, B.fromHex(c.iv), B.base64urlDecode(slot.wrap.ct), aad)).toEqual(mk)
  })

  test('a passkey slot records the credential and uses IKM = PRF output', async () => {
    const c = slotCase('passkey')
    const slot = slotOf(c.id)
    expect(slot.kdf).toEqual({
      alg: 'prf',
      credentialId: B.base64urlEncode(B.fromHex(c.credentialId ?? '')),
      rpId: c.rpId ?? '',
      prfSalt: B.base64urlEncode(B.fromHex(c.prfSalt ?? '')),
    })
    const kek = await K.hkdfSha256(
      B.fromHex(c.prfOutput ?? ''),
      B.concat(vaultId, B.fromHex(c.slotId)),
      utf8('aparte/1/kek|passkey'),
    )
    const kWrap = await K.hkdfSha256(kek, vaultId, utf8('aparte/1/wrap'))
    expect(await K.aesGcmDecrypt(kWrap, B.fromHex(c.iv), B.base64urlDecode(slot.wrap.ct), KS.keyslotAad(slot))).toEqual(
      mk,
    )
  })

  test('refuses an empty passphrase and Argon2 parameters out of bounds', async () => {
    const rng = R.cryptoRng()
    await expect(
      KS.createKeyslot(
        { kind: 'passphrase', mk, vaultId, passphrase: '', secretKey: sk, argon2: inputs.argon2 },
        { rng },
      ),
    ).rejects.toBeInstanceOf(InvalidInputError)
    for (const argon2 of [
      { m: 19455, t: 2, p: 1 },
      { m: 19456, t: 1, p: 1 },
      { m: 19456, t: 2, p: 5 },
    ]) {
      await expect(
        KS.createKeyslot({ kind: 'passphrase', mk, vaultId, passphrase: 'x', secretKey: sk, argon2 }, { rng }),
      ).rejects.toBeInstanceOf(InvalidInputError)
    }
  })
})

describe('serializing and parsing', () => {
  test('writer order, no whitespace, one final line feed, and a lossless round trip', () => {
    for (const slot of slots.values()) {
      const text = B.fromUtf8(KS.serializeKeyslot(slot))
      expect(text.endsWith('}\n')).toBe(true)
      expect(text.indexOf('\n')).toBe(text.length - 1)
      const parsed = JSON.parse(text) as Record<string, unknown>
      expect(Object.keys(parsed)).toEqual([
        'format',
        'type',
        'vault',
        'slot',
        'kind',
        'kdf',
        'commit',
        'wrap',
        'mkCheck',
      ])
      expect(Object.keys(parsed.wrap as object)).toEqual(['iv', 'ct'])
      expect(`${JSON.stringify(parsed)}\n`).toBe(text)
      expect(KS.parseKeyslot(KS.serializeKeyslot(slot), { name: `keys/${slot.slot}.json` })).toEqual(slot)
    }
    const kdfKeys = Object.keys(
      (JSON.parse(B.fromUtf8(KS.serializeKeyslot(slotOf('passphrase-secret-key')))) as { kdf: object }).kdf,
    )
    expect(kdfKeys).toEqual(['alg', 'v', 'm', 't', 'p', 'salt', 'secretKey'])
  })

  const base = slotOf('passphrase-secret-key')
  const corrupt: [string, () => Uint8Array][] = [
    ['not UTF-8', () => new Uint8Array([0xff, 0xfe, 0x7b])],
    ['not JSON', () => utf8('not json\n')],
    ['an array', () => utf8('[]\n')],
    ['an extra member', () => utf8(mutated(base, (o) => (o.label = 'phone')).text)],
    ['a missing member', () => utf8(mutated(base, (o) => delete o.mkCheck).text)],
    ['the wrong type', () => utf8(mutated(base, (o) => (o.type = 'key')).text)],
    ['a bad base64url commit', () => utf8(mutated(base, (o) => (o.commit = 'not+base64url')).text)],
    ['a short commit', () => utf8(mutated(base, (o) => (o.commit = B.base64urlEncode(new Uint8Array(31)))).text)],
    ['a short wrap', () => utf8(mutated(base, (o) => ((o.wrap as { ct: string }).ct = 'AAAA')).text)],
    ['a non-canonical slot id', () => utf8(mutated(base, (o) => (o.slot = `${base.slot.slice(0, 25)}f`)).text)],
    ['pretty-printed', () => utf8(`${JSON.stringify(JSON.parse(B.fromUtf8(KS.serializeKeyslot(base))), null, 2)}\n`)],
    ['without the final line feed', () => KS.serializeKeyslot(base).subarray(0, -1)],
    [
      'members reordered',
      () => {
        const { kind, ...rest } = JSON.parse(B.fromUtf8(KS.serializeKeyslot(base))) as Record<string, unknown>
        return utf8(`${JSON.stringify({ kind, ...rest })}\n`)
      },
    ],
  ]

  test.each(corrupt)('rejects a file that is %s as corrupt', (_, bytes) => {
    expect(() => KS.parseKeyslot(bytes())).toThrow(CorruptError)
  })

  test('rejects a file whose slot is not its name', () => {
    expect(() => KS.parseKeyslot(KS.serializeKeyslot(base), { name: `keys/${'a'.repeat(26)}.json` })).toThrow(
      CorruptError,
    )
  })
})

describe('opening', () => {
  test('every kind opens with its secret and returns the master key', async () => {
    expect(await open(slotOf('passphrase-secret-key'), passphraseSecret(inputs.passphrases.unicode))).toEqual(mk)
    expect(await open(slotOf('passphrase-only'), passphraseSecret(inputs.passphrases.ascii, null))).toEqual(mk)
    expect(await open(slotOf('recovery'), { kind: 'recovery', recoveryKey })).toEqual(mk)
    const pk = slotCase('passkey')
    expect(await open(slotOf('passkey'), { kind: 'passkey', prfOutput: B.fromHex(pk.prfOutput ?? '') })).toEqual(mk)
  })

  test('an NFKC-equivalent passphrase opens the same slot', async () => {
    const slot = slotOf('passphrase-secret-key')
    expect(await open(slot, passphraseSecret(inputs.passphrases.unicodeEquivalent))).toEqual(mk)
  })

  test('a wrong passphrase, Secret Key, recovery key or PRF output is wrong-secret', async () => {
    const slot = slotOf('passphrase-secret-key')
    await expect(open(slot, passphraseSecret(inputs.passphrases.wrong))).rejects.toBeInstanceOf(WrongSecretError)
    const otherSk = sk.slice()
    otherSk[0] = (otherSk[0] ?? 0) ^ 1
    await expect(open(slot, passphraseSecret(inputs.passphrases.unicode, otherSk))).rejects.toBeInstanceOf(
      WrongSecretError,
    )
    const otherR = recoveryKey.slice()
    otherR[31] = (otherR[31] ?? 0) ^ 1
    await expect(open(slotOf('recovery'), { kind: 'recovery', recoveryKey: otherR })).rejects.toBeInstanceOf(
      WrongSecretError,
    )
    await expect(open(slotOf('passkey'), { kind: 'passkey', prfOutput: new Uint8Array(32) })).rejects.toBeInstanceOf(
      WrongSecretError,
    )
  })

  test('a slot that needs the Secret Key, opened without it, asks for it (invalid-input)', async () => {
    const slot = slotOf('passphrase-secret-key')
    await expect(open(slot, passphraseSecret(inputs.passphrases.unicode, null))).rejects.toBeInstanceOf(
      InvalidInputError,
    )
  })

  test('a secret of the wrong kind is refused', async () => {
    await expect(open(slotOf('recovery'), passphraseSecret(inputs.passphrases.ascii))).rejects.toBeInstanceOf(
      InvalidInputError,
    )
  })

  test('a slot of another vault is corrupt', async () => {
    await expect(
      KS.openKeyslot(
        slotOf('recovery'),
        { kind: 'recovery', recoveryKey },
        { vaultId: B.fromHex(inputs.otherVaultId) },
      ),
    ).rejects.toBeInstanceOf(CorruptError)
  })
})

describe('the commitment is checked before the wrap is decrypted', () => {
  const slot = slotOf('passphrase-secret-key')
  const right = passphraseSecret(inputs.passphrases.unicode)

  test('a changed commit with the right secret is wrong-secret, not tampered', async () => {
    const { object } = mutated(slot, (o) => (o.commit = B.base64urlEncode(new Uint8Array(32).fill(9))))
    await expect(open(object, right)).rejects.toBeInstanceOf(WrongSecretError)
  })

  test('a wrong secret over a garbage wrap is wrong-secret: AES-GCM never ran', async () => {
    const { object } = mutated(slot, (o) => ((o.wrap as { ct: string }).ct = B.base64urlEncode(new Uint8Array(48))))
    await expect(open(object, passphraseSecret(inputs.passphrases.wrong))).rejects.toBeInstanceOf(WrongSecretError)
  })

  test('the right secret over a damaged wrap is tampered', async () => {
    const ct = B.base64urlDecode(slot.wrap.ct)
    ct[0] = (ct[0] ?? 0) ^ 1
    const { object } = mutated(slot, (o) => ((o.wrap as { ct: string }).ct = B.base64urlEncode(ct)))
    await expect(open(object, right)).rejects.toBeInstanceOf(TamperedError)
  })

  test('the right secret with a wrong mkCheck is tampered', async () => {
    const { object } = mutated(slot, (o) => (o.mkCheck = B.base64urlEncode(new Uint8Array(32))))
    await expect(open(object, right)).rejects.toBeInstanceOf(TamperedError)
  })

  test('a changed kdf changes the AAD and the derivation: never opens', async () => {
    const { object } = mutated(slot, (o) => ((o.kdf as { t: number }).t = 3))
    await expect(open(object, right)).rejects.toBeInstanceOf(WrongSecretError)
  })
})

describe('hostile parameters are rejected before Argon2 runs', () => {
  const base = slotOf(inputs.maliciousKeyslots.base)
  const right = passphraseSecret(inputs.passphrases.unicode)

  test.each(inputs.maliciousKeyslots.cases)('$id', async (c) => {
    const { text, object } = mutated(base, (o) => {
      const path = c.path.split('.')
      const last = path.pop() as string
      let target = o
      for (const key of path) target = target[key] as Record<string, unknown>
      if (c.delete) delete target[last]
      else target[last] = c.value
    })
    expect(() => KS.parseKeyslot(utf8(text))).toThrow(UnsupportedKeyslotError)
    const argon2 = countingArgon2()
    await expect(open(object, right, argon2.fn)).rejects.toBeInstanceOf(UnsupportedKeyslotError)
    expect(argon2.calls()).toBe(0)
  })

  test.each([
    ['an upper-case rpId', (o: Record<string, unknown>) => ((o.kdf as { rpId: string }).rpId = 'Aparte.Example')],
    ['an empty credential id', (o: Record<string, unknown>) => ((o.kdf as { credentialId: string }).credentialId = '')],
    ['a short PRF salt', (o: Record<string, unknown>) => ((o.kdf as { prfSalt: string }).prfSalt = 'AAAA')],
  ])('a passkey slot with %s', (_, change) => {
    expect(() => KS.parseKeyslot(utf8(mutated(slotOf('passkey'), change).text))).toThrow(UnsupportedKeyslotError)
  })

  test('the vector parameters are in bounds and run once per open', async () => {
    const argon2 = countingArgon2()
    expect(await open(base, right, argon2.fn)).toEqual(mk)
    expect(argon2.calls()).toBe(1)
  })
})
