/*
 * Padmé padding (Nikitin et al., PETS 2019), as spec/FORMAT.md section 7.4 defines it. The arithmetic avoids 32-bit
 * bitwise operators on the sum, which would overflow just below 2^31.
 */

/** Lengths are below 2^31, which keeps every padded size below 2^32 and every step exact in a double. */
const LIMIT = 2 ** 31

/** The smallest envelope plaintext: u32be(n) plus 60 bytes. */
const MIN_PLAINTEXT = 64

export function padme(length: number): number {
  if (!Number.isSafeInteger(length) || length < 0 || length >= LIMIT) {
    throw new RangeError(`Invalid Padmé length ${length}`)
  }
  if (length < 2) return length
  const e = 31 - Math.clz32(length)
  const s = 32 - Math.clz32(e)
  const step = 2 ** (e - s)
  return Math.ceil(length / step) * step
}

export function paddedSize(payloadLength: number): number {
  if (!Number.isSafeInteger(payloadLength) || payloadLength < 0 || payloadLength >= LIMIT - 4) {
    throw new RangeError(`Invalid payload length ${payloadLength}`)
  }
  return Math.max(MIN_PLAINTEXT, padme(4 + payloadLength))
}
