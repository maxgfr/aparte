/*
 * The keyless search backends of Deep research (contracts/research.ts): the APIs of the ultrasearch skill that a page
 * in a browser can read, each checked to answer a cross-origin GET with `Access-Control-Allow-Origin`, and one parser
 * per backend from its JSON (or, for Mojeek, its HTML) to search hits.
 *
 * Invariants:
 * - Every request is a plain GET with no header of its own (a CORS "simple request": no preflight), made through the
 *   FetchLike the caller passes, which is web/src/security/net.ts with purpose `research`. Every origin contacted is in
 *   `BACKENDS[].origins`, which is what spec/network-allowlist.json lists for that purpose.
 * - A backend that fails throws a BackendError (rate-limited, unreachable, an HTTP error, a malformed answer, a wall
 *   such as a captcha page); only an abort rejects with an AbortError. The research tool turns a failure into a note.
 * - Parsing never builds a document: HTML is read with regular expressions and reduced to text by `htmlText`.
 * - Hits link to the page a reader can open (an article, a question, a DOI), never to the API endpoint.
 */
import type { FetchLike } from '../contracts/ai.ts'
import type { ResearchBackendId, ResearchBackendInfo, SearchHit } from '../contracts/research.ts'
import { htmlText } from '../tools/builtins.ts'

/** The Wikipedia languages Deep research may search (each host is in the allowlist). */
export const WIKIPEDIA_LANGS = ['en', 'fr', 'de', 'es', 'it', 'pt', 'nl', 'pl', 'ja', 'zh'] as const
export type WikipediaLang = (typeof WIKIPEDIA_LANGS)[number]

/** A language code Wikipedia is searched in: the one asked when it is offered, else English. */
export function wikipediaLang(lang: string | undefined): WikipediaLang {
  const base = (lang ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? ''
  return (WIKIPEDIA_LANGS as readonly string[]).includes(base) ? (base as WikipediaLang) : 'en'
}

export const BACKENDS: readonly ResearchBackendInfo[] = Object.freeze([
  {
    id: 'wikipedia',
    origins: WIKIPEDIA_LANGS.map((l) => `https://${l}.wikipedia.org`),
    domain: 'encyclopedia',
    byDefault: true,
  },
  { id: 'marginalia', origins: ['https://api.marginalia-search.com'], domain: 'web', byDefault: true },
  { id: 'mojeek', origins: ['https://www.mojeek.com'], domain: 'web', byDefault: true },
  { id: 'hackernews', origins: ['https://hn.algolia.com'], domain: 'community', byDefault: true },
  { id: 'stackexchange', origins: ['https://api.stackexchange.com'], domain: 'community', byDefault: true },
  { id: 'github', origins: ['https://api.github.com'], domain: 'code', byDefault: false },
  { id: 'openalex', origins: ['https://api.openalex.org'], domain: 'scholarly', byDefault: true },
  { id: 'crossref', origins: ['https://api.crossref.org'], domain: 'scholarly', byDefault: false },
  { id: 'europepmc', origins: ['https://www.ebi.ac.uk'], domain: 'biomedical', byDefault: false },
  { id: 'pubmed', origins: ['https://eutils.ncbi.nlm.nih.gov'], domain: 'biomedical', byDefault: false },
  { id: 'clinicaltrials', origins: ['https://clinicaltrials.gov'], domain: 'biomedical', byDefault: false },
  { id: 'ietf', origins: ['https://datatracker.ietf.org'], domain: 'standards', byDefault: false },
] satisfies ResearchBackendInfo[])

export const BACKEND_IDS: readonly ResearchBackendId[] = BACKENDS.map((b) => b.id)

/** Every origin the backends contact, sorted: the `research` entry of spec/network-allowlist.json. */
export const RESEARCH_ORIGINS: readonly string[] = [...new Set(BACKENDS.flatMap((b) => b.origins))].sort()

export function isBackendId(value: unknown): value is ResearchBackendId {
  return typeof value === 'string' && (BACKEND_IDS as readonly string[]).includes(value)
}

/**
 * The backends of the ultrasearch skill a browser cannot use, and why (checked with a cross-origin GET from
 * `https://maxgfr.github.io`). Shown in the settings and the spec; never contacted.
 */
export const UNREACHABLE_BACKENDS: readonly {
  readonly id: string
  readonly endpoint: string
  readonly reason: string
}[] = Object.freeze([
  {
    id: 'duckduckgo',
    endpoint: 'https://html.duckduckgo.com/html/',
    reason: 'answers 403 to a browser and sends no CORS headers',
  },
  { id: 'ddglite', endpoint: 'https://lite.duckduckgo.com/lite/', reason: 'answers 403 and sends no CORS headers' },
  { id: 'reddit', endpoint: 'https://www.reddit.com/search.rss', reason: 'sends no CORS headers' },
  {
    id: 'dblp',
    endpoint: 'https://dblp.org/search/publ/api',
    reason: 'answers a 202 bot challenge without CORS headers',
  },
  { id: 'arxiv', endpoint: 'https://export.arxiv.org/api/query', reason: 'sends no CORS headers (and rate-limits)' },
  {
    id: 'semanticscholar',
    endpoint: 'https://api.semanticscholar.org/graph/v1/paper/search',
    reason: 'answers 429 to unauthenticated clients, without CORS headers',
  },
  { id: 'mdn', endpoint: 'https://developer.mozilla.org/api/v1/search', reason: 'sends no CORS headers' },
  {
    id: 'wayback',
    endpoint: 'https://web.archive.org/web/',
    reason: 'snapshots redirect without CORS headers',
  },
  {
    id: 'searxng',
    endpoint: 'http://localhost:8888/search',
    reason: 'self-hosted, and public instances disable the JSON format',
  },
  { id: 'firecrawl', endpoint: 'http://localhost:3002', reason: 'self-hosted' },
])

export type BackendFailure = 'rate-limited' | 'unreachable' | 'http' | 'malformed' | 'wall'

/** Why a backend gave no results. */
export class BackendError extends Error {
  override readonly name = 'BackendError'
  constructor(
    readonly backend: ResearchBackendId,
    readonly reason: BackendFailure,
    message: string,
  ) {
    super(message)
  }
}

export interface BackendOptions {
  /** web/src/security/net.ts `request` with purpose `research`. */
  readonly http: FetchLike
  /** Hits wanted (at most). */
  readonly limit: number
  /** The language of the query (Wikipedia searches that language's edition). */
  readonly lang?: string
  readonly signal?: AbortSignal
}

/** The largest answer a backend may send. */
const MAX_RESPONSE_CHARS = 4 * 1024 * 1024
const SNIPPET_CHARS = 360

export function abortError(): Error {
  const error = new Error('The search was stopped')
  error.name = 'AbortError'
  return error
}

type Json = Record<string, unknown>

const obj = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')

/** Text of an HTML or JATS fragment, on one line, cut to a snippet. */
function clean(html: string, max = SNIPPET_CHARS): string {
  const text = htmlText(html).replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

async function get(id: ResearchBackendId, url: string, options: BackendOptions): Promise<string> {
  const { http, signal } = options
  if (signal?.aborted) throw abortError()
  let response: Response
  try {
    response = await http(url, { method: 'GET', redirect: 'follow', ...(signal === undefined ? {} : { signal }) })
  } catch {
    if (signal?.aborted) throw abortError()
    throw new BackendError(id, 'unreachable', 'could not be reached')
  }
  if (response.status === 429 || response.status === 503) {
    await response.body?.cancel().catch(() => undefined)
    throw new BackendError(id, 'rate-limited', `rate-limited (HTTP ${response.status})`)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new BackendError(id, 'http', `answered HTTP ${response.status}`)
  }
  let text: string
  try {
    text = await response.text()
  } catch {
    if (signal?.aborted) throw abortError()
    throw new BackendError(id, 'unreachable', 'the answer was cut off')
  }
  if (text.length > MAX_RESPONSE_CHARS) throw new BackendError(id, 'malformed', 'the answer is too large')
  return text
}

async function getJson(id: ResearchBackendId, url: string, options: BackendOptions): Promise<Json> {
  const text = await get(id, url, options)
  try {
    return obj(JSON.parse(text))
  } catch {
    throw new BackendError(id, 'malformed', 'did not answer JSON')
  }
}

const query = (params: Record<string, string | number>): string =>
  new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()

/** A Wikipedia page key as a path segment: encoded, with `/` and `:` kept readable. */
function wikiPath(key: string): string {
  return encodeURIComponent(key.replace(/ /g, '_')).replace(/%2F/gi, '/').replace(/%3A/gi, ':')
}

async function wikipedia(q: string, o: BackendOptions): Promise<SearchHit[]> {
  const lang = wikipediaLang(o.lang)
  const data = await getJson(
    'wikipedia',
    `https://${lang}.wikipedia.org/w/rest.php/v1/search/page?${query({ q, limit: o.limit })}`,
    o,
  )
  return arr(data.pages).flatMap((p) => {
    const page = obj(p)
    const key = str(page.key)
    if (key === '') return []
    const excerpt = clean(str(page.excerpt))
    const description = str(page.description).trim()
    return [
      {
        url: `https://${lang}.wikipedia.org/wiki/${wikiPath(key)}`,
        title: str(page.title) || key,
        snippet: [description, excerpt].filter((s) => s !== '').join(' — '),
        backend: 'wikipedia',
      } satisfies SearchHit,
    ]
  })
}

async function marginalia(q: string, o: BackendOptions): Promise<SearchHit[]> {
  const data = await getJson(
    'marginalia',
    `https://api.marginalia-search.com/public/search/${encodeURIComponent(q)}?${query({ count: o.limit })}`,
    o,
  )
  return arr(data.results).flatMap((r) => {
    const hit = obj(r)
    const url = str(hit.url)
    if (!/^https?:\/\//i.test(url)) return []
    return [{ url, title: str(hit.title) || url, snippet: clean(str(hit.description)), backend: 'marginalia' as const }]
  })
}

/** Whether a Mojeek page is its captcha (or another challenge) instead of results. */
function mojeekWall(html: string): boolean {
  return /<title>\s*captcha\s*<\/title>/i.test(html) || /class="captcha-wrap"/i.test(html)
}

/** Mojeek's results: a title anchor of class `title`, then its snippet in `<p class="s">`, block by block. */
export function parseMojeek(html: string, limit: number): SearchHit[] {
  const out: SearchHit[] = []
  const block =
    /<a\b([^>]*\bclass="[^"]*\btitle\b[^"]*"[^>]*)>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*\bclass="[^"]*\btitle\b|$)/gi
  for (const m of html.matchAll(block)) {
    if (out.length >= limit) break
    const attrs = m[1] ?? ''
    let href = /\bhref="([^"]+)"/i.exec(attrs)?.[1] ?? ''
    href = href.replace(/&amp;/g, '&')
    if (href.startsWith('//')) href = `https:${href}`
    let host = ''
    try {
      host = new URL(href).hostname
    } catch {
      continue
    }
    if (!/^https?:\/\//i.test(href) || /(^|\.)mojeek\.com$/i.test(host)) continue
    const snippet = /<p\b[^>]*\bclass="[^"]*\bs\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(m[3] ?? '')?.[1] ?? ''
    out.push({ url: href, title: clean(m[2] ?? '') || href, snippet: clean(snippet), backend: 'mojeek' })
  }
  return out
}

async function mojeek(q: string, o: BackendOptions): Promise<SearchHit[]> {
  const html = await get('mojeek', `https://www.mojeek.com/search?${query({ q })}`, o)
  if (mojeekWall(html)) throw new BackendError('mojeek', 'wall', 'asked for a captcha')
  return parseMojeek(html, o.limit)
}

async function hackernews(q: string, o: BackendOptions): Promise<SearchHit[]> {
  const data = await getJson(
    'hackernews',
    `https://hn.algolia.com/api/v1/search?${query({ query: q, tags: 'story', hitsPerPage: o.limit })}`,
    o,
  )
  return arr(data.hits).flatMap((h) => {
    const hit = obj(h)
    const id = str(hit.objectID)
    const discussion = `https://news.ycombinator.com/item?id=${encodeURIComponent(id)}`
    const url = /^https?:\/\//i.test(str(hit.url)) ? str(hit.url) : id === '' ? '' : discussion
    if (url === '') return []
    const counts = `${str(hit.points) || '0'} points, ${str(hit.num_comments) || '0'} comments on Hacker News`
    const text = clean(str(hit.story_text))
    return [
      {
        url,
        title: str(hit.title) || url,
        snippet: text === '' ? counts : `${counts}. ${text}`,
        backend: 'hackernews' as const,
        ...(str(hit.created_at) === '' ? {} : { date: str(hit.created_at) }),
      },
    ]
  })
}

/** The Stack Exchange sites searched, as ultrasearch does, bounded to the first three. */
const SE_SITES = ['stackoverflow', 'serverfault', 'superuser'] as const

async function stackexchange(q: string, o: BackendOptions): Promise<SearchHit[]> {
  const per = Math.max(1, Math.ceil(o.limit / SE_SITES.length))
  const lists = await Promise.all(
    SE_SITES.map(async (site) => {
      const data = await getJson(
        'stackexchange',
        `https://api.stackexchange.com/2.3/search/advanced?${query({
          site,
          q,
          pagesize: per,
          order: 'desc',
          sort: 'relevance',
          filter: 'withbody',
        })}`,
        o,
      )
      return arr(data.items).flatMap((i) => {
        const item = obj(i)
        const url = str(item.link)
        if (!/^https:\/\//i.test(url)) return []
        const created = typeof item.creation_date === 'number' ? new Date(item.creation_date * 1000) : null
        return [
          {
            url,
            title: clean(str(item.title)) || url,
            snippet: clean(str(item.body)),
            backend: 'stackexchange' as const,
            ...(created === null || Number.isNaN(created.getTime()) ? {} : { date: created.toISOString() }),
          },
        ]
      })
    }),
  )
  // Interleaved by rank, so one site cannot crowd out the others.
  const out: SearchHit[] = []
  for (let i = 0; out.length < o.limit && lists.some((l) => i < l.length); i++)
    for (const list of lists) {
      const hit = list[i]
      if (hit !== undefined && out.length < o.limit) out.push(hit)
    }
  return out
}

async function github(q: string, o: BackendOptions): Promise<SearchHit[]> {
  const data = await getJson('github', `https://api.github.com/search/issues?${query({ q, per_page: o.limit })}`, o)
  return arr(data.items).flatMap((i) => {
    const item = obj(i)
    const url = str(item.html_url)
    if (!/^https:\/\/github\.com\//i.test(url)) return []
    return [
      {
        url,
        title: str(item.title) || url,
        snippet: clean(str(item.body)),
        backend: 'github' as const,
        ...(str(item.created_at) === '' ? {} : { date: str(item.created_at) }),
      },
    ]
  })
}

/** OpenAlex keeps an abstract as an inverted index (word to positions); this puts the words back in order. */
export function invertedAbstract(index: unknown): string {
  const words: string[] = []
  for (const [word, positions] of Object.entries(obj(index))) {
    for (const p of arr(positions))
      if (typeof p === 'number' && Number.isInteger(p) && p >= 0 && p < 10_000) words[p] = word
  }
  return words.filter((w) => w !== undefined).join(' ')
}

async function openalex(q: string, o: BackendOptions): Promise<SearchHit[]> {
  const data = await getJson(
    'openalex',
    `https://api.openalex.org/works?${query({ search: q, 'per-page': o.limit })}`,
    o,
  )
  return arr(data.results).flatMap((r) => {
    const work = obj(r)
    const url = /^https:\/\//i.test(str(work.doi)) ? str(work.doi) : str(work.id)
    if (!/^https:\/\//i.test(url)) return []
    const year = str(work.publication_year)
    return [
      {
        url,
        title: clean(str(work.display_name) || str(work.title)) || url,
        snippet: clean(invertedAbstract(work.abstract_inverted_index)),
        backend: 'openalex' as const,
        ...(str(work.publication_date) !== ''
          ? { date: str(work.publication_date) }
          : year !== ''
            ? { date: year }
            : {}),
      },
    ]
  })
}

/** The first year of a Crossref `date-parts` value. */
function crossrefYear(value: unknown): string {
  const first = arr(arr(obj(value)['date-parts'])[0])[0]
  return typeof first === 'number' ? String(first) : ''
}

async function crossref(q: string, o: BackendOptions): Promise<SearchHit[]> {
  const data = await getJson('crossref', `https://api.crossref.org/works?${query({ query: q, rows: o.limit })}`, o)
  return arr(obj(data.message).items).flatMap((i) => {
    const item = obj(i)
    const doi = str(item.DOI)
    const url = doi !== '' ? `https://doi.org/${doi}` : str(item.URL)
    if (!/^https?:\/\//i.test(url)) return []
    const container = str(arr(item['container-title'])[0])
    const year = crossrefYear(item.published) || crossrefYear(item.issued)
    const abstract = clean(str(item.abstract))
    return [
      {
        url,
        title: clean(str(arr(item.title)[0])) || url,
        snippet: [container, year, abstract].filter((s) => s !== '').join('. '),
        backend: 'crossref' as const,
        ...(year === '' ? {} : { date: year }),
      },
    ]
  })
}

async function europepmc(q: string, o: BackendOptions): Promise<SearchHit[]> {
  const data = await getJson(
    'europepmc',
    `https://www.ebi.ac.uk/europepmc/webservices/rest/search?${query({
      query: q,
      format: 'json',
      resultType: 'core',
      pageSize: o.limit,
    })}`,
    o,
  )
  return arr(obj(data.resultList).result).flatMap((r) => {
    const item = obj(r)
    const pmid = str(item.pmid)
    const doi = str(item.doi)
    const source = str(item.source)
    const id = str(item.id)
    const url = /^\d+$/.test(pmid)
      ? `https://europepmc.org/article/MED/${pmid}`
      : doi !== ''
        ? `https://doi.org/${doi}`
        : source !== '' && id !== ''
          ? `https://europepmc.org/article/${encodeURIComponent(source)}/${encodeURIComponent(id)}`
          : ''
    if (url === '') return []
    const year = str(item.pubYear)
    return [
      {
        url,
        title: clean(str(item.title)) || url,
        snippet: clean(str(item.abstractText)),
        backend: 'europepmc' as const,
        ...(year === '' ? {} : { date: year }),
      },
    ]
  })
}

async function pubmed(q: string, o: BackendOptions): Promise<SearchHit[]> {
  const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils'
  const found = await getJson(
    'pubmed',
    `${base}/esearch.fcgi?${query({ db: 'pubmed', term: q, retmode: 'json', retmax: o.limit, tool: 'aparte' })}`,
    o,
  )
  const ids = arr(obj(found.esearchresult).idlist)
    .map(str)
    .filter((id) => /^\d+$/.test(id))
  if (ids.length === 0) return []
  const summary = await getJson(
    'pubmed',
    `${base}/esummary.fcgi?${query({ db: 'pubmed', id: ids.join(','), retmode: 'json', tool: 'aparte' })}`,
    o,
  )
  const result = obj(summary.result)
  return ids.flatMap((id) => {
    const doc = obj(result[id])
    const title = clean(str(doc.title))
    if (title === '') return []
    const journal = str(doc.fulljournalname) || str(doc.source)
    const authors = arr(doc.authors)
      .slice(0, 3)
      .map((a) => str(obj(a).name))
      .filter((n) => n !== '')
    const pubdate = str(doc.pubdate)
    return [
      {
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        title,
        snippet: [journal, pubdate, authors.join(', ')].filter((s) => s !== '').join('. '),
        backend: 'pubmed' as const,
        ...(pubdate === '' ? {} : { date: pubdate }),
      },
    ]
  })
}

async function clinicaltrials(q: string, o: BackendOptions): Promise<SearchHit[]> {
  const data = await getJson(
    'clinicaltrials',
    `https://clinicaltrials.gov/api/v2/studies?${query({ 'query.term': q, format: 'json', pageSize: o.limit })}`,
    o,
  )
  return arr(data.studies).flatMap((s) => {
    const protocol = obj(obj(s).protocolSection)
    const ident = obj(protocol.identificationModule)
    const nct = str(ident.nctId)
    if (!/^NCT\d+$/.test(nct)) return []
    const status = obj(protocol.statusModule)
    const start = str(obj(status.startDateStruct).date)
    const summary = clean(str(obj(protocol.descriptionModule).briefSummary))
    return [
      {
        url: `https://clinicaltrials.gov/study/${nct}`,
        title: clean(str(ident.briefTitle) || str(ident.officialTitle)) || nct,
        snippet: [str(status.overallStatus), summary].filter((x) => x !== '').join('. '),
        backend: 'clinicaltrials' as const,
        ...(start === '' ? {} : { date: start }),
      },
    ]
  })
}

const STOP_WORDS = new Set(
  'a about an and are as at be by can do does for from how in is it of on or rfc say says should the to what when which why with work works'.split(
    ' ',
  ),
)

async function ietf(q: string, o: BackendOptions): Promise<SearchHit[]> {
  const base = 'https://datatracker.ietf.org/api/v1/doc/document/'
  const numbers = [...new Set([...q.matchAll(/\bRFC[-\s]?(\d{3,5})\b/gi)].map((m) => m[1] as string))].slice(0, 3)
  const words = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  const lists: Json[] = []
  for (const n of numbers) lists.push(await getJson('ietf', `${base}?${query({ format: 'json', name: `rfc${n}` })}`, o))
  if (numbers.length === 0 && words.length > 0) {
    // The title filter matches a substring: the two first significant words are what a title can hold together.
    const title = words.slice(0, 2).join(' ')
    lists.push(
      await getJson(
        'ietf',
        `${base}?${query({ format: 'json', title__icontains: title, type: 'rfc', limit: o.limit })}`,
        o,
      ),
    )
  }
  const out: SearchHit[] = []
  const seen = new Set<string>()
  for (const data of lists)
    for (const d of arr(data.objects)) {
      const doc = obj(d)
      const n = str(doc.rfc_number) || str(doc.rfc)
      if (!/^\d+$/.test(n) || seen.has(n) || out.length >= o.limit) continue
      seen.add(n)
      out.push({
        url: `https://www.rfc-editor.org/rfc/rfc${n}`,
        title: `RFC ${n}: ${clean(str(doc.title))}`,
        snippet: clean(str(doc.abstract)),
        backend: 'ietf',
        ...(str(doc.time) === '' ? {} : { date: str(doc.time) }),
      })
    }
  return out
}

const SEARCH: Readonly<Record<ResearchBackendId, (q: string, o: BackendOptions) => Promise<SearchHit[]>>> = {
  wikipedia,
  marginalia,
  mojeek,
  hackernews,
  stackexchange,
  github,
  openalex,
  crossref,
  europepmc,
  pubmed,
  clinicaltrials,
  ietf,
}

/** One query on one backend: its hits, in its own order, at most `limit`. */
export async function searchBackend(id: ResearchBackendId, q: string, options: BackendOptions): Promise<SearchHit[]> {
  const text = q.trim()
  if (text === '') return []
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit)))
  const hits = await SEARCH[id](text, { ...options, limit })
  return hits.slice(0, limit)
}
