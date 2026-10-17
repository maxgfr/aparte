import { describe, expect, test } from 'bun:test'
import type { Rng } from '../contracts/crypto.ts'
import {
  DEFAULT_WORD_COUNT,
  EFF_WORDLIST_SIZE,
  generatePassphrase,
  parseWordlist,
  passphraseBits,
  SEPARATOR,
  wordIndex,
} from './diceware.ts'
import { loadStrengthCheck, MIN_SCORE } from './strength.ts'

const raw = await Bun.file(new URL('./eff-large-wordlist.txt', import.meta.url)).text()
const words = parseWordlist(raw)

/** Hands out the given 16-bit values, big-endian, then fails loudly. */
function valuesRng(values: readonly number[]): Rng & { left(): number } {
  const queue = [...values]
  return {
    bytes(n: number) {
      if (n !== 2) throw new Error(`expected a 2-byte draw, got ${n}`)
      const v = queue.shift()
      if (v === undefined) throw new Error('rng exhausted')
      return new Uint8Array([v >> 8, v & 0xff])
    },
    left: () => queue.length,
  }
}

const cryptoRng: Rng = { bytes: (n) => crypto.getRandomValues(new Uint8Array(n)) }

describe('wordlist', () => {
  test('the bundled EFF list has 7776 distinct words, in the original order', () => {
    expect(words.length).toBe(EFF_WORDLIST_SIZE)
    expect(words[0]).toBe('abacus')
    expect(words[EFF_WORDLIST_SIZE - 1]).toBe('zoom')
  })

  test('a truncated, duplicated or malformed list is refused', () => {
    expect(() => parseWordlist(words.slice(1).join('\n'))).toThrow(/7776/)
    expect(() => parseWordlist([...words.slice(1), words[1] ?? ''].join('\n'))).toThrow(/distinct/)
    expect(() => parseWordlist([...words.slice(1), 'Not a word'].join('\n'))).toThrow(/unexpected/)
  })

  test('the license notice ships next to the list', async () => {
    const notice = await Bun.file(new URL('./LICENSE-EFF.txt', import.meta.url)).text()
    expect(notice).toContain('Electronic Frontier Foundation')
    expect(notice).toContain('CC BY 3.0')
  })
})

describe('generation', () => {
  test('six words by default, joined with the separator, about 77.5 bits', () => {
    const p = generatePassphrase(words, cryptoRng)
    expect(DEFAULT_WORD_COUNT).toBe(6)
    // Some EFF words contain a hyphen themselves, so the count is checked through the draws, not by splitting.
    const rng = valuesRng([0, 1, 2, 3, 4, 5])
    expect(generatePassphrase(words, rng)).toBe(words.slice(0, 6).join(SEPARATOR))
    expect(p.length).toBeGreaterThan(6 * 3)
    expect(passphraseBits()).toBeCloseTo(77.55, 1)
  })

  test('draws at or above the last multiple of 7776 are rejected, so every word is equally likely', () => {
    const limit = 65536 - (65536 % EFF_WORDLIST_SIZE)
    const rng = valuesRng([65535, limit, limit - 1])
    expect(wordIndex(rng)).toBe((limit - 1) % EFF_WORDLIST_SIZE)
    expect(rng.left()).toBe(0)
    expect(wordIndex(valuesRng([EFF_WORDLIST_SIZE + 7]))).toBe(7)
  })

  test('two generations differ and only use listed words', () => {
    const set = new Set(words)
    const a = generatePassphrase(words, cryptoRng, 1)
    const b = generatePassphrase(words, cryptoRng, 12)
    expect(set.has(a)).toBe(true)
    expect(b).not.toBe(generatePassphrase(words, cryptoRng, 12))
  })

  test('refuses another list or a word count below one', () => {
    expect(() => generatePassphrase(words.slice(1), cryptoRng)).toThrow()
    expect(() => generatePassphrase(words, cryptoRng, 0)).toThrow(RangeError)
  })
})

describe('strength', () => {
  test('common or short passphrases fall below the minimum score', async () => {
    const check = await loadStrengthCheck()
    for (const weak of ['password', 'aparte2024', 'qwertyuiop', 'Summer2025!', 'letmein123']) {
      expect(check(weak).acceptable, weak).toBe(false)
    }
  })

  test('a generated passphrase and a long unusual sentence pass', async () => {
    const check = await loadStrengthCheck()
    expect(check(generatePassphrase(words, cryptoRng)).score).toBeGreaterThanOrEqual(MIN_SCORE)
    expect(check('my cat files tax returns in Lisbon every leap year').acceptable).toBe(true)
  })

  test('the estimator loads once and is shared', async () => {
    expect(await loadStrengthCheck()).toBe(await loadStrengthCheck())
  })
})
