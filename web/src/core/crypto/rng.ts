/*
 * Sources of randomness. Production code takes an Rng as a parameter and is handed cryptoRng(); the vectors hand it a
 * queueRng loaded with the values of spec/vectors/inputs.json, in the order spec/FORMAT.md sections 6.6 and 7.6 fix.
 */
import { type Bytes, InvalidStateError, type QueueRng, type Rng } from '../contracts/crypto.ts'
import { copy } from './bytes.ts'

/** crypto.getRandomValues fills at most 65 536 bytes per call. */
const MAX_DRAW = 65536

function checkLength(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`Invalid random length ${n}`)
}

export function cryptoRng(): Rng {
  return {
    bytes(n: number): Bytes {
      checkLength(n)
      const out = new Uint8Array(n)
      for (let offset = 0; offset < n; offset += MAX_DRAW) {
        crypto.getRandomValues(out.subarray(offset, Math.min(n, offset + MAX_DRAW)))
      }
      return out
    },
  }
}

export function queueRng(values: readonly Uint8Array[]): QueueRng {
  // Copied up front, so a caller mutating its array afterwards cannot change what is drawn.
  const queue = values.map((value) => copy(value))
  let next = 0
  return {
    bytes(n: number): Bytes {
      checkLength(n)
      const value = queue[next]
      if (value === undefined) throw new InvalidStateError(`Queued RNG exhausted: a draw of ${n} bytes`)
      if (value.length !== n) {
        throw new InvalidStateError(`Queued RNG: drew ${n} bytes where the next value has ${value.length}`)
      }
      next++
      return copy(value)
    },
    remaining(): number {
      return queue.length - next
    },
  }
}

/** SplitMix32-style generator: deterministic and fast, NOT cryptographic. Tests only. */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x9e3779b9) >>> 0
    let z = state
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0
    return (z ^ (z >>> 16)) >>> 0
  }
  return {
    bytes(n: number): Bytes {
      checkLength(n)
      const out = new Uint8Array(n)
      for (let i = 0; i < n; i += 4) {
        const word = next()
        for (let j = 0; j < 4 && i + j < n; j++) out[i + j] = (word >>> (8 * j)) & 0xff
      }
      return out
    },
  }
}
