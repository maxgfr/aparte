/*
 * What a branch tells about its research (contracts/research.ts): the `<source>` blocks `research_read` writes and
 * reads back, the URLs a chat surfaced (which `research_read` may read) and the source ids it gave, one research turn
 * with its report, and the progress of a turn while it runs.
 *
 * Invariants:
 * - `sourceBlock` and `sourceBlocks` are exact inverses: attributes are escaped (`&`, `<`, `>`, `"`) and any
 *   `</source` inside a page's text is neutralized reversibly, so a page cannot close its block early or forge another.
 * - Everything here reads committed parts that are already resolved (no `ref` part: the caller substitutes them), and
 *   is a pure function of them.
 * - The URLs a chat surfaced are those of search results (`research_search`, any other tool whose name says `search`,
 *   such as an MCP search tool), of the provider's web search (`source` parts) and of what the user wrote; never the
 *   links inside a page that was read.
 */
import type {
  ResearchHistory,
  ResearchProgress,
  ResearchSource,
  ResearchStep,
  ResearchTurn,
  SnippetSource,
  SourceStatus,
} from '../contracts/research.ts'
import { RESEARCH_READ, RESEARCH_SEARCH } from '../contracts/research.ts'
import type { Id, Message, Part } from '../contracts/workspace.ts'
import { normalizeUrl } from './fuse.ts'

const escapeAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const unescapeAttr = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')

/** `</source` in a text becomes `&lt;/source`; a text that already held `&lt;/source` gets one more `amp;`. */
const escapeText = (s: string): string =>
  s
    .replace(/&((?:amp;)*)lt;\/(source)/gi, (_m, amps: string, word: string) => `&amp;${amps}lt;/${word}`)
    .replace(/<\/(source)/gi, (_m, word: string) => `&lt;/${word}`)
const unescapeText = (s: string): string =>
  s.replace(/&((?:amp;)*)lt;\/(source)/gi, (_m, amps: string, word: string) =>
    amps === '' ? `</${word}` : `&${amps.slice(4)}lt;/${word}`,
  )

/** One source as `research_read` gives it to the model. */
export function sourceBlock(source: ResearchSource): string {
  const note = source.note === undefined ? '' : ` note="${escapeAttr(source.note)}"`
  return `<source id="${source.id}" url="${escapeAttr(source.url)}" title="${escapeAttr(source.title)}" status="${source.status}"${note}>\n${escapeText(source.text)}\n</source>`
}

const BLOCK =
  /<source id="(S\d+)" url="([^"]*)" title="([^"]*)" status="(ok|wall|failed)"(?: note="([^"]*)")?>\n([\s\S]*?)\n<\/source>/g

/** The sources of a `research_read` output, in order. */
export function sourceBlocks(output: string): ResearchSource[] {
  const out: ResearchSource[] = []
  for (const m of output.matchAll(BLOCK)) {
    const note = m[5]
    out.push({
      id: m[1] as string,
      url: unescapeAttr(m[2] ?? ''),
      title: unescapeAttr(m[3] ?? ''),
      status: m[4] as SourceStatus,
      text: unescapeText(m[6] ?? ''),
      ...(note === undefined ? {} : { note: unescapeAttr(note) }),
    })
  }
  return out
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]}]+/gi

/** URLs written in a text, without trailing punctuation. */
export function urlsIn(text: string): string[] {
  return [...text.matchAll(URL_IN_TEXT)].map((m) => m[0].replace(/[.,;:!?]+$/, ''))
}

/** Every http(s) URL in a JSON value or text. */
function urlsOf(value: unknown, out: string[], depth = 0): void {
  if (depth > 12) return
  if (typeof value === 'string') {
    out.push(...urlsIn(value))
    return
  }
  if (Array.isArray(value)) {
    for (const v of value) urlsOf(v, out, depth + 1)
    return
  }
  if (value !== null && typeof value === 'object') for (const v of Object.values(value)) urlsOf(v, out, depth + 1)
}

const injected = (p: Part): unknown => (p as { injected?: unknown }).injected

/** The user's own text of a message: injected parts left out. */
function ownText(parts: readonly Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text' && injected(p) === undefined)
    .map((p) => p.text)
    .join('\n\n')
}

type ResultPart = Extract<Part, { readonly type: 'tool-result' }>
type CallPart = Extract<Part, { readonly type: 'tool-call' }>

const isResearchPart = (p: Part): boolean => p.type === 'text' && injected(p) === 'research'

/** The search results of a `research_search` output (`{results: [{url, title, snippet}]}`). */
function searchResults(output: unknown): SnippetSource[] {
  const results = (output as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) return []
  return results.flatMap((r) => {
    const o = r as { url?: unknown; title?: unknown; snippet?: unknown } | null
    if (typeof o?.url !== 'string') return []
    return [
      {
        url: o.url,
        title: typeof o.title === 'string' ? o.title : '',
        snippet: typeof o.snippet === 'string' ? o.snippet : '',
      },
    ]
  })
}

/** What a branch (already resolved) lets the research tools read, and the ids it already gave. */
export function researchHistory(path: readonly Message[]): ResearchHistory {
  const urls = new Set<string>()
  const ids = new Map<string, string>()
  const allow = (raw: string) => {
    const key = normalizeUrl(raw)
    if (key !== null) urls.add(key)
  }
  for (const m of path) {
    if (m.deletedAt !== undefined) continue
    if (m.role === 'user') for (const u of urlsIn(ownText(m.parts))) allow(u)
    for (const p of m.parts) {
      if (p.type === 'source' && typeof p.url === 'string') allow(p.url)
      if (p.type !== 'tool-result') continue
      if (p.name === RESEARCH_READ) {
        if (typeof p.output !== 'string') continue
        for (const s of sourceBlocks(p.output)) {
          const key = normalizeUrl(s.url)
          if (key === null) continue
          urls.add(key)
          if (!ids.has(key)) ids.set(key, s.id)
        }
      } else if (p.name === RESEARCH_SEARCH || /search/i.test(p.name)) {
        const found: string[] = []
        urlsOf(p.output, found)
        for (const u of found) allow(u)
      }
    }
  }
  return { urls, ids }
}

/** The index of the user message that starts the research turn `answerId` belongs to, or -1. */
function turnStart(path: readonly Message[], answerId: Id): number {
  const at = path.findIndex((m) => m.id === answerId)
  if (at < 0 || path[at]?.role !== 'assistant') return -1
  for (let i = at - 1; i >= 0; i--) {
    const m = path[i] as Message
    if (m.role !== 'user' || m.deletedAt !== undefined) continue
    return m.parts.some(isResearchPart) ? i : -1
  }
  return -1
}

/** The research turn the answer `answerId` belongs to, or null when it answers no Deep research message. */
export function researchTurn(path: readonly Message[], answerId: Id): ResearchTurn | null {
  const start = turnStart(path, answerId)
  if (start < 0) return null
  const end = path.findIndex((m) => m.id === answerId)
  const sources = new Map<string, ResearchSource>()
  const snippets = new Map<string, SnippetSource>()
  const queries: string[] = []
  const snippet = (s: SnippetSource) => {
    const key = normalizeUrl(s.url)
    if (key !== null && !snippets.has(key)) snippets.set(key, s)
  }
  for (const m of path.slice(start + 1, end + 1)) {
    if (m.deletedAt !== undefined) continue
    for (const p of m.parts) {
      if (p.type === 'source' && typeof p.url === 'string')
        snippet({ url: p.url, title: p.title ?? '', snippet: p.citedText ?? '' })
      if (p.type === 'tool-call' && p.name === RESEARCH_SEARCH) {
        const qs = (p.input as { queries?: unknown } | null)?.queries
        if (Array.isArray(qs)) for (const q of qs) if (typeof q === 'string' && q.trim() !== '') queries.push(q.trim())
      }
      if (p.type !== 'tool-result') continue
      if (p.name === RESEARCH_READ && typeof p.output === 'string') {
        // A source read again keeps its id; its latest read is what the report was written from.
        for (const s of sourceBlocks(p.output)) sources.set(s.id, s)
      } else if (p.name === RESEARCH_SEARCH) {
        for (const s of searchResults(p.output)) snippet(s)
      }
    }
  }
  const answer = path[end] as Message
  const hasCalls = answer.parts.some((p) => p.type === 'tool-call')
  const report = hasCalls ? '' : ownText(answer.parts).trim()
  // Ids are given once per conversation: a source an earlier turn of the branch read stays citable, and joins this
  // turn's sources when the report cites it (an uncited earlier source is not this turn's to list).
  const cited = citedIds(report)
  for (const m of path.slice(0, start)) {
    if (m.deletedAt !== undefined) continue
    for (const p of m.parts) {
      if (p.type !== 'tool-result' || p.name !== RESEARCH_READ || typeof p.output !== 'string') continue
      for (const s of sourceBlocks(p.output)) if (cited.has(s.id) && !sources.has(s.id)) sources.set(s.id, s)
    }
  }
  return {
    question: ownText((path[start] as Message).parts).trim(),
    sources: [...sources.values()].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))),
    snippets: [...snippets.values()],
    queries,
    report,
  }
}

/** The source ids a text cites (`[S1]`, `[S1][S2]`, `[S1, S2]`), without parsing its Markdown. */
function citedIds(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(/\[\s*(S\d+(?:\s*,\s*S\d+)*)\s*\]/g))
    for (const id of (m[1] ?? '').split(',')) out.add(id.trim())
  return out
}

/** A live tool call, as the stream shows it (contracts/chat.ts `ToolCallState`). */
export interface LiveCall {
  readonly name: string
  readonly status: string
}

export interface LiveTurn {
  readonly calls: readonly LiveCall[]
  /** The answer streaming now has text. */
  readonly streamingText: boolean
}

const ACTIVE = new Set(['approval', 'running'])

/**
 * Where a research turn stands. `path` holds the committed messages after the turn's user message (resolved); `live`
 * is the stream in this conversation, null when none runs.
 */
export function researchProgress(path: readonly Message[], live: LiveTurn | null): ResearchProgress {
  let queries = 0
  let rounds = 0
  const results = new Set<string>()
  const read = new Set<string>()
  const failed = new Set<string>()
  let report = false
  for (const m of path) {
    if (m.deletedAt !== undefined) continue
    const calls = m.parts.filter((p): p is CallPart => p.type === 'tool-call')
    if (calls.some((c) => c.name === RESEARCH_SEARCH)) rounds += 1
    for (const c of calls) {
      if (c.name !== RESEARCH_SEARCH) continue
      const qs = (c.input as { queries?: unknown } | null)?.queries
      if (Array.isArray(qs)) queries += qs.filter((q) => typeof q === 'string' && q.trim() !== '').length
    }
    if (m.role === 'assistant' && calls.length === 0 && ownText(m.parts).trim() !== '') report = true
    for (const p of m.parts) {
      if (p.type !== 'tool-result') continue
      const r = p as ResultPart
      if (r.name === RESEARCH_SEARCH) {
        for (const s of searchResults(r.output)) {
          const key = normalizeUrl(s.url)
          if (key !== null) results.add(key)
        }
      } else if (r.name === RESEARCH_READ && typeof r.output === 'string') {
        for (const s of sourceBlocks(r.output)) {
          if (s.status === 'ok') {
            read.add(s.id)
            failed.delete(s.id)
          } else if (!read.has(s.id)) failed.add(s.id)
        }
      }
    }
  }
  let step: ResearchStep
  if (live === null) step = report ? 'done' : read.size > 0 ? 'write' : results.size > 0 ? 'read' : 'plan'
  else if (live.calls.some((c) => c.name === RESEARCH_READ && ACTIVE.has(c.status))) step = 'read'
  else if (live.calls.some((c) => c.name === RESEARCH_SEARCH && ACTIVE.has(c.status))) step = 'search'
  else if (live.calls.length > 0) step = read.size > 0 ? 'read' : 'search'
  // Between rounds the model thinks or writes: once something was read, what it streams is the report.
  else step = read.size > 0 && (live.streamingText || rounds > 0) ? 'write' : 'plan'
  return { step, queries, results: results.size, read: read.size, failed: failed.size, rounds }
}
