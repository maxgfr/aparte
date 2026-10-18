import { describe, expect, test } from 'bun:test'
import { expectedScore, INITIAL_RATING, K_FACTOR, modelKey, standings } from './elo.ts'

const A = { provider: 'p1', id: 'alpha' }
const B = { provider: 'p1', id: 'beta' }
const C = { provider: 'p2', id: 'gamma' }

let n = 0
const vote = (a: typeof A, b: typeof A, winner: 'a' | 'b' | 'tie' | 'bad', createdAt = ++n) => ({
  id: `v${String(createdAt).padStart(4, '0')}`,
  createdAt,
  a,
  b,
  winner,
})

describe('Arena Elo', () => {
  test('expected score is symmetric and 0.5 between equals', () => {
    expect(expectedScore(1000, 1000)).toBe(0.5)
    expect(expectedScore(1200, 1000) + expectedScore(1000, 1200)).toBeCloseTo(1, 12)
    expect(expectedScore(1400, 1000)).toBeCloseTo(10 / 11, 12)
  })

  test('one win moves both ratings by K/2 from the start', () => {
    const [first, second] = standings([vote(A, B, 'a')])
    expect(first?.key).toBe(modelKey(A))
    expect(first?.rating).toBe(INITIAL_RATING + K_FACTOR / 2)
    expect(second?.rating).toBe(INITIAL_RATING - K_FACTOR / 2)
    expect(first).toMatchObject({ wins: 1, losses: 0, ties: 0, games: 1 })
    expect(second).toMatchObject({ wins: 0, losses: 1, ties: 0, games: 1 })
  })

  test('ratings are zero-sum, and a tie between equals moves nothing', () => {
    const table = standings([vote(A, B, 'a'), vote(B, C, 'b'), vote(C, A, 'tie'), vote(A, C, 'bad')])
    const total = table.reduce((sum, s) => sum + s.rating, 0)
    expect(total).toBeCloseTo(3 * INITIAL_RATING, 9)
    const even = standings([vote(A, B, 'tie')])
    expect(even.map((s) => s.rating)).toEqual([INITIAL_RATING, INITIAL_RATING])
    expect(even.every((s) => s.ties === 1)).toBe(true)
  })

  test('the result is independent of the order the votes arrive in', () => {
    const votes = [vote(A, B, 'a'), vote(A, C, 'b'), vote(B, C, 'tie'), vote(B, A, 'a'), vote(C, A, 'bad')]
    const forward = standings(votes)
    const shuffled = standings([votes[3], votes[0], votes[4], votes[2], votes[1]] as typeof votes)
    expect(shuffled).toEqual(forward)
  })

  test('a model against itself is skipped; standings are sorted by rating then games', () => {
    const table = standings([vote(A, A, 'a'), vote(B, C, 'b')])
    expect(table.map((s) => s.key)).toEqual([modelKey(C), modelKey(B)])
    expect(table.find((s) => s.key === modelKey(A))).toBeUndefined()
    expect(standings([])).toEqual([])
  })
})
