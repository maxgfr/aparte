import { useEffect, useId, useRef, useState } from 'react'
import styles from './Stats.module.css'

/*
 * A stacked bar chart drawn by hand in SVG: one bar per period, one segment per series, a recessive grid and one
 * axis. Series colors come from the design tokens in a fixed order (validated for colour-vision deficiencies as
 * adjacent pairs; the fifth series is the neutral "Other"). The chart is an image with a summary for assistive
 * technology; the same figures are in the tables beside it, and hovering a bar shows its values.
 */

/** Fixed series order: blue, amber, purple, green, then the neutral for everything folded into "Other". */
export const SERIES_COLORS = [
  'var(--course-blue)',
  'var(--course-amber)',
  'var(--course-purple)',
  'var(--course-green)',
  'var(--course-graphite)',
] as const

export interface Series {
  readonly key: string
  readonly label: string
  readonly color: string
}

export interface ChartPeriod {
  readonly key: string
  /** The axis label (short). */
  readonly label: string
  /** The tooltip title (long). */
  readonly title: string
  /** One value per series, in series order. */
  readonly values: readonly number[]
}

const HEIGHT = 220
const PAD = { top: 12, right: 8, bottom: 28, left: 56 }
const GAP = 2

/** A round step for the axis: 1, 2 or 5 times a power of ten. */
function niceMax(value: number): number {
  if (value <= 0) return 1
  const power = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 5, 10]) if (step * power >= value) return step * power
  return 10 * power
}

/** The SVG path of a bar segment whose top corners are rounded by `r` (the data end), bottom square. */
function topRounded(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h))
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`
}

export function UsageChart({
  title,
  summary,
  series,
  periods,
  format,
}: {
  title: string
  summary: string
  series: readonly Series[]
  periods: readonly ChartPeriod[]
  format: (value: number) => string
}) {
  const host = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const [hover, setHover] = useState<number | null>(null)
  const titleId = useId()
  const descId = useId()
  useEffect(() => {
    const el = host.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(Math.max(240, Math.round(entry.contentRect.width)))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  // Hovering (or tapping) a column shows its values; the tables carry the same figures for keyboards and readers.
  const columns = useRef({ left: PAD.left, slot: 1, count: 0 })
  useEffect(() => {
    const el = host.current
    if (el === null) return
    const move = (e: PointerEvent) => {
      const { left, slot, count } = columns.current
      const x = e.clientX - el.getBoundingClientRect().left - left
      const i = Math.floor(x / slot)
      setHover(i >= 0 && i < count ? i : null)
    }
    const leave = () => setHover(null)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerdown', move)
    el.addEventListener('pointerleave', leave)
    return () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerdown', move)
      el.removeEventListener('pointerleave', leave)
    }
  }, [])

  const totals = periods.map((p) => p.values.reduce((a, b) => a + b, 0))
  const max = niceMax(Math.max(0, ...totals))
  const plotW = width - PAD.left - PAD.right
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const slot = plotW / Math.max(1, periods.length)
  const barW = Math.max(2, Math.min(40, slot * 0.7))
  columns.current = { left: PAD.left, slot, count: periods.length }
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH
  const ticks = [0, max / 2, max]
  // At most about eight axis labels, evenly spaced, the last period always labelled.
  const every = Math.max(1, Math.ceil(periods.length / Math.max(2, Math.floor(plotW / 72))))
  const hovered = hover === null ? undefined : periods[hover]

  return (
    <figure className={styles.figure}>
      <figcaption id={titleId} className={styles.chartTitle}>
        {title}
      </figcaption>
      {series.length > 1 && (
        <ul className={styles.legend}>
          {series.map((s) => (
            <li key={s.key} className={styles.legendItem}>
              <span className={styles.swatch} style={{ background: s.color }} aria-hidden="true" />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <div ref={host} className={styles.plot}>
        <svg
          width={width}
          height={HEIGHT}
          viewBox={`0 0 ${width} ${HEIGHT}`}
          role="img"
          aria-describedby={descId}
          className={styles.svg}
        >
          <title>{title}</title>
          <desc id={descId}>{summary}</desc>
          {ticks.map((v) => (
            <g key={v}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(v)}
                y2={y(v)}
                className={v === 0 ? styles.baseline : styles.grid}
              />
              <text x={PAD.left - 8} y={y(v)} className={styles.tick} textAnchor="end" dominantBaseline="middle">
                {format(v)}
              </text>
            </g>
          ))}
          {periods.map((p, i) => {
            const x = PAD.left + i * slot + (slot - barW) / 2
            let base = 0
            const top = p.values.reduce((last, v, s) => (v > 0 ? s : last), -1)
            return (
              <g key={p.key} opacity={hover === null || hover === i ? 1 : 0.55}>
                {p.values.map((v, s) => {
                  if (v <= 0) return null
                  const y0 = y(base)
                  base += v
                  const y1 = y(base)
                  // A 2px surface gap between stacked segments; the topmost carries the rounded data end.
                  const h = Math.max(0, y0 - y1 - (s === top ? 0 : GAP))
                  const color = series[s]?.color ?? SERIES_COLORS[4]
                  return s === top ? (
                    <path key={series[s]?.key ?? s} d={topRounded(x, y1, barW, h, 4)} style={{ fill: color }} />
                  ) : (
                    <rect
                      key={series[s]?.key ?? s}
                      x={x}
                      y={y1 + GAP}
                      width={barW}
                      height={h}
                      style={{ fill: color }}
                    />
                  )
                })}
                {(i % every === 0 || i === periods.length - 1) && (
                  <text x={x + barW / 2} y={HEIGHT - 8} className={styles.tick} textAnchor="middle">
                    {p.label}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
        {hovered !== undefined && hover !== null && (
          <div
            className={styles.tooltip}
            style={{ left: Math.min(width - 180, Math.max(0, PAD.left + hover * slot + slot / 2 - 90)) }}
            aria-hidden="true"
          >
            <p className={styles.tooltipTitle}>{hovered.title}</p>
            {series.map((s, i) =>
              (hovered.values[i] ?? 0) > 0 ? (
                <p key={s.key} className={styles.tooltipRow}>
                  <span className={styles.swatch} style={{ background: s.color }} />
                  <span className={styles.tooltipLabel}>{s.label}</span>
                  <span className={styles.tooltipValue}>{format(hovered.values[i] ?? 0)}</span>
                </p>
              ) : null,
            )}
          </div>
        )}
      </div>
    </figure>
  )
}
