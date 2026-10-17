/*
 * Fractional index strings for manual ordering among siblings (spec/DATA-MODEL.md section 3). Keys are compared as
 * plain strings (code unit order), so the alphabet is ASCII in increasing order.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const MID = 'V'

/** A key that sorts after `key` (after every key when `key` is null). */
export function keyAfter(key: string | null): string {
  if (key === null || key === '') return MID
  const last = key.charAt(key.length - 1)
  const at = DIGITS.indexOf(last)
  // A last digit below the top increments in place; otherwise the key grows by one digit, which sorts after it.
  if (at >= 0 && at < DIGITS.length - 1) return key.slice(0, -1) + DIGITS.charAt(at + 1)
  return key + MID
}
