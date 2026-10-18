/*
 * Usage statistics, computed on this device from the committed assistant messages: token counts as each provider
 * reported them (`usage`, spec/DATA-MODEL.md section 4) and their cost at the model's catalog prices. Nothing is
 * stored: the figures are recomputed from the messages each time, so they always agree with the history.
 */

import type { ModelCost, Usage } from '../contracts/ai.ts'
import type { Id, Message, ModelRef, Workspace } from '../contracts/workspace.ts'

/** One answer that reported its usage. */
export interface UsageRecord {
  readonly at: number
  readonly conversation: Id
  readonly model: ModelRef
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly reasoning: number
  /** US dollars, or null when the model's prices are unknown. */
  readonly cost: number | null
}

export interface Totals {
  readonly answers: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly reasoning: number
  /** The cost of the answers whose prices are known. */
  readonly cost: number
  /** Answers counted in the tokens but not in `cost`. */
  readonly unpriced: number
}

export type Bucket = 'day' | 'week' | 'month'
export type GroupBy = 'provider' | 'model'

export interface Period {
  /** Local midnight that opens the period. */
  readonly start: number
  readonly totals: Totals
  /** The same totals by group key (`provider` id or `provider/model`). */
  readonly groups: ReadonlyMap<string, Totals>
}

export interface Summary {
  readonly totals: Totals
  /** Every period from the first to the last answer, empty ones included, oldest first. */
  readonly periods: readonly Period[]
  /** Totals by group, largest token count first. */
  readonly groups: readonly { readonly key: string; readonly model: ModelRef; readonly totals: Totals }[]
}

export const EMPTY_TOTALS: Totals = Object.freeze({
  answers: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  reasoning: 0,
  cost: 0,
  unpriced: 0,
})

/**
 * What a response cost in US dollars from its token counts and the model's prices (per million tokens), or null when
 * either is unknown. Cached reads and cache writes are parts of `input` and priced on their own.
 */
export function usageCost(usage: Usage | undefined, cost: ModelCost | null): number | null {
  if (usage === undefined || cost === null) return null
  if (usage.input === undefined && usage.output === undefined) return null
  const input = usage.input ?? 0
  const read = usage.cacheRead ?? 0
  const write = usage.cacheWrite ?? 0
  const fresh = Math.max(0, input - read - write)
  const total =
    fresh * cost.input +
    read * (cost.cacheRead ?? cost.input) +
    write * (cost.cacheWrite ?? cost.input) +
    (usage.output ?? 0) * cost.output
  return total / 1_000_000
}

/** The answers of `messages` that carry usage, with their cost from `priceOf` (null: prices unknown). */
export function usageRecords(
  messages: Iterable<Message>,
  priceOf: (model: ModelRef) => ModelCost | null,
): UsageRecord[] {
  const out: UsageRecord[] = []
  for (const m of messages) {
    if (m.role !== 'assistant' || m.model === null || m.usage === undefined) continue
    const u = m.usage
    if (u.input === undefined && u.output === undefined) continue
    out.push({
      at: m.createdAt,
      conversation: m.conv,
      model: m.model,
      input: u.input ?? 0,
      output: u.output ?? 0,
      cacheRead: u.cacheRead ?? 0,
      reasoning: u.reasoning ?? 0,
      cost: usageCost(u, priceOf(m.model)),
    })
  }
  return out.sort((a, b) => a.at - b.at)
}

/** Every committed message of every conversation that was not purged (archived and trashed ones included). */
export async function allMessages(ws: Workspace): Promise<Message[]> {
  const ids = new Set<Id>()
  for (const filter of [{}, { archived: true }, { trashed: true }])
    for (const c of ws.conversations.list(filter)) ids.add(c.id)
  const out: Message[] = []
  for (const id of ids) {
    try {
      out.push(...(await ws.thread(id)).all())
    } catch {
      // A conversation purged meanwhile has nothing left to count.
    }
  }
  return out
}

function add(t: Totals, r: UsageRecord): Totals {
  return {
    answers: t.answers + 1,
    input: t.input + r.input,
    output: t.output + r.output,
    cacheRead: t.cacheRead + r.cacheRead,
    reasoning: t.reasoning + r.reasoning,
    cost: t.cost + (r.cost ?? 0),
    unpriced: t.unpriced + (r.cost === null ? 1 : 0),
  }
}

/** Local midnight of the day, Monday of the week, or first of the month that holds `t`. */
export function periodStart(t: number, bucket: Bucket): number {
  const d = new Date(t)
  if (bucket === 'month') return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  if (bucket === 'week') day.setDate(day.getDate() - ((day.getDay() + 6) % 7))
  return day.getTime()
}

/** The start of the period after the one that starts at `start` (calendar arithmetic: DST days are not 24 h). */
export function nextPeriod(start: number, bucket: Bucket): number {
  const d = new Date(start)
  if (bucket === 'month') return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (bucket === 'week' ? 7 : 1)).getTime()
}

export const groupKey = (model: ModelRef, by: GroupBy): string =>
  by === 'provider' ? model.provider : `${model.provider}/${model.id}`

/**
 * The records in `[from, to)` summed per period and per group. Periods are calendar days, Monday weeks or months in
 * local time; with no record there is no period.
 */
export function summarize(
  records: readonly UsageRecord[],
  options: { readonly bucket: Bucket; readonly by: GroupBy; readonly from?: number; readonly to?: number },
): Summary {
  const { bucket, by } = options
  const inRange = records.filter(
    (r) => (options.from === undefined || r.at >= options.from) && (options.to === undefined || r.at < options.to),
  )
  let totals = EMPTY_TOTALS
  const groups = new Map<string, { model: ModelRef; totals: Totals }>()
  const periods = new Map<number, { totals: Totals; groups: Map<string, Totals> }>()
  for (const r of inRange) {
    totals = add(totals, r)
    const key = groupKey(r.model, by)
    const g = groups.get(key)
    groups.set(key, { model: g?.model ?? r.model, totals: add(g?.totals ?? EMPTY_TOTALS, r) })
    const start = periodStart(r.at, bucket)
    const p = periods.get(start) ?? { totals: EMPTY_TOTALS, groups: new Map<string, Totals>() }
    p.totals = add(p.totals, r)
    p.groups.set(key, add(p.groups.get(key) ?? EMPTY_TOTALS, r))
    periods.set(start, p)
  }
  const out: Period[] = []
  const first = inRange[0]
  const last = inRange.at(-1)
  if (first !== undefined && last !== undefined) {
    const end = periodStart(last.at, bucket)
    for (let at = periodStart(first.at, bucket); at <= end; at = nextPeriod(at, bucket)) {
      const p = periods.get(at)
      out.push({ start: at, totals: p?.totals ?? EMPTY_TOTALS, groups: p?.groups ?? new Map() })
    }
  }
  const tokens = (t: Totals) => t.input + t.output
  return {
    totals,
    periods: out,
    groups: [...groups.entries()]
      .map(([key, g]) => ({ key, model: g.model, totals: g.totals }))
      .sort((a, b) => tokens(b.totals) - tokens(a.totals) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
  }
}
