import { intlTag, type Locale } from './index.ts'

export function formatDate(locale: Locale, date: Date | number, style: 'short' | 'medium' | 'long' = 'medium'): string {
  return new Intl.DateTimeFormat(intlTag(locale), { dateStyle: style }).format(date)
}

export function formatDateTime(locale: Locale, date: Date | number): string {
  return new Intl.DateTimeFormat(intlTag(locale), { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

export function formatNumber(locale: Locale, value: number, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat(intlTag(locale), { maximumFractionDigits }).format(value)
}

export function formatPercent(locale: Locale, ratio: number): string {
  return new Intl.NumberFormat(intlTag(locale), { style: 'percent', maximumFractionDigits: 1 }).format(ratio)
}

/** Decimal bytes, as the OS shows storage: "968 MB", "2.4 GB". Show it inside a catalog string. */
export function formatBytes(locale: Locale, n: number): string {
  const mb = n / 1_000_000
  const unit = mb >= 1000 ? 'gigabyte' : 'megabyte'
  const value = unit === 'gigabyte' ? mb / 1000 : mb
  return new Intl.NumberFormat(intlTag(locale), {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: value < 10 ? 1 : 0,
  }).format(value)
}

/** USD with extra precision for sub-cent AI costs. */
export function formatUsd(locale: Locale, amount: number): string {
  const small = amount !== 0 && Math.abs(amount) < 0.01
  return new Intl.NumberFormat(intlTag(locale), {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: small ? 4 : 2,
  }).format(amount)
}

const UNITS: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
]

/** Relative time from `now` to `date`, e.g. "in 3 days", "vor 2 Stunden". */
export function formatRelative(locale: Locale, date: Date | number, now: Date | number = Date.now()): string {
  const seconds = (Number(date) - Number(now)) / 1000
  const rtf = new Intl.RelativeTimeFormat(intlTag(locale), { numeric: 'auto' })
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size || unit === 'second') return rtf.format(Math.round(seconds / size), unit)
  }
  return rtf.format(0, 'second')
}

/** Compact duration such as "1 h 5 min" / "3 d". */
export function formatDuration(locale: Locale, ms: number): string {
  const tag = intlTag(locale)
  const unit = (value: number, u: 'day' | 'hour' | 'minute' | 'second') =>
    new Intl.NumberFormat(tag, { style: 'unit', unit: u, unitDisplay: 'short' }).format(value)
  const total = Math.max(0, Math.round(ms / 1000))
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (d > 0) return h > 0 ? `${unit(d, 'day')} ${unit(h, 'hour')}` : unit(d, 'day')
  if (h > 0) return m > 0 ? `${unit(h, 'hour')} ${unit(m, 'minute')}` : unit(h, 'hour')
  if (m > 0) return unit(m, 'minute')
  return unit(s, 'second')
}
