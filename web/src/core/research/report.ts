/*
 * A research report as a document to keep (contracts/research.ts): Markdown, or one self-contained HTML file, each
 * with the sources it cites and the verification of its citations.
 *
 * Invariants:
 * - The HTML file runs nothing and loads nothing: the export Content-Security-Policy of core/transfer/render.ts
 *   (`default-src 'none'`, inline styles only), no script, the report's raw HTML shown as text, links only to http,
 *   https and mailto addresses with `rel="noopener noreferrer"`, every other string escaped.
 * - A citation `[S#]` becomes a link to its entry in the source list, marked with its check (`cite-fetched`,
 *   `cite-wall`, `cite-unknown`); text inside code and inside tags is never rewritten.
 * - Words of the interface come from the caller (`labels`), already translated.
 */
import type { ReportLabels, ResearchSource, ResearchTurn, Verification } from '../contracts/research.ts'
import { EXPORT_CSP, EXPORT_STYLE, escapeHtml, markdownHtml } from '../transfer/render.ts'

const SAFE_LINK = /^https?:\/\//i

/** The read sources a report cites, in the order it first cites them. */
function citedSources(turn: ResearchTurn, verification: Verification): ResearchSource[] {
  const byId = new Map(turn.sources.map((s) => [s.id, s]))
  return verification.citations.flatMap((c) => {
    const s = byId.get(c.id)
    return s === undefined ? [] : [s]
  })
}

/** The findings of a verification, one line each, in the labels' words. */
function findings(v: Verification, labels: ReportLabels): string[] {
  const out: string[] = []
  const unknown = v.citations.filter((c) => c.status === 'unknown').map((c) => c.id)
  const walls = v.citations.filter((c) => c.status === 'wall').map((c) => c.id)
  if (unknown.length > 0) out.push(`${labels.unknownCitation}: ${unknown.join(', ')}`)
  if (walls.length > 0) out.push(`${labels.wall}: ${walls.join(', ')}`)
  for (const l of v.links) if (l.status !== 'fetched') out.push(`${labels.unreadLink}: ${l.url}`)
  for (const q of v.quotes) if (q.found === false) out.push(`${labels.quoteMissing}: “${q.text}”`)
  for (const n of v.numerals) out.push(`${labels.numeralMissing}: ${n.missing.join(', ')} (${n.claim})`)
  for (const u of v.uncited) out.push(`${labels.uncited}: ${u}`)
  if (v.hints > 0) out.push(`${labels.hints}: ${v.hints}`)
  return out
}

/** The report as Markdown: its text, the sources it cites, then its verification. */
export function reportMarkdown(
  turn: ResearchTurn,
  verification: Verification,
  labels: ReportLabels,
  title: string,
): string {
  const lines = [`# ${title}`, '', `_${labels.exported}_`, '', turn.report.trim(), '']
  const cited = citedSources(turn, verification)
  if (cited.length > 0) {
    lines.push(`## ${labels.sources}`, '')
    for (const s of cited) lines.push(`- [${s.id}] ${s.title.trim() || s.url} — <${s.url}>`)
    lines.push('')
  }
  lines.push(`## ${labels.verification}`, '', `**${verification.ok ? labels.passed : labels.failed}**`, '')
  lines.push(`- ${labels.cited}: ${verification.citations.reduce((n, c) => n + c.count, 0)}`)
  for (const f of findings(verification, labels)) lines.push(`- ${f}`)
  return `${lines.join('\n').trimEnd()}\n`
}

const CITE = /\[\s*(S\d+(?:\s*[,;]\s*S\d+)*)\s*\]/g

/** Turns the `[S#]` of rendered HTML text into links to the sources, outside tags, code and other links. */
function linkCitations(html: string, status: ReadonlyMap<string, string>): string {
  let inCode = 0
  let inLink = 0
  return html
    .split(/(<[^>]*>)/)
    .map((piece) => {
      if (piece.startsWith('<')) {
        if (/^<(code|pre)\b/i.test(piece)) inCode += 1
        else if (/^<\/(code|pre)\b/i.test(piece)) inCode = Math.max(0, inCode - 1)
        else if (/^<a\b/i.test(piece)) inLink += 1
        else if (/^<\/a\b/i.test(piece)) inLink = Math.max(0, inLink - 1)
        return piece
      }
      if (inCode > 0 || inLink > 0) return piece
      return piece.replace(CITE, (_m, list: string) =>
        list
          .split(/\s*[,;]\s*/)
          .map((id) => `<a href="#${id}" class="cite cite-${status.get(id) ?? 'unknown'}">[${id}]</a>`)
          .join(''),
      )
    })
    .join('')
}

const REPORT_STYLE = `
.cite{text-decoration:none;font-size:.8125em;font-weight:600}
.cite-wall,.cite-unknown{color:#a4332a;text-decoration:line-through}
.sources li{margin:0 0 .5rem}
.sid{font:600 .8125rem ui-monospace,'SF Mono',Menlo,Consolas,monospace;margin-right:.375rem}
.host{color:var(--ink-3);font-size:.8125rem;margin-left:.375rem}
.verdict{display:inline-block;border-radius:999px;padding:.125rem .625rem;font-weight:600;font-size:.875rem}
.pass{background:#d8efe6;color:#14523f}
.fail{background:#f6dcd8;color:#7a231c}
@media (prefers-color-scheme:dark){.pass{background:#173b31;color:#bfe9da}.fail{background:#45201c;color:#f3c6bf}}
`

/** The report as one HTML file that needs nothing else to be read. */
export function reportHtml(
  turn: ResearchTurn,
  verification: Verification,
  labels: ReportLabels,
  title: string,
): string {
  const status = new Map(verification.citations.map((c) => [c.id, c.status]))
  const body = linkCitations(markdownHtml(turn.report.trim()), status)
  const cited = citedSources(turn, verification)
  const items = cited.map((s) => {
    let host = ''
    try {
      host = new URL(s.url).host
    } catch {
      host = ''
    }
    const name = escapeHtml(s.title.trim() || s.url)
    const link = SAFE_LINK.test(s.url) ? `<a href="${escapeHtml(s.url)}" rel="noopener noreferrer">${name}</a>` : name
    return `<li id="${escapeHtml(s.id)}"><span class="sid">[${escapeHtml(s.id)}]</span>${link}${
      host === '' ? '' : `<span class="host">${escapeHtml(host)}</span>`
    }</li>`
  })
  const total = verification.citations.reduce((n, c) => n + c.count, 0)
  const found = findings(verification, labels).map((f) => `<li>${escapeHtml(f)}</li>`)
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(labels.lang)}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${EXPORT_STYLE}${REPORT_STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="meta">${escapeHtml(labels.exported)}</p>`,
    `<article>${body}</article>`,
    ...(items.length === 0
      ? []
      : [`<section><h2>${escapeHtml(labels.sources)}</h2><ol class="sources">${items.join('')}</ol></section>`]),
    '<section>',
    `<h2>${escapeHtml(labels.verification)}</h2>`,
    `<p><span class="verdict ${verification.ok ? 'pass' : 'fail'}">${escapeHtml(
      verification.ok ? labels.passed : labels.failed,
    )}</span> <span class="note">${escapeHtml(`${labels.cited}: ${total}`)}</span></p>`,
    ...(found.length === 0 ? [] : [`<ul class="note">${found.join('')}</ul>`]),
    '</section>',
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}
