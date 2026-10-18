/*
 * Reading one page for Deep research (contracts/research.ts): its readable text, its title, and whether it is a page
 * at all or a wall (a consent banner, an anti-bot challenge, an "enable JavaScript" shell).
 *
 * Invariants:
 * - Only public addresses are read: https (an http address is read over https), no credentials, no host on this
 *   device or a private network, before and after any redirect. The page goes through `page` (web/src/security/net.ts with purpose `tool`): no cookie,
 *   no referrer, no header of its own.
 * - A few sites are read through their CORS-friendly APIs instead of their pages (`api`, purpose `research`, hosts in
 *   the allowlist): Wikipedia articles (plain-text extracts) and Hacker News items. The source keeps the page's URL.
 * - At most READ_MAX_BYTES of a textual answer is read; HTML is reduced to text without being parsed into a document,
 *   from its main region when one is clearly there; the text kept is at most `chars` characters, and says when cut.
 * - A failure is a result (`failed`, with a note in words), never an exception; only an abort rejects. A site that
 *   refuses cross-origin reads looks like a network failure to a page, and is reported as such.
 */
import type { FetchLike } from '../contracts/ai.ts'
import type { SourceStatus } from '../contracts/research.ts'
import { htmlText, privateHost } from '../tools/builtins.ts'
import { abortError, WIKIPEDIA_LANGS } from './backends.ts'

/** The largest answer read. */
export const READ_MAX_BYTES = 1024 * 1024

export interface ReadOptions {
  /** The page itself: web/src/security/net.ts `request` with purpose `tool`. */
  readonly page: FetchLike
  /** The readable APIs (Wikipedia, Hacker News): net.ts with purpose `research`. */
  readonly api: FetchLike
  /** Characters of text kept. */
  readonly chars: number
  readonly signal?: AbortSignal
}

export interface PageRead {
  readonly status: SourceStatus
  readonly title: string
  /** The readable text; '' unless `ok`. */
  readonly text: string
  readonly note?: string
  /** Where a redirect led, when not the URL asked. */
  readonly finalUrl?: string
}

export const UNREACHABLE_NOTE = 'unreachable from the browser (the site sends no CORS headers, or the network failed)'

const TEXTUAL =
  /^(text\/|application\/(json|ld\+json|xml|xhtml\+xml|rss\+xml|atom\+xml|javascript)\b|[^;]*\+(json|xml)\b)/i

const WALL =
  /(enable javascript|javascript is (required|disabled)|requires javascript|turn on javascript|captcha|are you a (human|robot)|verify (that )?you are (a )?human|checking (if the site connection is secure|your browser)|just a moment|access denied|attention required|cookies (must|need to) be enabled|enable cookies|accept (all )?cookies|we value your privacy|consent to (the use of )?cookies|unusual traffic|bot (protection|detection))/i

/**
 * Whether a page's text is a wall rather than content: a short text dominated by consent, anti-bot or
 * "enable JavaScript" wording (or a title that says so).
 */
export function isWall(text: string, title = ''): boolean {
  if (/^(just a moment|attention required|captcha|access denied|are you a robot)/i.test(title.trim())) return true
  const t = text.trim()
  if (t.length === 0) return false
  return t.length < 1500 && WALL.test(t)
}

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]?.toLowerCase() === 'x' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** A page's title: `og:title`, else `<title>`, on one line. */
export function pageTitle(html: string): string {
  const og =
    /<meta\b[^>]*\bproperty=["']og:title["'][^>]*\bcontent=["']([^"']*)["']/i.exec(html)?.[1] ??
    /<meta\b[^>]*\bcontent=["']([^"']*)["'][^>]*\bproperty=["']og:title["']/i.exec(html)?.[1]
  const raw = og ?? /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? ''
  return decodeEntities(raw).replace(/\s+/g, ' ').trim()
}

/**
 * The readable text of an HTML page: its `<main>` or largest `<article>` when that region holds most of the text (so
 * navigation, sidebars and footers stay out), else the whole page.
 */
export function pageText(html: string): string {
  const whole = htmlText(html)
  const regions = [
    ...html.matchAll(/<main\b[^>]*>([\s\S]*?)<\/main\s*>/gi),
    ...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article\s*>/gi),
  ].map((m) => htmlText(m[1] ?? ''))
  const best = regions.sort((a, b) => b.length - a.length)[0]
  if (best !== undefined && best.length >= 200 && best.length >= whole.length * 0.25) return best
  return whole
}

/** `text` cut to `chars`, with a note when it was. */
function cut(text: string, chars: number): string {
  if (text.length <= chars) return text
  return `${text.slice(0, chars).trimEnd()}\n[The text was cut here: only its first ${chars} characters are kept.]`
}

async function readCapped(response: Response, signal: AbortSignal | undefined): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (reader === undefined) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      if (signal?.aborted) throw abortError()
      const { done, value } = await reader.read()
      if (done) break
      const room = READ_MAX_BYTES - size
      if (value.length >= room) {
        chunks.push(value.subarray(0, room))
        size += room
        break
      }
      chunks.push(value)
      size += value.length
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

const failed = (note: string, title = ''): PageRead => ({ status: 'failed', title, text: '', note })

/** JSON from a readable API, or null when it could not be had. */
async function apiJson(api: FetchLike, url: string, signal: AbortSignal | undefined): Promise<unknown> {
  let response: Response
  try {
    response = await api(url, { method: 'GET', ...(signal === undefined ? {} : { signal }) })
  } catch {
    if (signal?.aborted) throw abortError()
    return null
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  try {
    return JSON.parse(new TextDecoder().decode(await readCapped(response, signal)))
  } catch (error) {
    if (signal?.aborted) throw error
    return null
  }
}

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** A Wikipedia article through the extracts API (plain text, CORS with `origin=*`). */
async function wikipediaArticle(lang: string, title: string, o: ReadOptions): Promise<PageRead> {
  const params = new URLSearchParams({
    action: 'query',
    prop: 'extracts',
    explaintext: '1',
    redirects: '1',
    format: 'json',
    formatversion: '2',
    origin: '*',
    titles: title,
  })
  const data = await apiJson(o.api, `https://${lang}.wikipedia.org/w/api.php?${params.toString()}`, o.signal)
  const query = obj(obj(data).query)
  const pages = Array.isArray(query.pages) ? query.pages : Object.values(obj(query.pages))
  const page = obj(pages[0])
  const extract = typeof page.extract === 'string' ? page.extract.trim() : ''
  const name = typeof page.title === 'string' ? page.title : title.replace(/_/g, ' ')
  if (data === null) return failed('Wikipedia could not be reached')
  if (extract === '') return failed('Wikipedia has no article of that name', name)
  return { status: 'ok', title: name, text: cut(extract, o.chars) }
}

/** A Hacker News item (a story and its first comments) through the Algolia API. */
async function hackerNewsItem(id: string, o: ReadOptions): Promise<PageRead> {
  const data = obj(await apiJson(o.api, `https://hn.algolia.com/api/v1/items/${encodeURIComponent(id)}`, o.signal))
  if (Object.keys(data).length === 0) return failed('Hacker News could not be reached')
  const title = typeof data.title === 'string' ? data.title : ''
  const parts: string[] = []
  if (typeof data.url === 'string' && data.url !== '') parts.push(`Link: ${data.url}`)
  if (typeof data.text === 'string') parts.push(htmlText(data.text))
  const walk = (children: unknown, depth: number) => {
    if (!Array.isArray(children) || depth > 2) return
    for (const c of children.slice(0, 20)) {
      const child = obj(c)
      if (typeof child.text === 'string' && child.text !== '') {
        parts.push(`${typeof child.author === 'string' ? child.author : 'comment'}: ${htmlText(child.text)}`)
      }
      walk(child.children, depth + 1)
    }
  }
  walk(data.children, 0)
  const text = parts.filter((p) => p.trim() !== '').join('\n\n')
  if (text === '') return failed('the item has no text', title)
  return { status: 'ok', title, text: cut(text, o.chars) }
}

/** Reads one page; never rejects but on abort. */
export async function readPage(raw: string, o: ReadOptions): Promise<PageRead> {
  if (o.signal?.aborted) throw abortError()
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return failed('not a valid address')
  }
  if (url.protocol === 'http:') url.protocol = 'https:'
  if (url.protocol !== 'https:') return failed('only web pages (https) are read')
  if (url.username !== '' || url.password !== '') return failed('an address with credentials is never read')
  if (privateHost(url.hostname)) return failed('addresses on this device or a private network are never read')
  url.hash = ''

  const wiki = /^([a-z]{2,3})(?:\.m)?\.wikipedia\.org$/i.exec(url.hostname)
  const article = /^\/wiki\/(.+)$/.exec(url.pathname)?.[1]
  if (wiki?.[1] !== undefined && article !== undefined) {
    const lang = wiki[1].toLowerCase()
    if ((WIKIPEDIA_LANGS as readonly string[]).includes(lang)) {
      let title: string
      try {
        title = decodeURIComponent(article)
      } catch {
        title = article
      }
      return wikipediaArticle(lang, title, o)
    }
  }
  if (url.hostname === 'news.ycombinator.com' && url.pathname === '/item') {
    const id = url.searchParams.get('id') ?? ''
    if (/^\d+$/.test(id)) return hackerNewsItem(id, o)
  }

  let response: Response
  try {
    response = await o.page(url.href, {
      method: 'GET',
      redirect: 'follow',
      ...(o.signal === undefined ? {} : { signal: o.signal }),
    })
  } catch {
    if (o.signal?.aborted) throw abortError()
    return failed(UNREACHABLE_NOTE)
  }
  const finalUrl = response.url !== '' && response.url !== url.href ? { finalUrl: response.url } : {}
  // A redirect may have led the request to this machine, a private network or plain http, where a local server may
  // let the app's origin read it: such an answer is dropped unread.
  const landed = response.redirected && response.url !== '' ? new URL(response.url) : url
  if (landed.protocol !== 'https:' || privateHost(landed.hostname)) {
    await response.body?.cancel().catch(() => undefined)
    return { ...failed('it redirected to an address on this device, a private network or plain http'), ...finalUrl }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return { ...failed(`the site answered HTTP ${response.status}`), ...finalUrl }
  }
  const type = (response.headers.get('content-type') ?? '').toLowerCase()
  if (type.startsWith('application/pdf') || /\.pdf$/i.test(url.pathname)) {
    await response.body?.cancel().catch(() => undefined)
    return { ...failed('a PDF: its text is not extracted in the browser'), ...finalUrl }
  }
  if (type !== '' && !TEXTUAL.test(type)) {
    await response.body?.cancel().catch(() => undefined)
    return { ...failed(`not a text page (${type.split(';')[0]})`), ...finalUrl }
  }
  let body: string
  try {
    body = new TextDecoder('utf-8').decode(await readCapped(response, o.signal))
  } catch (error) {
    if (o.signal?.aborted) throw error
    return { ...failed('the page was cut off'), ...finalUrl }
  }
  const html = /html/.test(type) || (type === '' && /^\s*<(!doctype|html)/i.test(body))
  const title = html ? pageTitle(body) : ''
  const text = (html ? pageText(body) : body).trim()
  if (isWall(text, title)) {
    return {
      status: 'wall',
      title,
      text: '',
      note: 'a consent, anti-bot or "enable JavaScript" page stood in for the content',
      ...finalUrl,
    }
  }
  if (text === '') return { ...failed('the page has no readable text', title), ...finalUrl }
  return { status: 'ok', title, text: cut(text, o.chars), ...finalUrl }
}
