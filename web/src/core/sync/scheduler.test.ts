import { describe, expect, test } from 'bun:test'
import { RemoteError, type RoundResult } from '../contracts/sync.ts'
import { seededRng } from '../crypto/rng.ts'
import { FakeClock } from '../workspace/testkit.ts'
import {
  BACKOFF_MAX_MS,
  backoffDelay,
  createScheduler,
  DEBOUNCE_MS,
  VISIBLE_INTERVAL_MS,
  virtualTimers,
} from './scheduler.ts'

/* Ported from the cursus scheduler tests: every timer is virtual, so the whole schedule runs in a few milliseconds. */

const virtualClock = (t: number) => {
  const clock = new FakeClock()
  clock.t = t
  return clock
}

type Outcome = RoundResult | Error

function fakeEngine(dests: string[], script: Record<string, Outcome[]> = {}) {
  const calls: string[] = []
  const notes: [string, number | undefined][] = []
  const gates: (() => void)[] = []
  let gated = false
  return {
    calls,
    notes,
    gate(on: boolean) {
      gated = on
    },
    open() {
      for (const g of gates.splice(0)) g()
    },
    engine: {
      destinations: () => dests,
      noteSchedule: (d: string, at: number | undefined) => notes.push([d, at]),
      async round(d: string): Promise<RoundResult> {
        calls.push(d)
        if (gated) await new Promise<void>((r) => gates.push(r))
        const next = script[d]?.shift()
        if (next instanceof Error) throw next
        return next ?? { down: 0, up: 0, deferred: 0 }
      },
    },
  }
}

function setup(
  dests: string[],
  script: Record<string, Outcome[]> = {},
  o: { visible?: boolean; online?: boolean } = {},
) {
  const clock = virtualClock(0)
  const timers = virtualTimers(clock)
  const fe = fakeEngine(dests, script)
  const errors: unknown[] = []
  const env = { visible: o.visible ?? true, online: o.online ?? true }
  const s = createScheduler({
    engine: fe.engine,
    clock,
    rng: seededRng(1),
    timers,
    isVisible: () => env.visible,
    isOnline: () => env.online,
    onError: (_d, e) => errors.push(e),
  })
  return { clock, timers, fe, s, errors, env }
}

describe('backoffDelay', () => {
  test('grows from 1 s to 5 min with jitter in [base/2, base], never below Retry-After', () => {
    const rng = seededRng(3)
    for (let n = 1; n <= 12; n++) {
      const base = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** (n - 1))
      for (let i = 0; i < 20; i++) {
        const d = backoffDelay(n, rng)
        expect(d).toBeGreaterThanOrEqual(base / 2)
        expect(d).toBeLessThanOrEqual(base)
      }
    }
    expect(backoffDelay(1, rng, 30_000)).toBe(30_000)
    expect(backoffDelay(30, rng, 10 * 60_000)).toBe(10 * 60_000)
  })
})

describe('scheduler', () => {
  test('startup runs every destination, then every 60 s while visible only', async () => {
    const { s, fe, timers, env } = setup(['a', 'b'])
    s.trigger('manual') // not started: ignored
    expect(fe.calls).toEqual([])
    s.start()
    s.start()
    await s.whenIdle()
    expect(fe.calls).toEqual(['a', 'b'])
    // The timer's round starts once its debounce is over.
    timers.advance(VISIBLE_INTERVAL_MS + DEBOUNCE_MS)
    await s.whenIdle()
    expect(fe.calls.length).toBe(4)
    env.visible = false
    timers.advance(VISIBLE_INTERVAL_MS)
    await s.whenIdle()
    expect(fe.calls.length).toBe(4)
    s.trigger('visible')
    timers.advance(DEBOUNCE_MS)
    await s.whenIdle()
    expect(fe.calls.length).toBe(6)
    s.stop()
    timers.advance(10 * VISIBLE_INTERVAL_MS)
    await s.whenIdle()
    expect(fe.calls.length).toBe(6)
    expect(timers.pending()).toBe(0)
  })

  test('offline: automatic triggers wait for "online"; manual always runs', async () => {
    const { s, fe, env } = setup(['a'], {}, { online: false })
    s.start()
    s.trigger('sealed')
    await s.whenIdle()
    expect(fe.calls).toEqual([])
    s.trigger('manual')
    await s.whenIdle()
    expect(fe.calls).toEqual(['a'])
    env.online = true
    s.trigger('online')
    await s.whenIdle()
    expect(fe.calls).toEqual(['a', 'a'])
  })

  test('failures back off per destination, honour Retry-After, then reset on success', async () => {
    const { s, fe, timers, clock, errors } = setup(['a', 'b'], {
      a: [new RemoteError('network', 'down'), new RemoteError('rate-limited', '429', { retryAfterMs: 45_000 })],
    })
    s.start()
    await s.whenIdle()
    expect(errors.length).toBe(1)
    expect(s.failures('a')).toBe(1)
    const first = fe.notes.find(([d, at]) => d === 'a' && at !== undefined)?.[1] ?? 0
    expect(first - clock.now()).toBeGreaterThanOrEqual(500)
    expect(first - clock.now()).toBeLessThanOrEqual(1000)
    // a trigger during backoff skips the backed-off destination only ('online' is not debounced: it runs now)
    s.trigger('online')
    await s.whenIdle()
    expect(fe.calls.filter((c) => c === 'a').length).toBe(1)
    expect(fe.calls.filter((c) => c === 'b').length).toBe(2)
    timers.advance(1000)
    await s.whenIdle()
    expect(s.failures('a')).toBe(2)
    const second = fe.notes.filter(([d, at]) => d === 'a' && at !== undefined).at(-1)?.[1] ?? 0
    expect(second - clock.now()).toBe(45_000)
    timers.advance(45_000)
    await s.whenIdle()
    expect(s.failures('a')).toBe(0)
    expect(fe.notes.at(-1)).toEqual(['a', undefined])
  })

  test('manual trigger bypasses the backoff', async () => {
    const { s, fe } = setup(['a'], { a: [new RemoteError('network', 'down')] })
    s.start()
    await s.whenIdle()
    expect(s.failures('a')).toBe(1)
    s.trigger('manual')
    await s.whenIdle()
    expect(fe.calls).toEqual(['a', 'a'])
    expect(s.failures('a')).toBe(0)
  })

  test('deferred work is retried later with backoff', async () => {
    const { s, fe, timers } = setup(['a'], { a: [{ down: 0, up: 0, deferred: 2 }] })
    s.start()
    await s.whenIdle()
    expect(s.failures('a')).toBe(1)
    timers.advance(1000)
    await s.whenIdle()
    expect(fe.calls).toEqual(['a', 'a'])
    expect(s.failures('a')).toBe(0)
  })

  test('a trigger during a round queues exactly one more round', async () => {
    const { s, fe, timers } = setup(['a'])
    fe.gate(true)
    s.start()
    s.trigger('sealed')
    s.trigger('sealed')
    s.trigger('visible')
    timers.advance(DEBOUNCE_MS)
    s.trigger('online')
    fe.gate(false)
    fe.open()
    await s.whenIdle()
    expect(fe.calls).toEqual(['a', 'a'])
  })

  test('seal, visible and timer triggers within 2 s make one round', async () => {
    const { s, fe, timers } = setup(['a'])
    s.start()
    await s.whenIdle()
    s.trigger('sealed')
    timers.advance(DEBOUNCE_MS / 2)
    s.trigger('visible')
    s.trigger('sealed')
    timers.advance(DEBOUNCE_MS / 2 - 1)
    await s.whenIdle()
    expect(fe.calls).toEqual(['a'])
    timers.advance(1)
    await s.whenIdle()
    expect(fe.calls).toEqual(['a', 'a'])
    // Stopping drops a burst still waiting.
    s.trigger('sealed')
    s.stop()
    timers.advance(DEBOUNCE_MS)
    await s.whenIdle()
    expect(fe.calls).toEqual(['a', 'a'])
  })

  test('the timer skips a round when one succeeded less than 60 s before; a seal never does', async () => {
    const { s, fe, timers } = setup(['a'])
    s.start() // t = 0
    await s.whenIdle()
    timers.advance(30_000)
    s.trigger('sealed') // its round starts at 32 s
    timers.advance(DEBOUNCE_MS)
    await s.whenIdle()
    expect(fe.calls.length).toBe(2)
    timers.advance(60_000 - 32_000 + DEBOUNCE_MS) // the 60 s timer, 30 s after that round: skipped
    await s.whenIdle()
    expect(fe.calls.length).toBe(2)
    s.trigger('timer')
    s.trigger('sealed') // a seal in the same burst still syncs
    timers.advance(DEBOUNCE_MS)
    await s.whenIdle()
    expect(fe.calls.length).toBe(3)
    // The 120 s timer comes 58 s after that round (skipped), the 180 s one well after it.
    timers.advance(VISIBLE_INTERVAL_MS)
    await s.whenIdle()
    expect(fe.calls.length).toBe(3)
    timers.advance(VISIBLE_INTERVAL_MS)
    await s.whenIdle()
    expect(fe.calls.length).toBe(4)
  })

  test('stop drops pending retries', async () => {
    const { s, fe, timers } = setup(['a'], { a: [new RemoteError('network', 'down')] })
    s.start()
    await s.whenIdle()
    s.stop()
    timers.advance(BACKOFF_MAX_MS)
    await s.whenIdle()
    expect(fe.calls).toEqual(['a'])
  })

  test('virtual timers fire in due order and can be cancelled', async () => {
    const clock = virtualClock(0)
    const t = virtualTimers(clock)
    const fired: string[] = []
    t.set(() => fired.push('b'), 20)
    const cancel = t.set(() => fired.push('x'), 5)
    t.set(() => fired.push('a'), 10)
    cancel()
    cancel()
    t.advance(15)
    expect(fired).toEqual(['a'])
    expect(clock.now()).toBe(15)
    t.advance(100)
    expect(fired).toEqual(['a', 'b'])
    expect(clock.now()).toBe(115)
  })
})
