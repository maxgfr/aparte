/*
 * Write pacing for stores with secondary rate limits (GitHub: about 80 content-creating requests a minute and 500 an
 * hour). Every write request waits for a slot: evenly spaced (60 s / `perMinute` apart, so never a burst), at most
 * `perHour` in any hour, and none before a pause the server asked for (403 or 429 with Retry-After) is over. Time and
 * sleeping are injected, so tests check the spacing without waiting.
 */

export interface PacerDeps {
  readonly now: () => number
  /** Resolves after `ms`; real timers in the app, a virtual clock in tests. */
  readonly sleep: (ms: number) => Promise<void>
  readonly perMinute?: number
  readonly perHour?: number
}

export interface Pacer {
  /** Waits until a write may go out, then counts it. Calls are served in order. */
  slot(): Promise<void>
  /** No write before `ms` from now. */
  pause(ms: number): void
  /** Milliseconds between writes at the sustained pace. */
  readonly msPerWrite: number
  /** Writes sent so far, with their times (for tests and the status screen). */
  readonly sent: readonly number[]
}

export const WRITES_PER_MINUTE = 60
/** Below GitHub's 500 an hour, so a long upload never reaches the hourly limit. */
export const WRITES_PER_HOUR = 450

export function createPacer(deps: PacerDeps): Pacer {
  const perMinute = deps.perMinute ?? WRITES_PER_MINUTE
  const perHour = deps.perHour ?? WRITES_PER_HOUR
  const sent: number[] = []
  let pausedUntil = 0
  let tail: Promise<void> = Promise.resolve()

  const spacing = Math.ceil(60_000 / perMinute)

  /** Earliest time the next write may go out. */
  const nextAt = (): number => {
    const now = deps.now()
    let at = Math.max(now, pausedUntil)
    const last = sent.at(-1)
    if (last !== undefined) at = Math.max(at, last + spacing)
    const inMinute = sent.filter((t) => t > at - 60_000)
    if (inMinute.length >= perMinute) at = Math.max(at, (inMinute[inMinute.length - perMinute] as number) + 60_000)
    const inHour = sent.filter((t) => t > at - 3_600_000)
    if (inHour.length >= perHour) at = Math.max(at, (inHour[inHour.length - perHour] as number) + 3_600_000)
    return at
  }

  const take = async (): Promise<void> => {
    for (;;) {
      const wait = nextAt() - deps.now()
      if (wait <= 0) break
      await deps.sleep(wait)
    }
    sent.push(deps.now())
    // Only the last hour matters.
    const horizon = deps.now() - 3_600_000
    while (sent.length > 0 && (sent[0] as number) <= horizon) sent.shift()
  }

  return {
    slot() {
      const run = tail.then(take, take)
      tail = run.catch(() => undefined)
      return run
    },
    pause(ms) {
      pausedUntil = Math.max(pausedUntil, deps.now() + ms)
    },
    msPerWrite: spacing,
    sent,
  }
}
