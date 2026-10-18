/*
 * The web as the research tests play it: every backend answers from the trimmed real responses of ./fixtures (saved
 * once from each service), pages are served from a map, and every request is recorded with its init, so a test can
 * prove what was asked, and that nothing else was. Used by the unit tests only; nothing here reaches the network.
 */
import type { FetchLike } from '../contracts/ai.ts'

const FIXTURES = [
  'wikipedia-search.json',
  'wikipedia-summary.json',
  'wikipedia-extract.json',
  'marginalia.json',
  'mojeek.html',
  'mojeek-captcha.html',
  'hackernews.json',
  'hackernews-item.json',
  'stackexchange.json',
  'github.json',
  'openalex.json',
  'crossref.json',
  'europepmc.json',
  'pubmed-esearch.json',
  'pubmed-esummary.json',
  'clinicaltrials.json',
  'ietf.json',
] as const

export type FixtureName = (typeof FIXTURES)[number]

/** The fixture files, by name. */
export async function loadFixtures(): Promise<Record<FixtureName, string>> {
  const out: Partial<Record<FixtureName, string>> = {}
  for (const name of FIXTURES) out[name] = await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text()
  return out as Record<FixtureName, string>
}

export interface Served {
  readonly status?: number
  readonly type?: string
  readonly body: string
  /** The request fails as a CORS refusal or a network failure does: a TypeError. */
  readonly refuse?: boolean
}

export interface Recorded {
  readonly url: string
  readonly init: RequestInit | undefined
}

/** A FetchLike that answers by URL prefix (the longest prefix wins) and records every request. */
export function fakeWeb(routes: Readonly<Record<string, Served>>): {
  readonly http: FetchLike
  readonly requests: Recorded[]
} {
  const requests: Recorded[] = []
  const prefixes = Object.keys(routes).sort((a, b) => b.length - a.length)
  const http: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push({ url, init })
    if (init?.signal?.aborted) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    }
    const prefix = prefixes.find((p) => url.startsWith(p))
    const served = prefix === undefined ? undefined : routes[prefix]
    if (served === undefined || served.refuse) throw new TypeError('Failed to fetch')
    return new Response(served.body, {
      status: served.status ?? 200,
      headers: { 'content-type': served.type ?? 'application/json' },
    })
  }
  return { http, requests }
}

/** The routes of every backend, answered from the fixtures. */
export function backendRoutes(f: Record<FixtureName, string>): Record<string, Served> {
  const json = (body: string): Served => ({ body })
  return {
    'https://en.wikipedia.org/w/rest.php/v1/search/page': json(f['wikipedia-search.json']),
    'https://fr.wikipedia.org/w/rest.php/v1/search/page': json(f['wikipedia-search.json']),
    'https://en.wikipedia.org/w/api.php': json(f['wikipedia-extract.json']),
    'https://api.marginalia-search.com/public/search/': json(f['marginalia.json']),
    'https://www.mojeek.com/search': { body: f['mojeek.html'], type: 'text/html; charset=UTF-8' },
    'https://hn.algolia.com/api/v1/search': json(f['hackernews.json']),
    'https://hn.algolia.com/api/v1/items/': json(f['hackernews-item.json']),
    'https://api.stackexchange.com/2.3/search/advanced': json(f['stackexchange.json']),
    'https://api.github.com/search/issues': json(f['github.json']),
    'https://api.openalex.org/works': json(f['openalex.json']),
    'https://api.crossref.org/works': json(f['crossref.json']),
    'https://www.ebi.ac.uk/europepmc/webservices/rest/search': json(f['europepmc.json']),
    'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi': json(f['pubmed-esearch.json']),
    'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi': json(f['pubmed-esummary.json']),
    'https://clinicaltrials.gov/api/v2/studies': json(f['clinicaltrials.json']),
    'https://datatracker.ietf.org/api/v1/doc/document/': json(f['ietf.json']),
  }
}
