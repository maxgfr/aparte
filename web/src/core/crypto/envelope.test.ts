/*
 * The envelope of spec/FORMAT.md section 7. Every sealed case is decrypted here by hand, with the key and AAD the spec
 * defines, so the byte layout is pinned independently of envelope.ts; then each tamper class of
 * spec/vectors/inputs.json must fail with the error of section 7.5.
 */
import { describe, expect, test } from 'bun:test'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import {
  type AparteError,
  type BytesModule,
  CorruptError,
  type EnvelopeKind,
  type EnvelopeModule,
  InvalidInputError,
  type KeysModule,
  type PadmeModule,
  type RngModule,
  TamperedError,
  UnsupportedFormatError,
} from '../contracts/crypto.ts'
import * as bytesImpl from './bytes.ts'
import * as envelopeImpl from './envelope.ts'
import * as keysImpl from './keys.ts'
import * as padmeImpl from './padme.ts'
import * as rngImpl from './rng.ts'

const B: BytesModule = bytesImpl
const E: EnvelopeModule = envelopeImpl
const K: KeysModule = keysImpl
const P: PadmeModule = padmeImpl
const R: RngModule = rngImpl

interface EnvelopeCase {
  id: string
  kind: EnvelopeKind
  compression: 'none' | 'precompressed'
  iv: string
  name: string
  payload: string
  deflated?: string
}
interface TamperCase {
  id: string
  op: 'xor' | 'set' | 'append' | 'truncate' | 'open-as' | 'open-with-vault' | 'raw'
  offset?: number
  mask?: string
  value?: string
  length?: number
  name?: string
  vault?: string
  iv?: string
  plaintext?: string
  flags?: string
}
const inputs = (await Bun.file(new URL('../../../../spec/vectors/inputs.json', import.meta.url)).json()) as {
  mk: string
  vaultId: string
  otherVaultId: string
  envelopes: EnvelopeCase[]
  tamper: { base: string; cases: TamperCase[] }
}

const mk = B.fromHex(inputs.mk)
const vaultId = B.fromHex(inputs.vaultId)
const subkeys = await K.deriveSubkeys(mk, vaultId)
const MAGIC = [0x41, 0x50, 0x54, 0x31]

const keyFor = (kind: EnvelopeKind, name: string) =>
  kind === 6 ? K.localKey(subkeys, name) : K.objectKey(subkeys, name)
const aadFor = (header: Uint8Array, name: string, vault = vaultId) =>
  B.concat(header, vault, new TextEncoder().encode(name))

async function seal(c: EnvelopeCase): Promise<Uint8Array> {
  const precompressed = c.compression === 'precompressed'
  return E.sealEnvelope(
    subkeys,
    {
      kind: c.kind,
      name: c.name,
      payload: B.fromHex(precompressed ? (c.deflated ?? '') : c.payload),
      compression: c.compression,
    },
    R.queueRng([B.fromHex(c.iv)]),
  )
}

describe('sealEnvelope layout', () => {
  test.each(inputs.envelopes)('$id', async (c) => {
    const sealed = await seal(c)
    const stored = B.fromHex(c.compression === 'precompressed' ? (c.deflated ?? '') : c.payload)
    const size = P.paddedSize(stored.length)
    expect(sealed).toHaveLength(20 + size + 16)

    const header = sealed.subarray(0, 20)
    expect([...header.subarray(0, 4)]).toEqual(MAGIC)
    expect(header[4]).toBe(1)
    expect(header[5]).toBe(c.kind)
    expect(header[6]).toBe(c.compression === 'precompressed' ? 1 : 0)
    expect(header[7]).toBe(0)
    expect(B.toHex(header.subarray(8, 20))).toBe(c.iv)

    // Decrypted by hand: plaintext = u32be(n) || payload' || zeros, under K_obj or K_local, AAD = header || vault || name.
    const plaintext = await K.aesGcmDecrypt(
      await keyFor(c.kind, c.name),
      header.subarray(8, 20),
      sealed.subarray(20),
      aadFor(header, c.name),
    )
    expect(plaintext).toHaveLength(size)
    expect(B.readU32be(plaintext, 0)).toBe(stored.length)
    expect(B.toHex(plaintext.subarray(4, 4 + stored.length))).toBe(B.toHex(stored))
    expect(plaintext.subarray(4 + stored.length).every((b) => b === 0)).toBe(true)

    const opened = await E.openEnvelope(subkeys, { kind: c.kind, name: c.name, bytes: sealed })
    expect(B.toHex(opened)).toBe(c.payload)
  })

  test('padding edges: 0 and 60 bytes seal to 100 bytes, 61 bytes to 108', async () => {
    const byId = (id: string) => inputs.envelopes.find((c) => c.id === id) as EnvelopeCase
    expect(await seal(byId('empty'))).toHaveLength(100)
    expect(await seal(byId('boundary-60'))).toHaveLength(100)
    expect(await seal(byId('boundary-61'))).toHaveLength(108)
    expect(await seal(byId('segment-plain'))).toHaveLength(108)
  })

  test('the precomputed streams of the vectors inflate to their payloads', () => {
    for (const c of inputs.envelopes.filter((x) => x.compression === 'precompressed')) {
      expect(B.toHex(inflateRawSync(B.fromHex(c.deflated ?? '')))).toBe(c.payload)
    }
  })

  test('deflate-raw compresses segments and checkpoints, and opening inflates', async () => {
    const payload = new TextEncoder().encode('aparte/1 segment body '.repeat(200))
    for (const kind of [1, 2] as const) {
      const name = `d/aaaaaaaaaaaaaaaa/s/bbbbbbbbbbbbbbbb/0000000/000000000${kind}-cccccccc`
      const sealed = await E.sealEnvelope(subkeys, { kind, name, payload, compression: 'deflate-raw' }, R.cryptoRng())
      expect(sealed[6]).toBe(1)
      expect(sealed.length).toBeLessThan(payload.length / 4)
      const plaintext = await K.aesGcmDecrypt(
        await K.objectKey(subkeys, name),
        sealed.subarray(8, 20),
        sealed.subarray(20),
        aadFor(sealed.subarray(0, 20), name),
      )
      const n = B.readU32be(plaintext, 0)
      expect(inflateRawSync(plaintext.subarray(4, 4 + n))).toEqual(Buffer.from(payload))
      expect(await E.openEnvelope(subkeys, { kind, name, bytes: sealed })).toEqual(payload)
    }
  })

  test.each([3, 4, 5, 6] as const)('refuses compression for kind %p', async (kind) => {
    for (const compression of ['deflate-raw', 'precompressed'] as const) {
      await expect(
        E.sealEnvelope(
          subkeys,
          { kind, name: 'b/aa/aaaaaaaaaaaaaaaaaaaaaaaaaa', payload: new Uint8Array(8), compression },
          R.cryptoRng(),
        ),
      ).rejects.toBeInstanceOf(InvalidInputError)
    }
  })

  test('draws exactly one IV per seal, so two seals of the same input differ', async () => {
    const rng = R.queueRng([new Uint8Array(12).fill(1)])
    await E.sealEnvelope(subkeys, { kind: 3, name: 'b/aa/aaaaaaaaaaaaaaaaaaaaaaaaaa', payload: new Uint8Array(4) }, rng)
    expect(rng.remaining()).toBe(0)
    const input = { kind: 3, name: 'b/aa/aaaaaaaaaaaaaaaaaaaaaaaaaa', payload: new Uint8Array(4) } as const
    const a = await E.sealEnvelope(subkeys, input, R.cryptoRng())
    const b = await E.sealEnvelope(subkeys, input, R.cryptoRng())
    expect(B.equal(a, b)).toBe(false)
  })

  test('kind 6 uses the local key, the others the object key', async () => {
    const local = inputs.envelopes.find((c) => c.kind === 6) as EnvelopeCase
    const sealed = await seal(local)
    await expect(
      K.aesGcmDecrypt(
        await K.objectKey(subkeys, local.name),
        sealed.subarray(8, 20),
        sealed.subarray(20),
        aadFor(sealed.subarray(0, 20), local.name),
      ),
    ).rejects.toBeInstanceOf(TamperedError)
  })

  test('refuses a payload above 2^26 bytes', async () => {
    await expect(
      E.sealEnvelope(
        subkeys,
        {
          kind: 1,
          name: 'd/aaaaaaaaaaaaaaaa/s/bbbbbbbbbbbbbbbb/0000000/0000000001-cccccccc',
          payload: new Uint8Array(2 ** 26 + 1),
        },
        R.cryptoRng(),
      ),
    ).rejects.toBeInstanceOf(InvalidInputError)
  })

  test('parseEnvelopeHeader reads the header without decrypting', async () => {
    const c = inputs.envelopes[0] as EnvelopeCase
    const header = E.parseEnvelopeHeader(await seal(c))
    expect(header).toEqual({ version: 1, kind: 1, flags: 0, epoch: 0, iv: B.fromHex(c.iv) })
    expect(() => E.parseEnvelopeHeader(new Uint8Array(99))).toThrow(CorruptError)
  })
})

describe('openEnvelope rejects', () => {
  const base = inputs.envelopes.find((c) => c.id === inputs.tamper.base) as EnvelopeCase

  // spec/FORMAT.md section 7.5: the step each mutation breaks decides the error.
  const expected: Record<string, new (...args: never[]) => AparteError> = {
    magic: CorruptError,
    version: UnsupportedFormatError,
    'kind-unknown': CorruptError,
    'kind-mismatch': CorruptError,
    'flags-unknown': CorruptError,
    'flags-compress': TamperedError,
    epoch: UnsupportedFormatError,
    iv: TamperedError,
    ciphertext: TamperedError,
    tag: TamperedError,
    'trailing-byte': TamperedError,
    'truncated-tag': TamperedError,
    'truncated-short': CorruptError,
    'name-swap': TamperedError,
    'vault-swap': TamperedError,
    'padding-non-zero': CorruptError,
    'length-beyond': CorruptError,
    'padding-excess': CorruptError,
    'deflate-garbage': CorruptError,
  }

  test('every tamper class of the vectors has an expected error', () => {
    expect(inputs.tamper.cases.map((c) => c.id).sort()).toEqual(Object.keys(expected).sort())
  })

  test.each(inputs.tamper.cases)('$id', async (t) => {
    const sealed = await seal(base)
    let bytes = sealed.slice()
    let name = base.name
    let keys = subkeys
    const at = (offset: number) => (offset < 0 ? bytes.length + offset : offset)
    switch (t.op) {
      case 'xor':
        bytes[at(t.offset ?? 0)] = (bytes[at(t.offset ?? 0)] ?? 0) ^ (B.fromHex(t.mask ?? '00')[0] ?? 0)
        break
      case 'set':
        bytes[at(t.offset ?? 0)] = B.fromHex(t.value ?? '00')[0] ?? 0
        break
      case 'append':
        bytes = B.concat(bytes, B.fromHex(t.value ?? ''))
        break
      case 'truncate': {
        const length = t.length ?? 0
        bytes = bytes.slice(0, length < 0 ? bytes.length + length : length)
        break
      }
      case 'open-as':
        name = t.name ?? ''
        break
      case 'open-with-vault':
        keys = await K.deriveSubkeys(mk, B.fromHex(inputs.otherVaultId))
        break
      case 'raw': {
        // A validly encrypted envelope around a plaintext the writer would never produce.
        const iv = B.fromHex(t.iv ?? '')
        const header = B.concat(new Uint8Array([...MAGIC, 1, 1, Number.parseInt(t.flags ?? '00', 16), 0]), iv)
        const ct = await K.aesGcmEncrypt(
          await K.objectKey(subkeys, base.name),
          iv,
          B.fromHex(t.plaintext ?? ''),
          aadFor(header, base.name),
        )
        bytes = B.concat(header, ct)
        break
      }
    }
    const error = expected[t.id]
    if (!error) throw new Error(`no expectation for ${t.id}`)
    await expect(E.openEnvelope(keys, { kind: base.kind, name, bytes })).rejects.toBeInstanceOf(error)
  })

  test('a compressed payload that inflates beyond 2^26 bytes', async () => {
    const bomb = deflateRawSync(new Uint8Array(2 ** 26 + 1))
    const name = 'd/aaaaaaaaaaaaaaaa/s/bbbbbbbbbbbbbbbb/0000000/0000000001-cccccccc'
    const sealed = await E.sealEnvelope(
      subkeys,
      { kind: 1, name, payload: bomb, compression: 'precompressed' },
      R.cryptoRng(),
    )
    await expect(E.openEnvelope(subkeys, { kind: 1, name, bytes: sealed })).rejects.toBeInstanceOf(CorruptError)
  })

  test('an envelope shorter than the minimum, or empty', async () => {
    for (const bytes of [new Uint8Array(), new Uint8Array(20), new Uint8Array(99)]) {
      await expect(E.openEnvelope(subkeys, { kind: 1, name: base.name, bytes })).rejects.toBeInstanceOf(CorruptError)
    }
  })
})
