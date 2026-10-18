/*
 * The identity of a URL and the fusion of search results (contracts/research.ts): several backends and several
 * queries name the same page in different ways, and a source must be counted, read and cited once.
 *
 * Invariants:
 * - `normalizeUrl` is an identity, not a fetchable address: the scheme becomes `https:`, the host loses its case and a
 *   leading `www.` (and Wikipedia's mobile `m.`), the fragment, the default port, the tracking parameters
 *   (`utm_*`, `fbclid`, `gclid`...) and a trailing slash go, the other parameters are sorted. arXiv `pdf` and
 *   versionless forms of a paper collapse to its `abs` page; `dx.doi.org` and `doi.org` give one lowercase DOI URL.
 *   Anything but http(s), or a URL with credentials, has no identity (null).
 * - `fuseHits` is deterministic: reciprocal-rank fusion (k = 60) over the lists, ties broken by identity, the title,
 *   snippet and URL of the best-ranked hit kept, every backend that found the page listed in first-seen order.
 */
import type { FusedHit, ResearchBackendId, SearchHit } from '../contracts/research.ts'

const TRACKING = /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi|ref_src|ref)$/i

/** The identity of a page, or null when `raw` is not an http(s) URL. */
export function normalizeUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username !== '' || url.password !== '') return null
  let host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (host.startsWith('www.')) host = host.slice(4)
  host = host.replace(/^([a-z-]+)\.m\.wikipedia\.org$/, '$1.wikipedia.org')
  if (host === 'dx.doi.org') host = 'doi.org'
  const port = url.port === '' || url.port === '80' || url.port === '443' ? '' : `:${url.port}`
  let path = url.pathname.replace(/\/{2,}/g, '/')
  if (host === 'arxiv.org') {
    const paper = /^\/(?:abs|pdf|html)\/([^/]+?)(?:\.pdf)?\/?$/i.exec(path)
    if (paper?.[1] !== undefined) path = `/abs/${paper[1]}`
  }
  if (host === 'doi.org') path = path.toLowerCase()
  if (path.length > 1) path = path.replace(/\/+$/, '')
  const params = [...url.searchParams.entries()]
    .filter(([k]) => !TRACKING.test(k))
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
  const search = params.length === 0 ? '' : `?${new URLSearchParams(params).toString()}`
  return `https://${host}${port}${path === '' ? '/' : path}${search}`
}

/** Reciprocal-rank fusion constant (Cormack et al.): flattens the head of each list. */
const RRF_K = 60

interface Acc {
  key: string
  score: number
  best: SearchHit
  bestRank: number
  from: ResearchBackendId[]
  date?: string
}

/**
 * Fuses ranked lists (one per backend and query) into one ranking, one entry per identity URL, at most `limit`.
 * Hits without an identity are dropped.
 */
export function fuseHits(lists: readonly (readonly SearchHit[])[], limit: number): FusedHit[] {
  const byKey = new Map<string, Acc>()
  for (const list of lists) {
    const seen = new Set<string>()
    list.forEach((hit, i) => {
      const key = normalizeUrl(hit.url)
      if (key === null || seen.has(key)) return
      seen.add(key)
      const rank = i + 1
      const acc = byKey.get(key)
      if (acc === undefined) {
        byKey.set(key, {
          key,
          score: 1 / (RRF_K + rank),
          best: hit,
          bestRank: rank,
          from: [hit.backend],
          ...(hit.date === undefined ? {} : { date: hit.date }),
        })
        return
      }
      acc.score += 1 / (RRF_K + rank)
      if (!acc.from.includes(hit.backend)) acc.from.push(hit.backend)
      if (rank < acc.bestRank) {
        acc.best = hit
        acc.bestRank = rank
      }
      if (acc.date === undefined && hit.date !== undefined) acc.date = hit.date
    })
  }
  return [...byKey.values()]
    .sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, Math.max(0, limit))
    .map((a) => ({
      url: a.best.url,
      title: a.best.title,
      snippet: a.best.snippet,
      from: a.from,
      score: Math.round(a.score * 1e6) / 1e6,
      ...(a.date === undefined ? {} : { date: a.date }),
    }))
}
