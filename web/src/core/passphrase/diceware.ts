/*
 * Diceware passphrases drawn from the EFF large wordlist ("EFF's Long Wordlist" by the Electronic Frontier
 * Foundation, https://www.eff.org/dice, CC BY 3.0 US; see LICENSE-EFF.txt next to this file).
 *
 * Invariants:
 * - Every word is drawn uniformly from exactly 7776 distinct words, by rejection sampling over two random bytes, so
 *   each word carries log2(7776) ≈ 12.9 bits and six words about 77.5 bits.
 * - A list of another size or with duplicates is refused at parse time: a truncated list would silently lower the
 *   entropy the interface promises.
 */

import type { Rng } from '../contracts/crypto.ts'

/** Number of words of the EFF large wordlist. */
export const EFF_WORDLIST_SIZE = 7776

/** Words of a generated passphrase: about 77.5 bits, beyond any offline guessing even before Argon2. */
export const DEFAULT_WORD_COUNT = 6

/** Words are joined with a hyphen, which every keyboard has and no autocorrect touches. */
export const SEPARATOR = '-'

/** Two random bytes give 65536 values; draws at or above the last multiple of 7776 are rejected. */
const LIMIT = 65536 - (65536 % EFF_WORDLIST_SIZE)

/** One word per line, lowercase letters and inner hyphens only; exactly 7776 distinct words. */
export function parseWordlist(raw: string): readonly string[] {
  const words = raw
    .split('\n')
    .map((w) => w.trim())
    .filter((w) => w !== '')
  if (words.length !== EFF_WORDLIST_SIZE) {
    throw new Error(`wordlist: expected ${EFF_WORDLIST_SIZE} words, got ${words.length}`)
  }
  if (new Set(words).size !== EFF_WORDLIST_SIZE) throw new Error('wordlist: words must be distinct')
  const bad = words.find((w) => !/^[a-z]+(?:-[a-z]+)*$/.test(w))
  if (bad !== undefined) throw new Error(`wordlist: unexpected word ${JSON.stringify(bad)}`)
  return Object.freeze(words)
}

/** A uniform index in [0, 7776) from `rng`. */
export function wordIndex(rng: Rng): number {
  for (;;) {
    const b = rng.bytes(2)
    const value = ((b[0] ?? 0) << 8) | (b[1] ?? 0)
    if (value < LIMIT) return value % EFF_WORDLIST_SIZE
  }
}

/** `count` words drawn uniformly and independently, joined with SEPARATOR. */
export function generatePassphrase(words: readonly string[], rng: Rng, count = DEFAULT_WORD_COUNT): string {
  if (words.length !== EFF_WORDLIST_SIZE) throw new Error('generatePassphrase: needs the parsed EFF wordlist')
  if (!Number.isInteger(count) || count < 1) throw new RangeError('generatePassphrase: count must be at least 1')
  const out: string[] = []
  for (let i = 0; i < count; i++) out.push(words[wordIndex(rng)] as string)
  return out.join(SEPARATOR)
}

/** Entropy in bits of a generated passphrase of `count` words. */
export function passphraseBits(count = DEFAULT_WORD_COUNT): number {
  return count * Math.log2(EFF_WORDLIST_SIZE)
}
