import { useEffect, useId, useMemo, useState } from 'react'
import { Redirect } from 'wouter'
import { useSession, useSessionState } from '../../app/chat.tsx'
import { paths } from '../../app/routes.ts'
import { useVault } from '../../app/vault.tsx'
import type { Message } from '../../core/contracts/workspace.ts'
import {
  allMessages,
  type Bucket,
  type GroupBy,
  groupKey,
  periodStart,
  summarize,
  type Totals,
  usageRecords,
} from '../../core/stats/usage.ts'
import { formatDate, formatNumber, formatUsd } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { ScrollTable } from '../../ui/stats/ScrollTable.tsx'
import styles from '../../ui/stats/Stats.module.css'
import { type ChartPeriod, SERIES_COLORS, type Series, UsageChart } from '../../ui/stats/UsageChart.tsx'

/*
 * Usage: tokens and cost per provider or model over time, from the committed answers (core/stats/usage.ts). Every
 * figure is computed here, from the decrypted workspace, and never leaves the device.
 */

type Range = '7' | '30' | '90' | 'all'
type Metric = 'tokens' | 'cost'

const RANGE_DAYS: Readonly<Record<Exclude<Range, 'all'>, number>> = { '7': 7, '30': 30, '90': 90 }
const BUCKET: Readonly<Record<Range, Bucket>> = { '7': 'day', '30': 'day', '90': 'week', all: 'month' }
/** Series drawn apart; the rest is "Other" (the fifth, neutral color). */
const MAX_SERIES = 4

export default function StatsScreen() {
  const t = useT()
  const state = useSessionState()
  const { status } = useVault()
  if (status.state === 'absent') return <Redirect to={paths.welcome} replace />
  if (state.status !== 'open') {
    return (
      <Screen title={t('stats.title')}>
        <p role="status">{t('chat.sessionOpening')}</p>
      </Screen>
    )
  }
  return <Stats />
}

function Stats() {
  const t = useT()
  const locale = useLocale()
  const session = useSession()
  const [messages, setMessages] = useState<readonly Message[] | null | 'failed'>(null)
  const [range, setRange] = useState<Range>('30')
  const [metric, setMetric] = useState<Metric>('tokens')
  const [by, setBy] = useState<GroupBy>('provider')
  const tableId = useId()
  const periodsId = useId()

  useEffect(() => {
    if (session === null) return
    let live = true
    allMessages(session.workspace).then(
      (all) => live && setMessages(all),
      () => live && setMessages('failed'),
    )
    return () => {
      live = false
    }
  }, [session])

  const records = useMemo(
    () =>
      session === null || messages === null || messages === 'failed'
        ? []
        : usageRecords(messages, (ref) => session.resolveModel(ref)?.capabilities.cost ?? null),
    [session, messages],
  )
  const bucket = BUCKET[range]
  const summary = useMemo(() => {
    const from = range === 'all' ? undefined : periodStart(Date.now() - (RANGE_DAYS[range] - 1) * 86_400_000, 'day')
    return summarize(records, { bucket, by, ...(from === undefined ? {} : { from }) })
  }, [records, range, bucket, by])

  if (session === null) return null
  const value = (totals: Totals) => (metric === 'tokens' ? totals.input + totals.output : totals.cost)
  const format = (v: number) =>
    metric === 'tokens'
      ? new Intl.NumberFormat(locale === 'pseudo' ? 'en-US' : undefined, {
          notation: 'compact',
          maximumFractionDigits: 1,
        }).format(v)
      : formatUsd(locale, v)
  const nameOf = (model: { provider: string; id: string }) => {
    const provider = session.workspace.providers.get(model.provider)?.label ?? model.provider
    if (by === 'provider') return provider
    const name = session.resolveModel(model)?.name ?? model.id
    return `${name} (${provider})`
  }

  // Color follows the group: the largest groups of the whole period keep their place whatever the metric.
  const ranked = [...summary.groups].sort((a, b) => value(b.totals) - value(a.totals) || (a.key < b.key ? -1 : 1))
  const drawn = ranked.slice(0, ranked.length > MAX_SERIES + 1 ? MAX_SERIES : MAX_SERIES + 1)
  const folded = ranked.length > drawn.length
  const series: Series[] = drawn.map((g, i) => ({
    key: g.key,
    label: nameOf(g.model),
    color: SERIES_COLORS[Math.min(i, SERIES_COLORS.length - 1)] as string,
  }))
  if (folded) series.push({ key: '*other', label: t('stats.other'), color: SERIES_COLORS[4] })
  const periodLabel = (start: number) =>
    bucket === 'month'
      ? new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' }).format(start)
      : new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(start)
  const periods: ChartPeriod[] = summary.periods.map((p) => {
    const values = drawn.map((g) => {
      const totals = p.groups.get(g.key)
      return totals === undefined ? 0 : value(totals)
    })
    if (folded) {
      let rest = 0
      for (const [key, totals] of p.groups) if (!drawn.some((g) => g.key === key)) rest += value(totals)
      values.push(rest)
    }
    return { key: String(p.start), label: periodLabel(p.start), title: formatDate(locale, p.start), values }
  })
  const bucketWord = t(
    bucket === 'day' ? 'stats.bucketDay' : bucket === 'week' ? 'stats.bucketWeek' : 'stats.bucketMonth',
  )
  const groupWord = by === 'provider' ? t('stats.groupProvider') : t('stats.groupModel')
  const n = (v: number) => formatNumber(locale, v, 0)
  const first = summary.periods[0]
  const last = summary.periods.at(-1)

  return (
    <Screen title={t('stats.title')} subtitle={t('stats.lead')}>
      <div className={styles.stack}>
        <div className={styles.filters}>
          <Segmented
            label={t('stats.range')}
            value={range}
            onChange={setRange}
            options={[
              { value: '7', label: t('stats.range7') },
              { value: '30', label: t('stats.range30') },
              { value: '90', label: t('stats.range90') },
              { value: 'all', label: t('stats.rangeAll') },
            ]}
          />
          <Segmented
            label={t('stats.metric')}
            value={metric}
            onChange={setMetric}
            options={[
              { value: 'tokens', label: t('stats.metricTokens') },
              { value: 'cost', label: t('stats.metricCost') },
            ]}
          />
          <Segmented
            label={t('stats.groupBy')}
            value={by}
            onChange={setBy}
            options={[
              { value: 'provider', label: t('stats.groupProvider') },
              { value: 'model', label: t('stats.groupModel') },
            ]}
          />
        </div>

        {messages === null ? (
          <p role="status">{t('stats.loading')}</p>
        ) : messages === 'failed' ? (
          <p role="alert">{t('stats.failed')}</p>
        ) : summary.totals.answers === 0 ? (
          <EmptyState title={t('stats.emptyTitle')} body={t('stats.emptyBody')} />
        ) : (
          <>
            <dl className={styles.tiles}>
              <div className={styles.tile}>
                <dt className={styles.tileLabel}>{t('stats.tileTokens')}</dt>
                <dd className={styles.tileValue}>{n(summary.totals.input + summary.totals.output)}</dd>
                <dd className={styles.tileDetail}>
                  {t('stats.tileTokensDetail', { input: n(summary.totals.input), output: n(summary.totals.output) })}
                </dd>
              </div>
              <div className={styles.tile}>
                <dt className={styles.tileLabel}>{t('stats.tileCost')}</dt>
                <dd className={styles.tileValue}>{formatUsd(locale, summary.totals.cost)}</dd>
                {summary.totals.unpriced > 0 && (
                  <dd className={styles.tileDetail}>
                    {t('stats.tileCostUnpriced', { count: summary.totals.unpriced })}
                  </dd>
                )}
              </div>
              <div className={styles.tile}>
                <dt className={styles.tileLabel}>{t('stats.tileAnswers')}</dt>
                <dd className={styles.tileValue}>{n(summary.totals.answers)}</dd>
              </div>
            </dl>

            <UsageChart
              title={t(metric === 'tokens' ? 'stats.chartTokens' : 'stats.chartCost', {
                bucket: bucketWord,
                group: groupWord.toLowerCase(),
              })}
              summary={t('stats.chartSummary', {
                metric: metric === 'tokens' ? t('stats.metricTokens') : t('stats.metricCost'),
                from: first === undefined ? '' : formatDate(locale, first.start),
                to: last === undefined ? '' : formatDate(locale, last.start),
                total: metric === 'tokens' ? n(value(summary.totals)) : formatUsd(locale, summary.totals.cost),
              })}
              series={series}
              periods={periods}
              format={format}
            />

            <section className={styles.section} aria-labelledby={tableId}>
              <h2 id={tableId} className={styles.sectionTitle}>
                {t('stats.tableTitle', { group: groupWord.toLowerCase() })}
              </h2>
              <ScrollTable className={styles.tableWrap} labelledBy={tableId}>
                <table className={styles.table} aria-labelledby={tableId}>
                  <thead>
                    <tr>
                      <th scope="col">{t('stats.colName')}</th>
                      <th scope="col" className={styles.num}>
                        {t('stats.colAnswers')}
                      </th>
                      <th scope="col" className={styles.num}>
                        {t('stats.colInput')}
                      </th>
                      <th scope="col" className={styles.num}>
                        {t('stats.colOutput')}
                      </th>
                      <th scope="col" className={styles.num}>
                        {t('stats.colCost')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map((g) => {
                      const i = drawn.findIndex((d) => d.key === g.key)
                      const color = i < 0 ? SERIES_COLORS[4] : SERIES_COLORS[Math.min(i, 4)]
                      return (
                        <tr key={g.key} data-group={groupKey(g.model, by)}>
                          <th scope="row">
                            <span className={styles.nameCell}>
                              <span className={styles.swatch} style={{ background: color }} aria-hidden="true" />
                              {nameOf(g.model)}
                            </span>
                          </th>
                          <td className={styles.num}>{n(g.totals.answers)}</td>
                          <td className={styles.num}>{n(g.totals.input)}</td>
                          <td className={styles.num}>{n(g.totals.output)}</td>
                          <td className={styles.num}>
                            {g.totals.unpriced === g.totals.answers
                              ? t('stats.costUnknown')
                              : formatUsd(locale, g.totals.cost)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </ScrollTable>
            </section>

            <details className={styles.details}>
              <summary id={periodsId}>{t('stats.periodsTable')}</summary>
              <ScrollTable className={styles.tableWrap} labelledBy={periodsId}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">{t('stats.colPeriod')}</th>
                      {series.map((s) => (
                        <th key={s.key} scope="col" className={styles.num}>
                          {s.label}
                        </th>
                      ))}
                      <th scope="col" className={styles.num}>
                        {t('stats.colTotal')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {periods.map((p) => (
                      <tr key={p.key}>
                        <th scope="row">{p.title}</th>
                        {p.values.map((v, i) => (
                          <td key={series[i]?.key ?? i} className={styles.num}>
                            {format(v)}
                          </td>
                        ))}
                        <td className={styles.num}>{format(p.values.reduce((a, b) => a + b, 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollTable>
            </details>
            <p className={styles.note}>{t('stats.priceNote')}</p>
          </>
        )}
      </div>
    </Screen>
  )
}
