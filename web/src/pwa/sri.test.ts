import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fc from 'fast-check'
import { matchesIntegrity, parseIntegrity, sriDigest } from './sri.ts'

const bytes = (s: string) => new TextEncoder().encode(s)
const node = (b: Uint8Array, alg = 'sha256') => `${alg}-${createHash(alg).update(b).digest('base64')}`

test('the digest is the SRI form of SHA-256, as Node computes it', async () => {
  expect(await sriDigest(bytes(''))).toBe('sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=')
  await fc.assert(
    fc.asyncProperty(fc.uint8Array({ maxLength: 4096 }), async (b) => {
      expect(await sriDigest(b)).toBe(node(b))
      expect(await sriDigest(b, 'sha384')).toBe(node(b, 'sha384'))
    }),
  )
})

test('matching bytes pass, any change fails', async () => {
  await fc.assert(
    fc.asyncProperty(fc.uint8Array({ minLength: 1, maxLength: 512 }), fc.nat(), async (b, at) => {
      const integrity = await sriDigest(b)
      expect(await matchesIntegrity(b, integrity)).toBe(true)
      const tampered = b.slice()
      const i = at % tampered.length
      tampered[i] = ((tampered[i] ?? 0) + 1) % 256
      expect(await matchesIntegrity(tampered, integrity)).toBe(false)
    }),
  )
})

test('metadata without a usable digest never verifies', async () => {
  for (const metadata of ['', '   ', 'md5-abc', 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=', 'sha256', 'sha256-', 'nonsense']) {
    expect(parseIntegrity(metadata)).toEqual([])
    expect(await matchesIntegrity(bytes(''), metadata)).toBe(false)
  }
})

test('only the strongest algorithm counts, any of its digests may match, options are ignored', async () => {
  const b = bytes('aparte')
  const weakOk = node(b)
  const strongWrong = node(bytes('other'), 'sha512')
  expect(await matchesIntegrity(b, `${weakOk} ${strongWrong}`)).toBe(false)
  expect(await matchesIntegrity(b, `${strongWrong} ${node(b, 'sha512')}`)).toBe(true)
  expect(await matchesIntegrity(b, `${weakOk}?ct=text/javascript`)).toBe(true)
  expect(parseIntegrity(`${weakOk} md5-x`)).toHaveLength(1)
})
