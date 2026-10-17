/*
 * Argon2id known answers. The reference-implementation cases (no secret, no associated data) run straight through
 * argon2.ts. The RFC 9106 vector needs associated data, which hash-wasm 4.12 cannot take (it hard-codes its length to
 * zero), so it is checked against `referenceArgon2id` below, an independent and deliberately plain transcription of
 * RFC 9106 section 3; argon2.ts is then checked against that reference on inputs it can express. Together they tie
 * argon2.ts to RFC 9106.
 */
import { describe, expect, test } from 'bun:test'
import { blake2b } from 'hash-wasm'
import type { Argon2Module } from '../contracts/crypto.ts'
import * as argon2Impl from './argon2.ts'

const A: Argon2Module = argon2Impl

interface Argon2Case {
  tcId: number
  version: number
  memoryKiB: number
  passes: number
  parallelism: number
  tagLength: number
  password: string
  salt: string
  secret?: string
  ad?: string
  tag: string
}
const kat = (await Bun.file(new URL('../../../../spec/kat/argon2id.json', import.meta.url)).json()) as {
  rfc9106: { source: string; tests: Argon2Case[] }
  reference: { source: string; tests: Argon2Case[] }
}

const fromHex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => Number.parseInt(h, 16))
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

// Reference Argon2id (RFC 9106 section 3), test-only. Plain BigInt arithmetic: slow, but obviously transcribed.

const MASK64 = (1n << 64n) - 1n
const MASK32 = 0xffffffffn

function le32(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** BLAKE2b with an output length parameter of `bytes` (not a truncation of BLAKE2b-512). */
async function b2(data: Uint8Array, bytes: number): Promise<Uint8Array> {
  return fromHex(await blake2b(data, bytes * 8))
}

/** H' of RFC 9106 section 3.3. */
async function hPrime(x: Uint8Array, t: number): Promise<Uint8Array> {
  if (t <= 64) return b2(cat(le32(t), x), t)
  const r = Math.ceil(t / 32) - 2
  const out = new Uint8Array(t)
  let v = await b2(cat(le32(t), x), 64)
  out.set(v.subarray(0, 32), 0)
  for (let i = 1; i < r; i++) {
    v = await b2(v, 64)
    out.set(v.subarray(0, 32), i * 32)
  }
  v = await b2(v, t - 32 * r)
  out.set(v, r * 32)
  return out
}

function toWords(b: Uint8Array): BigUint64Array {
  const w = new BigUint64Array(128)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  for (let i = 0; i < 128; i++) w[i] = dv.getBigUint64(i * 8, true)
  return w
}

function fromWords(w: BigUint64Array): Uint8Array {
  const b = new Uint8Array(1024)
  const dv = new DataView(b.buffer)
  for (let i = 0; i < 128; i++) dv.setBigUint64(i * 8, w[i] ?? 0n, true)
  return b
}

const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK64
const fBlaMka = (a: bigint, b: bigint) => (a + b + 2n * (a & MASK32) * (b & MASK32)) & MASK64

/** GB of RFC 9106 section 3.6. */
function gb(v: BigUint64Array, a: number, b: number, c: number, d: number): void {
  let va = v[a] ?? 0n
  let vb = v[b] ?? 0n
  let vc = v[c] ?? 0n
  let vd = v[d] ?? 0n
  va = fBlaMka(va, vb)
  vd = rotr(vd ^ va, 32n)
  vc = fBlaMka(vc, vd)
  vb = rotr(vb ^ vc, 24n)
  va = fBlaMka(va, vb)
  vd = rotr(vd ^ va, 16n)
  vc = fBlaMka(vc, vd)
  vb = rotr(vb ^ vc, 63n)
  v[a] = va
  v[b] = vb
  v[c] = vc
  v[d] = vd
}

/** The permutation P on the 16 words at `idx`. */
function permute(v: BigUint64Array, idx: number[]): void {
  const s = new BigUint64Array(16)
  for (let i = 0; i < 16; i++) s[i] = v[idx[i] ?? 0] ?? 0n
  gb(s, 0, 4, 8, 12)
  gb(s, 1, 5, 9, 13)
  gb(s, 2, 6, 10, 14)
  gb(s, 3, 7, 11, 15)
  gb(s, 0, 5, 10, 15)
  gb(s, 1, 6, 11, 12)
  gb(s, 2, 7, 8, 13)
  gb(s, 3, 4, 9, 14)
  for (let i = 0; i < 16; i++) v[idx[i] ?? 0] = s[i] ?? 0n
}

/** next = G(prev, ref), XORed into next on passes after the first (version 0x13). */
function fill(prev: BigUint64Array, ref: BigUint64Array, next: BigUint64Array, withXor: boolean): void {
  const r = new BigUint64Array(128)
  for (let i = 0; i < 128; i++) r[i] = (ref[i] ?? 0n) ^ (prev[i] ?? 0n)
  const tmp = r.slice()
  if (withXor) for (let i = 0; i < 128; i++) tmp[i] = (tmp[i] ?? 0n) ^ (next[i] ?? 0n)
  for (let i = 0; i < 8; i++)
    permute(
      r,
      Array.from({ length: 16 }, (_, k) => 16 * i + k),
    )
  for (let i = 0; i < 8; i++) {
    const idx: number[] = []
    for (let k = 0; k < 8; k++) idx.push(2 * i + 16 * k, 2 * i + 16 * k + 1)
    permute(r, idx)
  }
  for (let i = 0; i < 128; i++) next[i] = (tmp[i] ?? 0n) ^ (r[i] ?? 0n)
}

interface ReferenceInput {
  password: Uint8Array
  salt: Uint8Array
  secret: Uint8Array
  ad: Uint8Array
  m: number
  t: number
  p: number
  length: number
}

async function referenceArgon2id(o: ReferenceInput): Promise<Uint8Array> {
  const h0 = await b2(
    cat(
      le32(o.p),
      le32(o.length),
      le32(o.m),
      le32(o.t),
      le32(0x13),
      le32(2),
      le32(o.password.length),
      o.password,
      le32(o.salt.length),
      o.salt,
      le32(o.secret.length),
      o.secret,
      le32(o.ad.length),
      o.ad,
    ),
    64,
  )
  const blocks = 4 * o.p * Math.floor(o.m / (4 * o.p))
  const laneLength = blocks / o.p
  const segLength = laneLength / 4
  const mem: BigUint64Array[] = Array.from({ length: blocks }, () => new BigUint64Array(128))
  const at = (i: number): BigUint64Array => {
    const b = mem[i]
    if (!b) throw new RangeError(`block ${i}`)
    return b
  }
  for (let l = 0; l < o.p; l++) {
    mem[l * laneLength] = toWords(await hPrime(cat(h0, le32(0), le32(l)), 1024))
    mem[l * laneLength + 1] = toWords(await hPrime(cat(h0, le32(1), le32(l)), 1024))
  }
  const zero = new BigUint64Array(128)
  for (let pass = 0; pass < o.t; pass++) {
    for (let slice = 0; slice < 4; slice++) {
      for (let lane = 0; lane < o.p; lane++) {
        // Argon2id: data-independent addressing for the first half of the first pass only.
        const independent = pass === 0 && slice < 2
        const input = new BigUint64Array(128)
        const address = new BigUint64Array(128)
        input[0] = BigInt(pass)
        input[1] = BigInt(lane)
        input[2] = BigInt(slice)
        input[3] = BigInt(blocks)
        input[4] = BigInt(o.t)
        input[5] = 2n
        const nextAddresses = () => {
          input[6] = (input[6] ?? 0n) + 1n
          fill(zero, input, address, false)
          fill(zero, address, address, false)
        }
        let start = 0
        if (pass === 0 && slice === 0) {
          start = 2
          if (independent) nextAddresses()
        }
        let cur = lane * laneLength + slice * segLength + start
        let prev = cur % laneLength === 0 ? cur + laneLength - 1 : cur - 1
        for (let i = start; i < segLength; i++, cur++, prev++) {
          if (cur % laneLength === 1) prev = cur - 1
          let rand: bigint
          if (independent) {
            if (i % 128 === 0) nextAddresses()
            rand = address[i % 128] ?? 0n
          } else rand = at(prev)[0] ?? 0n
          let refLane = Number((rand >> 32n) % BigInt(o.p))
          if (pass === 0 && slice === 0) refLane = lane
          const same = refLane === lane
          let area: number
          if (pass === 0) {
            if (slice === 0) area = i - 1
            else if (same) area = slice * segLength + i - 1
            else area = slice * segLength + (i === 0 ? -1 : 0)
          } else if (same) area = laneLength - segLength + i - 1
          else area = laneLength - segLength + (i === 0 ? -1 : 0)
          let rel = rand & MASK32
          rel = (rel * rel) >> 32n
          rel = BigInt(area) - 1n - ((BigInt(area) * rel) >> 32n)
          const startPos = pass !== 0 ? (slice === 3 ? 0 : (slice + 1) * segLength) : 0
          const refIndex = Number((BigInt(startPos) + rel) % BigInt(laneLength))
          fill(at(prev), at(refLane * laneLength + refIndex), at(cur), pass !== 0)
        }
      }
    }
  }
  const c = at(laneLength - 1).slice()
  for (let l = 1; l < o.p; l++) {
    const last = at(l * laneLength + laneLength - 1)
    for (let i = 0; i < 128; i++) c[i] = (c[i] ?? 0n) ^ (last[i] ?? 0n)
  }
  return hPrime(fromWords(c), o.length)
}

describe('reference Argon2id', () => {
  test('reproduces the RFC 9106 section 5.3 tag (secret and associated data)', async () => {
    const [c] = kat.rfc9106.tests
    if (!c) throw new Error('missing RFC 9106 case')
    expect(kat.rfc9106.source).toBe('https://www.rfc-editor.org/rfc/rfc9106.txt')
    const tag = await referenceArgon2id({
      password: fromHex(c.password),
      salt: fromHex(c.salt),
      secret: fromHex(c.secret ?? ''),
      ad: fromHex(c.ad ?? ''),
      m: c.memoryKiB,
      t: c.passes,
      p: c.parallelism,
      length: c.tagLength,
    })
    expect(toHex(tag)).toBe(c.tag)
  })
})

describe('argon2id (argon2.ts)', () => {
  test.each(kat.reference.tests)('reference implementation case $tcId', async (c) => {
    const tag = await A.argon2id({
      password: fromHex(c.password),
      salt: fromHex(c.salt),
      m: c.memoryKiB,
      t: c.passes,
      p: c.parallelism,
      length: c.tagLength,
    })
    expect(toHex(tag)).toBe(c.tag)
  })

  const shapes = [
    { m: 32, t: 3, p: 4, length: 32, secret: 8 },
    { m: 64, t: 2, p: 2, length: 48, secret: 16 },
    { m: 128, t: 1, p: 1, length: 100, secret: 0 },
    { m: 24, t: 4, p: 3, length: 16, secret: 32 },
  ]

  test.each(shapes)('agrees with the reference, secret of $secret bytes, m=$m t=$t p=$p', async (shape) => {
    const { secret: secretLength, ...params } = shape
    const password = Uint8Array.from({ length: 20 }, (_, i) => i * 7)
    const salt = new Uint8Array(16).fill(0x5a)
    const secret = new Uint8Array(secretLength).fill(0x03)
    const ours = await A.argon2id({ password, salt, ...params, ...(secretLength ? { secret } : {}) })
    const ref = await referenceArgon2id({ password, salt, secret, ad: new Uint8Array(), ...params })
    expect(toHex(ours)).toBe(toHex(ref))
    expect(ours).toHaveLength(params.length)
  })

  test('the vector parameters run fast enough for unit tests', async () => {
    const started = performance.now()
    await A.argon2id({ password: new Uint8Array([1]), salt: new Uint8Array(16), m: 19456, t: 2, p: 1, length: 32 })
    expect(performance.now() - started).toBeLessThan(2000)
  })
})
