/*
 * The citation gate of Deep research (contracts/research.ts), after ultrasearch's `check` and the deep tier's
 * numeral rule (references/citation-format.md): every citation of a report must name a source the turn read, every
 * address it writes must be one of those sources, every quotation must be in the text of a source it cites, and a
 * figure a claim asserts should be in a source it cites.
 *
 * Invariants:
 * - Deterministic and pure: the same report and sources always give the same verification, so it is recomputed from
 *   the committed branch instead of being stored.
 * - The report is read as Markdown the way the gate counts claims: claim units are paragraphs, list items and table
 *   data rows; headings, a table's header row, code (fenced or inline), HTML comments and a trailing "Sources" or
 *   "References" section are structure, never claims. Citations and links are checked everywhere but in code.
 * - `[M]` and a `> [model-hint]` quote flag the model's own knowledge: counted, exempt from the claim checks, never a
 *   failure. A unit of fewer than six words is not required to cite.
 * - Quotations and figures are compared after normalizing case, Unicode forms, whitespace, quotes, dashes, ellipses
 *   and digit grouping, so typography never fails a faithful report.
 */
import type { CitationStatus, LinkStatus, ResearchSource, SnippetSource, Verification } from '../contracts/research.ts'
import { normalizeUrl } from './fuse.ts'
import { urlsIn } from './history.ts'

const CITE = /\[\s*(S\d+(?:\s*[,;]\s*S\d+)*)\s*\]/g
const HINT = /\[M\]/g

/** The source ids a text cites, in order, repeats kept (`[S1]`, `[S1][S4]`, `[S1, S4]`). */
export function citationsOf(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(CITE)) for (const id of (m[1] ?? '').split(/\s*[,;]\s*/)) out.push(id.trim())
  return out
}

/** The text without HTML comments and code (fenced blocks become blank lines, inline spans a space). */
function withoutCode(text: string): string {
  const lines = text.replace(/<!--[\s\S]*?-->/g, ' ').split(/\r?\n/)
  const out: string[] = []
  let fence: string | null = null
  for (const line of lines) {
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line)
    if (fence === null && open?.[1] !== undefined) {
      fence = open[1]
      out.push('')
      continue
    }
    if (fence !== null) {
      if (new RegExp(`^\\s{0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line)) fence = null
      out.push('')
      continue
    }
    out.push(line.replace(/(`+)(?:(?!\1)[\s\S])+?\1/g, ' '))
  }
  return out.join('\n')
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const APPENDIX = /^(sources|references|bibliography|works cited|sources and references)\s*:?$/i
const SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/
const ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(.*)$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/

/** Removes a trailing "Sources" (or "References") section: the appendix lists sources, it makes no claim. */
function withoutAppendix(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let skipping = 0
  for (const line of lines) {
    const h = HEADING.exec(line)
    if (h?.[1] !== undefined) {
      const level = h[1].length
      if (skipping > 0 && level <= skipping) skipping = 0
      if (skipping === 0 && APPENDIX.test((h[2] ?? '').replace(/[*_]/g, '').trim())) {
        skipping = level
        continue
      }
    }
    if (skipping === 0) out.push(line)
  }
  return out.join('\n')
}

interface Unit {
  readonly text: string
  /** A `> [model-hint]` quote. */
  readonly hint: boolean
}

/** The claim units of a report body (code and the appendix already removed). */
function unitsOf(body: string): Unit[] {
  const lines = body.split('\n')
  const units: Unit[] = []
  let current: string[] = []
  let quote = false
  let inTable = false
  const flush = () => {
    const text = current.join(' ').trim()
    if (text !== '') units.push({ text, hint: quote && /^\[model-hint\]/i.test(text) })
    current = []
    quote = false
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string
    const line = raw.trimEnd()
    if (line.trim() === '') {
      flush()
      inTable = false
      continue
    }
    if (HEADING.test(line)) {
      flush()
      inTable = false
      continue
    }
    // A setext heading underline turns the paragraph above it into a heading.
    if (/^\s{0,3}(=+|-+)\s*$/.test(line) && current.length > 0 && !inTable && !quote) {
      current = []
      continue
    }
    if (RULE.test(line)) {
      flush()
      continue
    }
    const next = lines[i + 1] ?? ''
    const isRow = line.includes('|') && (inTable || line.trim().startsWith('|') || SEPARATOR.test(next))
    if (isRow) {
      flush()
      if (SEPARATOR.test(line)) {
        // The row above the separator is the header: structure, not a claim.
        if (units.length > 0 && inTable) units.pop()
        inTable = true
        continue
      }
      inTable = true
      const cells = line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim())
      units.push({ text: cells.join(' '), hint: false })
      continue
    }
    inTable = false
    const q = /^\s{0,3}>\s?(.*)$/.exec(line)
    if (q !== null) {
      if (!quote) flush()
      quote = true
      current.push(q[1] ?? '')
      continue
    }
    if (quote) flush()
    const item = ITEM.exec(line)
    if (item !== null) {
      flush()
      current.push(item[1] ?? '')
      continue
    }
    current.push(line.trim())
  }
  flush()
  return units
}

/** Text compared for quotations: Unicode-normalized, lowercase, typographic marks unified, whitespace collapsed. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[​-‍⁠﻿­]/g, '')
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″«»]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
}

const QUOTE = /"([^"\n]+?)"|“([^”\n]+?)”|«\s*([^»\n]+?)\s*»|„([^“”\n]+?)[“”]/g

const wordCount = (s: string): number => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length

/** The quotations of a unit worth checking: four words or more. */
function quotesIn(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(QUOTE)) {
    const q = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? '').trim()
    if (wordCount(q) >= 4) out.push(q)
  }
  return out
}

/** Whether a quotation is in a source text: each piece between ellipses, in order. */
function quoted(quote: string, source: string): boolean {
  const hay = normalizeText(source)
  const pieces = normalizeText(quote.replace(/\*\*?|__/g, ''))
    .split(/\s*(?:\[\.\.\.\]|\.\.\.)\s*/)
    .map((p) => p.replace(/^[\s.,;:!?'"()-]+|[\s.,;:!?'"()-]+$/g, ''))
    .filter((p) => p !== '')
  if (pieces.length === 0) return true
  let at = 0
  for (const piece of pieces) {
    const found = hay.indexOf(piece, at)
    if (found < 0) return false
    at = found + piece.length
  }
  return true
}

const NUMERAL = /(?<![\p{L}\p{N}_.,])(\d{1,3}(?:[,   ]\d{3})+(?:\.\d+)?|\d+(?:[.,]\d+)?)(\s?%)?/gu
const SPACED = /(?<![\p{L}\p{N}_.,])(\d{1,3}(?: \d{3})+)(?![\p{N}])/gu

function canonical(raw: string): string | null {
  const grouped = /^\d{1,3}([,    ])\d{3}(\1\d{3})*(\.\d+)?$/.test(raw)
  const plain = grouped ? raw.replace(/[,    ]/g, '') : raw.replace(',', '.')
  const n = Number(plain)
  return Number.isFinite(n) ? String(n) : null
}

/** The figures a claim asserts: integers of two digits or more, decimals and percentages. */
function claimNumerals(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(NUMERAL)) {
    const raw = m[1] ?? ''
    const significant = m[2] !== undefined || /[.,]/.test(raw) || raw.replace(/\D/g, '').length >= 2
    const value = significant ? canonical(raw) : null
    if (value !== null && !out.includes(value)) out.push(value)
  }
  return out
}

/** Every number a source text holds, digit grouping by spaces included. */
function sourceNumerals(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(NUMERAL)) {
    const v = canonical(m[1] ?? '')
    if (v !== null) out.add(v)
    // "1,5" may be a decimal comma or a list; both readings count as present.
    const alt = /^\d+,\d+$/.test(m[1] ?? '') ? (m[1] ?? '').split(',') : []
    for (const a of alt) out.add(String(Number(a)))
  }
  for (const m of text.matchAll(SPACED)) {
    const v = canonical(m[1] ?? '')
    if (v !== null) out.add(v)
  }
  return out
}

/** A unit's text without its citations, flags and addresses: what its words and figures are read from. */
function claimText(text: string): string {
  return text
    .replace(CITE, ' ')
    .replace(HINT, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<https?:\/\/[^>]*>/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
}

/** Every address a report writes: Markdown links, `<…>` autolinks and bare URLs, once each, in order. */
function linksOf(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (raw: string) => {
    const url = raw.replace(/^<|>$/g, '')
    const key = normalizeUrl(url)
    if (key === null || seen.has(key)) return
    seen.add(key)
    out.push(url)
  }
  let rest = text
  rest = rest.replace(/\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g, (_m, label: string, href: string) => {
    if (/^<?https?:\/\//i.test(href)) add(href)
    return ` ${label} `
  })
  rest = rest.replace(/<(https?:\/\/[^>\s]+)>/gi, (_m, href: string) => {
    add(href)
    return ' '
  })
  for (const u of urlsIn(rest)) add(u)
  return out
}

const clip = (s: string): string => (s.length > 300 ? `${s.slice(0, 299).trimEnd()}…` : s)

export function verifyReport(
  report: string,
  sources: readonly ResearchSource[],
  snippets: readonly SnippetSource[],
): Verification {
  const byId = new Map(sources.map((s) => [s.id, s]))
  const ok = new Map(sources.filter((s) => s.status === 'ok').map((s) => [s.id, s]))
  const readUrls = new Set(
    sources
      .filter((s) => s.status === 'ok')
      .map((s) => normalizeUrl(s.url))
      .filter((k): k is string => k !== null),
  )
  const seenUrls = new Set(
    [...snippets.map((s) => s.url), ...sources.filter((s) => s.status !== 'ok').map((s) => s.url)]
      .map(normalizeUrl)
      .filter((k): k is string => k !== null),
  )

  const text = withoutCode(report)
  const counts = new Map<string, number>()
  for (const id of citationsOf(text)) counts.set(id, (counts.get(id) ?? 0) + 1)
  const citations = [...counts].map(([id, count]) => {
    const source = byId.get(id)
    const status: CitationStatus =
      source === undefined
        ? 'unknown'
        : source.status === 'ok'
          ? 'fetched'
          : source.status === 'wall'
            ? 'wall'
            : 'unknown'
    return { id, status, count, ...(source === undefined ? {} : { url: source.url }) }
  })

  const links = linksOf(text).map((url) => {
    const key = normalizeUrl(url) as string
    const status: LinkStatus = readUrls.has(key) ? 'fetched' : seenUrls.has(key) ? 'snippet' : 'unknown'
    return { url, status }
  })

  const quotes: { text: string; ids: string[]; found: boolean | null }[] = []
  const numerals: { claim: string; ids: string[]; missing: string[] }[] = []
  const uncited: string[] = []
  let hints = [...text.matchAll(HINT)].length
  for (const unit of unitsOf(withoutAppendix(text))) {
    if (unit.hint) {
      hints += 1
      continue
    }
    const ids = [...new Set(citationsOf(unit.text))]
    const flagged = /\[M\]/.test(unit.text)
    const words = claimText(unit.text)
    if (ids.length === 0 && !flagged && wordCount(words) >= 6) uncited.push(clip(unit.text))
    if (flagged) continue
    const cited = ids.map((id) => ok.get(id)).filter((s): s is ResearchSource => s !== undefined)
    for (const q of quotesIn(unit.text)) {
      quotes.push({
        text: q,
        ids,
        found: cited.length === 0 ? null : cited.some((s) => quoted(q, s.text)),
      })
    }
    if (cited.length > 0) {
      const present = new Set(cited.flatMap((s) => [...sourceNumerals(s.text)]))
      const missing = claimNumerals(words).filter((n) => !present.has(n))
      if (missing.length > 0) numerals.push({ claim: clip(unit.text), ids, missing })
    }
  }

  const unused = [...ok.keys()].filter((id) => !counts.has(id))
  const passed =
    citations.length > 0 &&
    citations.every((c) => c.status === 'fetched') &&
    links.every((l) => l.status === 'fetched') &&
    quotes.every((q) => q.found !== false)
  return { citations, links, quotes, numerals, uncited, hints, unused, ok: passed }
}
