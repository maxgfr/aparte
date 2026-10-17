import { describe, expect, test } from 'bun:test'
import { InvalidStateError, type RngModule } from '../contracts/crypto.ts'
import * as rngImpl from './rng.ts'

const R: RngModule = rngImpl

describe('cryptoRng', () => {
  test('returns fresh ArrayBuffer-backed bytes of the requested length', () => {
    const rng = R.cryptoRng()
    const a = rng.bytes(32)
    const b = rng.bytes(32)
    expect(a).toHaveLength(32)
    expect(a.buffer).toBeInstanceOf(ArrayBuffer)
    expect(a).not.toEqual(b)
    expect(rng.bytes(0)).toHaveLength(0)
    expect(rng.bytes(70000)).toHaveLength(70000)
  })
})

describe('queueRng', () => {
  test('hands out the values in order, as copies', () => {
    const first = new Uint8Array([1, 2, 3])
    const rng = R.queueRng([first, new Uint8Array([4, 5])])
    expect(rng.remaining()).toBe(2)
    const drawn = rng.bytes(3)
    expect(drawn).toEqual(new Uint8Array([1, 2, 3]))
    drawn[0] = 9
    expect(first[0]).toBe(1)
    expect(rng.bytes(2)).toEqual(new Uint8Array([4, 5]))
    expect(rng.remaining()).toBe(0)
  })

  test('fails loudly on a draw of another length or past the end', () => {
    expect(() => R.queueRng([new Uint8Array(12)]).bytes(16)).toThrow(InvalidStateError)
    const rng = R.queueRng([new Uint8Array(1)])
    rng.bytes(1)
    expect(() => rng.bytes(1)).toThrow(InvalidStateError)
  })
})

describe('seededRng', () => {
  test('is deterministic per seed and differs between seeds', () => {
    expect(R.seededRng(1).bytes(16)).toEqual(R.seededRng(1).bytes(16))
    expect(R.seededRng(1).bytes(16)).not.toEqual(R.seededRng(2).bytes(16))
  })
})
