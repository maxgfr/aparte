import { describe, expect, test } from 'bun:test'
import type { ModelCost } from '../contracts/ai.ts'
import type { Message, ModelRef } from '../contracts/workspace.ts'
import { msg, newId, setup } from '../workspace/testkit.ts'
import { allMessages, nextPeriod, periodStart, summarize, usageCost, usageRecords } from './usage.ts'

const OPUS: ModelRef = { provider: 'pa', id: 'opus' }
const FLASH: ModelRef = { provider: 'pg', id: 'flash' }
const PRICES: Record<string, ModelCost> = { opus: { input: 5, output: 25, cacheRead: 0.5 } }
const priceOf = (m: ModelRef) => PRICES[m.id] ?? null

const day = (y: number, mo: number, d: number, h = 12) => new Date(y, mo - 1, d, h).getTime()

function answer(model: ModelRef, at: number, usage: Message['usage'], extra: Partial<Message> = {}): Message {
  return {
    id: newId(),
    conv: 'c',
    parent: null,
    role: 'assistant',
    parts: [],
    model,
    createdAt: at,
    status: 'done',
    ...(usage === undefined ? {} : { usage }),
    ...extra,
  }
}

describe('usage statistics', () => {
  test('cost from token counts and prices per million, cache reads priced apart', () => {
    expect(usageCost({ input: 1_000_000, output: 0 }, PRICES.opus as ModelCost)).toBe(5)
    expect(usageCost({ input: 1_000_000, output: 1_000_000, cacheRead: 500_000 }, PRICES.opus as ModelCost)).toBe(
      2.5 + 0.25 + 25,
    )
    expect(usageCost({ input: 10 }, null)).toBeNull()
    expect(usageCost(undefined, PRICES.opus as ModelCost)).toBeNull()
  })

  test('only answers with a model and usage count; unknown prices are counted apart', () => {
    const records = usageRecords(
      [
        answer(OPUS, day(2026, 10, 2), { input: 100, output: 50 }),
        answer(FLASH, day(2026, 10, 1), { input: 10, output: 5, reasoning: 2 }),
        answer(OPUS, day(2026, 10, 2), undefined),
        { ...answer(OPUS, day(2026, 10, 2), { input: 1, output: 1 }), role: 'user' },
        answer(OPUS, day(2026, 10, 2), {}),
      ],
      priceOf,
    )
    expect(records.map((r) => r.model.id)).toEqual(['flash', 'opus'])
    const s = summarize(records, { bucket: 'day', by: 'model' })
    expect(s.totals).toEqual({
      answers: 2,
      input: 110,
      output: 55,
      cacheRead: 0,
      reasoning: 2,
      cost: (100 * 5 + 50 * 25) / 1_000_000,
      unpriced: 1,
    })
    expect(s.groups.map((g) => g.key)).toEqual(['pa/opus', 'pg/flash'])
  })

  test('periods run from the first to the last answer, empty ones included, by local calendar', () => {
    const records = usageRecords(
      [
        answer(OPUS, day(2026, 10, 1, 23), { input: 1, output: 1 }),
        answer(FLASH, day(2026, 10, 4, 0), { input: 2, output: 2 }),
        answer(FLASH, day(2026, 10, 4, 22), { input: 3, output: 3 }),
      ],
      priceOf,
    )
    const daily = summarize(records, { bucket: 'day', by: 'provider' })
    expect(daily.periods.map((p) => p.start)).toEqual([
      day(2026, 10, 1, 0),
      day(2026, 10, 2, 0),
      day(2026, 10, 3, 0),
      day(2026, 10, 4, 0),
    ])
    expect(daily.periods.map((p) => p.totals.answers)).toEqual([1, 0, 0, 2])
    expect(daily.periods[3]?.groups.get('pg')?.input).toBe(5)
    const weekly = summarize(records, { bucket: 'week', by: 'provider' })
    // 2026-10-01 is a Thursday: its week starts Monday 2026-09-28; Sunday 2026-10-04 is in the same week.
    expect(weekly.periods.map((p) => p.start)).toEqual([day(2026, 9, 28, 0)])
    expect(summarize(records, { bucket: 'month', by: 'model' }).periods).toHaveLength(1)
    const ranged = summarize(records, { bucket: 'day', by: 'model', from: day(2026, 10, 2, 0) })
    expect(ranged.totals.answers).toBe(2)
    expect(summarize([], { bucket: 'day', by: 'model' }).periods).toEqual([])
  })

  test('calendar steps', () => {
    expect(periodStart(day(2026, 10, 18, 15), 'month')).toBe(day(2026, 10, 1, 0))
    expect(nextPeriod(day(2026, 12, 1, 0), 'month')).toBe(day(2027, 1, 1, 0))
    expect(nextPeriod(day(2026, 10, 31, 0), 'day')).toBe(day(2026, 11, 1, 0))
  })

  test('reads every conversation of the workspace, archived and trashed ones too', async () => {
    const { ws } = await setup()
    const ids = [ws.conversations.create(), ws.conversations.create(), ws.conversations.create()]
    for (const id of ids) {
      const thread = await ws.thread(id)
      const u = newId()
      thread.commit(msg(u, null, 'user', 'q'))
      thread.commit({ ...msg(newId(), u, 'assistant', 'a'), model: OPUS, usage: { input: 3, output: 4 } })
    }
    ws.conversations.update(ids[1] as string, { archived: true })
    ws.conversations.trash(ids[2] as string)
    const records = usageRecords(await allMessages(ws), priceOf)
    expect(records).toHaveLength(3)
    ws.close()
  })
})
