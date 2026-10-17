import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import type { PadmeModule } from '../contracts/crypto.ts'
import * as padmeImpl from './padme.ts'

const P: PadmeModule = padmeImpl

// Computed from the definition in spec/FORMAT.md section 7.4, independently of the implementation.
const table: [number, number][] = [
  [0, 0],
  [1, 1],
  [2, 2],
  [3, 3],
  [4, 4],
  [5, 5],
  [7, 7],
  [8, 8],
  [9, 10],
  [15, 16],
  [16, 16],
  [17, 18],
  [31, 32],
  [32, 32],
  [33, 36],
  [63, 64],
  [64, 64],
  [65, 72],
  [66, 72],
  [100, 104],
  [127, 128],
  [128, 128],
  [129, 144],
  [255, 256],
  [256, 256],
  [257, 272],
  [1000, 1024],
  [1023, 1024],
  [1024, 1024],
  [1025, 1088],
  [4096, 4096],
  [65535, 65536],
  [65536, 65536],
  [65537, 67584],
  [1000000, 1015808],
  [2097152, 2097152],
  [2097156, 2162688],
  [2097157, 2162688],
]

describe('padme', () => {
  test.each(table)('padme(%p) = %p', (length, padded) => {
    expect(P.padme(length)).toBe(padded)
  })

  test('never shrinks, adds less than 12.5 %, is idempotent and monotonic', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 30 }), fc.integer({ min: 0, max: 2 ** 30 }), (a, b) => {
        const pa = P.padme(a)
        expect(pa).toBeGreaterThanOrEqual(a)
        expect(pa - a).toBeLessThanOrEqual(a / 8)
        expect(P.padme(pa)).toBe(pa)
        if (a <= b) expect(pa).toBeLessThanOrEqual(P.padme(b))
      }),
    )
  })

  test.each([-1, 1.5, Number.NaN, 2 ** 31])('rejects %p', (length) => {
    expect(() => P.padme(length)).toThrow(RangeError)
  })
})

describe('paddedSize', () => {
  test.each([
    [0, 64],
    [60, 64],
    [61, 72],
    [62, 72],
    [1000, 1024],
    [2097152, 2162688],
  ])('a payload of %p bytes pads to %p', (payload, size) => {
    expect(P.paddedSize(payload)).toBe(size)
  })

  test('is max(64, padme(4 + n))', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 26 }), (n) => {
        expect(P.paddedSize(n)).toBe(Math.max(64, P.padme(4 + n)))
      }),
    )
  })
})
