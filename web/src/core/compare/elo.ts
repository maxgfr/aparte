/*
 * The Arena leaderboard: Elo ratings recomputed from the stored votes (contracts/extras.ts `ArenaVote`), never stored
 * themselves. Votes are replayed oldest first (`createdAt`, then id), so every device that holds the same votes ranks
 * the models the same way, whatever order sync delivered them in.
 */

import type { ArenaVote } from '../contracts/extras.ts'
import type { Entity, ModelRef } from '../contracts/workspace.ts'

/** Every model starts here. */
export const INITIAL_RATING = 1000
/** How far one game moves a rating. */
export const K_FACTOR = 32

export interface Standing {
  /** `<provider>/<model id>`: the key of `modelKey`. */
  readonly key: string
  readonly model: ModelRef
  readonly rating: number
  readonly wins: number
  readonly losses: number
  readonly ties: number
  readonly games: number
}

/** The key a model is ranked under. */
export function modelKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.id}`
}

/** The probability the Elo model gives `a` of beating `b`. */
export function expectedScore(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400))
}

type Vote = Pick<Entity<ArenaVote>, 'id' | 'createdAt' | 'a' | 'b' | 'winner'>

/**
 * The standings after replaying `votes`: highest rating first, then most games, then by key. A vote between a model
 * and itself, or with an unknown outcome, is skipped.
 */
export function standings(votes: readonly Vote[]): readonly Standing[] {
  const ordered = [...votes].sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  const table = new Map<string, { model: ModelRef; rating: number; wins: number; losses: number; ties: number }>()
  const row = (model: ModelRef) => {
    const key = modelKey(model)
    let r = table.get(key)
    if (r === undefined) {
      r = { model: { provider: model.provider, id: model.id }, rating: INITIAL_RATING, wins: 0, losses: 0, ties: 0 }
      table.set(key, r)
    }
    return r
  }
  for (const vote of ordered) {
    if (modelKey(vote.a) === modelKey(vote.b)) continue
    const score =
      vote.winner === 'a' ? 1 : vote.winner === 'b' ? 0 : vote.winner === 'tie' || vote.winner === 'bad' ? 0.5 : null
    if (score === null) continue
    const a = row(vote.a)
    const b = row(vote.b)
    const ea = expectedScore(a.rating, b.rating)
    a.rating += K_FACTOR * (score - ea)
    b.rating += K_FACTOR * (1 - score - (1 - ea))
    if (score === 1) {
      a.wins++
      b.losses++
    } else if (score === 0) {
      b.wins++
      a.losses++
    } else {
      a.ties++
      b.ties++
    }
  }
  return [...table.entries()]
    .map(([key, r]) => ({ key, ...r, games: r.wins + r.losses + r.ties }))
    .sort((x, y) => y.rating - x.rating || y.games - x.games || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
}
