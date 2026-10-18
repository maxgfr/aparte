/*
 * When rounds run (ported from the cursus scheduler): at startup, after local changes are saved, when the device is
 * back online or the page visible again, every minute while visible, and on demand. Changes, visibility and the timer
 * are debounced together (2 s), a timer round is skipped right after a successful one, one round runs at a time per
 * destination (a trigger during a round queues exactly one more), and failures back off per destination from 1 s to
 * 5 min with jitter, never sooner than the store's Retry-After. A manual trigger skips the backoff.
 */

import type { Rng } from '../contracts/crypto.ts'
import { RemoteError, type RoundResult, type Scheduler, type Trigger } from '../contracts/sync.ts'
import type { Clock } from '../contracts/vault.ts'

/** Timer port: real timers in the app, virtual ones in tests. Returns the cancel function. */
export interface SchedulerTimers {
  set(fn: () => void, ms: number): () => void
}

export const BACKOFF_BASE_MS = 1000
export const BACKOFF_MAX_MS = 5 * 60_000
export const VISIBLE_INTERVAL_MS = 60_000
export const DEBOUNCE_MS = 2000

/** n-th consecutive failure: a delay in [base/2, base], base = min(max, 1 s * 2^(n-1)); never below Retry-After. */
export function backoffDelay(failures: number, rng: Rng, retryAfterMs?: number): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1))
  const draw = rng.bytes(2)
  const unit = ((draw[0] ?? 0) * 256 + (draw[1] ?? 0)) / 65_536
  const jittered = Math.round(base / 2 + unit * (base / 2))
  return Math.max(jittered, retryAfterMs ?? 0)
}

export interface SchedulerOptions {
  readonly engine: {
    round(dest: string): Promise<RoundResult>
    destinations(): readonly string[]
    noteSchedule(dest: string, nextTryAt: number | undefined): void
  }
  readonly clock: Clock
  readonly rng: Rng
  readonly timers: SchedulerTimers
  readonly isVisible?: () => boolean
  readonly isOnline?: () => boolean
  /** Every failure is reported here (the engine already put it in the destination's status). */
  readonly onError?: (dest: string, error: unknown) => void
}

export interface SyncScheduler extends Scheduler {
  /** Resolves once no round is running. */
  whenIdle(): Promise<void>
  failures(dest: string): number
}

interface PerDest {
  running: Promise<void> | null
  again: boolean
  failures: number
  nextTryAt?: number
  cancel?: () => void
  okStartedAt?: number
}

const DEBOUNCED: ReadonlySet<Trigger> = new Set<Trigger>(['sealed', 'visible', 'timer'])

export function createScheduler(o: SchedulerOptions): SyncScheduler {
  const per = new Map<string, PerDest>()
  let started = false
  let cancelTick: (() => void) | null = null
  let cancelDebounce: (() => void) | null = null
  let timerOnly = true
  const visible = (): boolean => o.isVisible?.() ?? true
  const online = (): boolean => o.isOnline?.() ?? true

  const state = (dest: string): PerDest => {
    let s = per.get(dest)
    if (!s) {
      s = { running: null, again: false, failures: 0 }
      per.set(dest, s)
    }
    return s
  }

  const retryLater = (dest: string, s: PerDest, retryAfterMs?: number): void => {
    s.failures++
    const delay = backoffDelay(s.failures, o.rng, retryAfterMs)
    s.nextTryAt = o.clock.now() + delay
    s.cancel?.()
    s.cancel = o.timers.set(() => {
      s.cancel = undefined
      if (started) run(dest)
    }, delay)
    o.engine.noteSchedule(dest, s.nextTryAt)
  }

  const run = (dest: string): void => {
    const s = state(dest)
    if (s.running) {
      s.again = true
      return
    }
    s.running = (async () => {
      const startedAt = o.clock.now()
      try {
        const r = await o.engine.round(dest)
        if (r.deferred > 0) retryLater(dest, s)
        else {
          s.okStartedAt = startedAt
          s.failures = 0
          s.nextTryAt = undefined
          s.cancel?.()
          s.cancel = undefined
          o.engine.noteSchedule(dest, undefined)
        }
      } catch (error) {
        o.onError?.(dest, error)
        if (started) retryLater(dest, s, error instanceof RemoteError ? error.retryAfterMs : undefined)
      } finally {
        s.running = null
        if (s.again && started) {
          s.again = false
          run(dest)
        }
      }
    })()
  }

  const fire = (reason: Trigger): void => {
    const now = o.clock.now()
    for (const dest of o.engine.destinations()) {
      const s = state(dest)
      if (reason === 'manual') {
        s.failures = 0
        s.nextTryAt = undefined
        s.cancel?.()
        s.cancel = undefined
      } else if (s.nextTryAt !== undefined && now < s.nextTryAt) continue
      // The timer only keeps a quiet screen up to date: a round that just succeeded already did.
      if (reason === 'timer' && s.okStartedAt !== undefined && now - s.okStartedAt < VISIBLE_INTERVAL_MS) continue
      run(dest)
    }
  }

  const tick = (): void => {
    cancelTick = o.timers.set(() => {
      if (!started) return
      if (visible()) self.trigger('timer')
      tick()
    }, VISIBLE_INTERVAL_MS)
  }

  const self: SyncScheduler = {
    start() {
      if (started) return
      started = true
      self.trigger('startup')
      tick()
    },
    stop() {
      started = false
      cancelTick?.()
      cancelTick = null
      cancelDebounce?.()
      cancelDebounce = null
      timerOnly = true
      for (const s of per.values()) {
        s.cancel?.()
        s.cancel = undefined
        s.again = false
      }
    },
    trigger(reason) {
      if (!started) return
      if (reason !== 'manual' && !online()) return
      if (DEBOUNCED.has(reason)) {
        if (reason !== 'timer') timerOnly = false
        cancelDebounce ??= o.timers.set(() => {
          cancelDebounce = null
          const burst: Trigger = timerOnly ? 'timer' : 'sealed'
          timerOnly = true
          if (started && online()) fire(burst)
        }, DEBOUNCE_MS)
        return
      }
      fire(reason)
    },
    async whenIdle() {
      for (;;) {
        const running = [...per.values()].map((s) => s.running).filter((p): p is Promise<void> => p !== null)
        if (running.length === 0) return
        await Promise.all(running)
      }
    },
    failures: (dest) => per.get(dest)?.failures ?? 0,
  }
  return self
}

/** Virtual timers driven by a test clock: nothing real ever runs. */
export function virtualTimers(clock: { now(): number; t: number }): SchedulerTimers & {
  advance(ms: number): void
  pending(): number
} {
  let seq = 0
  const queue: { at: number; seq: number; fn: () => void }[] = []
  return {
    set(fn, ms) {
      const t = { at: clock.now() + Math.max(0, ms), seq: seq++, fn }
      queue.push(t)
      return () => {
        const i = queue.indexOf(t)
        if (i >= 0) queue.splice(i, 1)
      }
    },
    advance(ms) {
      const end = clock.now() + ms
      for (;;) {
        queue.sort((a, b) => a.at - b.at || a.seq - b.seq)
        const next = queue[0]
        if (!next || next.at > end) break
        queue.shift()
        if (next.at > clock.now()) clock.t = next.at
        next.fn()
      }
      if (end > clock.now()) clock.t = end
    },
    pending: () => queue.length,
  }
}
