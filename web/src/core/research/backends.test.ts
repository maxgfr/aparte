/*
 * The keyless backends over trimmed real answers of each service (./fixtures): what each parser keeps, that every
 * request is a plain GET to an origin the backend declares (no header, so no CORS preflight), and how failures read.
 */
import { describe, expect, test } from 'bun:test'
import type { ResearchBackendId } from '../contracts/research.ts'
import {
  BACKEND_IDS,
  BACKENDS,
  BackendError,
  invertedAbstract,
  parseMojeek,
  RESEARCH_ORIGINS,
  searchBackend,
  UNREACHABLE_BACKENDS,
  wikipediaLang,
} from './backends.ts'
import { backendRoutes, fakeWeb, loadFixtures } from './testkit.ts'

const fixtures = await loadFixtures()

async function run(id: ResearchBackendId, q = 'rate limiting', lang?: string) {
  const web = fakeWeb(backendRoutes(fixtures))
  const hits = await searchBackend(id, q, { http: web.http, limit: 5, ...(lang === undefined ? {} : { lang }) })
  return { hits, requests: web.requests }
}

describe('the backends', () => {
  test('declare their origins, the allowlist entry of purpose research', () => {
    expect(BACKEND_IDS).toHaveLength(12)
    expect(RESEARCH_ORIGINS).toContain('https://en.wikipedia.org')
    expect(RESEARCH_ORIGINS).toContain('https://zh.wikipedia.org')
    expect(RESEARCH_ORIGINS).toEqual([...RESEARCH_ORIGINS].sort())
    for (const o of RESEARCH_ORIGINS) expect(new URL(o).origin).toBe(o)
    expect(BACKENDS.filter((b) => b.byDefault).map((b) => b.id)).toEqual([
      'wikipedia',
      'marginalia',
      'mojeek',
      'hackernews',
      'stackexchange',
      'openalex',
    ])
    // None of the unreachable ones is offered.
    for (const u of UNREACHABLE_BACKENDS) expect(BACKEND_IDS as readonly string[]).not.toContain(u.id)
  })

  test('every request is a plain GET, with no header, to an origin of its backend', async () => {
    for (const id of BACKEND_IDS) {
      const { requests } = await run(id, id === 'ietf' ? 'OAuth protocol' : 'rate limiting')
      expect(requests.length).toBeGreaterThan(0)
      const origins = BACKENDS.find((b) => b.id === id)?.origins ?? []
      for (const r of requests) {
        expect(origins).toContain(new URL(r.url).origin)
        expect(r.init?.method).toBe('GET')
        expect(r.init?.headers).toBeUndefined()
        expect(r.init?.body).toBeUndefined()
      }
    }
  })

  test('Wikipedia: article URLs in the language asked, description and excerpt as the snippet', async () => {
    const { hits, requests } = await run('wikipedia', 'rate limiting', 'fr-CA')
    expect(new URL(requests[0]?.url ?? '').host).toBe('fr.wikipedia.org')
    expect(hits[0]).toMatchObject({ url: 'https://fr.wikipedia.org/wiki/Rate_limiting', title: 'Rate limiting' })
    expect(hits[0]?.snippet).toContain('Limiting the data rate')
    expect(hits[0]?.snippet).not.toContain('<span')
    expect(wikipediaLang('xx')).toBe('en')
    expect(wikipediaLang(undefined)).toBe('en')
    expect(wikipediaLang('JA')).toBe('ja')
  })

  test('Marginalia, Hacker News, Stack Exchange and GitHub', async () => {
    const m = await run('marginalia')
    expect(m.hits[0]).toMatchObject({ url: 'https://en.wikipedia.org/wiki/Token_bucket', title: 'Token bucket' })
    expect(m.requests[0]?.url).toStartWith('https://api.marginalia-search.com/public/search/rate%20limiting?count=5')
    const hn = await run('hackernews')
    expect(hn.hits[0]).toMatchObject({ url: 'https://smudge.ai/blog/ratelimit-algorithms', backend: 'hackernews' })
    expect(hn.hits[0]?.snippet).toMatch(/points, \d+ comments on Hacker News/)
    expect(hn.hits[0]?.date).toBe('2024-05-16T23:07:20Z')
    const se = await run('stackexchange')
    expect(se.requests.map((r) => new URL(r.url).searchParams.get('site'))).toEqual([
      'stackoverflow',
      'serverfault',
      'superuser',
    ])
    expect(se.hits[0]?.url).toStartWith('https://stackoverflow.com/questions/667508/')
    expect(se.hits[0]?.title).toBe("What's a good rate limiting algorithm?")
    expect(se.hits.length).toBeLessThanOrEqual(5)
    const gh = await run('github')
    expect(gh.hits[0]?.url).toBe('https://github.com/NewcastleRSE/etips/issues/6')
  })

  test('the scholarly and biomedical databases cite the page, never the API', async () => {
    const oa = await run('openalex')
    expect(oa.hits[0]?.url).toBe('https://doi.org/10.1016/s0021-9258(17)37738-4')
    expect(oa.hits[0]?.snippet.split(' ').slice(0, 3).join(' ')).toBe('A method is')
    const cr = await run('crossref')
    expect(cr.hits[0]).toMatchObject({ url: 'https://doi.org/10.1515/iupac.68.0150', date: '2016' })
    const ep = await run('europepmc', 'aspirin')
    expect(ep.hits[0]?.url).toBe('https://europepmc.org/article/MED/42853985')
    const pm = await run('pubmed', 'aspirin')
    expect(pm.requests.map((r) => new URL(r.url).pathname.split('/').pop())).toEqual(['esearch.fcgi', 'esummary.fcgi'])
    expect(pm.hits[0]?.url).toMatch(/^https:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/\d+\/$/)
    expect(pm.hits[0]?.snippet).toContain('International journal of sports medicine')
    const ct = await run('clinicaltrials', 'aspirin')
    expect(ct.hits[0]).toMatchObject({ url: 'https://clinicaltrials.gov/study/NCT00311402' })
    expect(ct.hits[0]?.snippet).toStartWith('COMPLETED')
  })

  test('IETF: an RFC number is looked up by name, other queries by two title words; the page is rfc-editor', async () => {
    const byWords = await run('ietf', 'how does the OAuth protocol sign requests')
    expect(new URL(byWords.requests[0]?.url ?? '').searchParams.get('title__icontains')).toBe('oauth protocol')
    expect(byWords.hits[0]).toMatchObject({ url: 'https://www.rfc-editor.org/rfc/rfc5849' })
    expect(byWords.hits[0]?.title).toBe('RFC 5849: The OAuth 1.0 Protocol')
    const byNumber = await run('ietf', 'What does RFC 5849 say?')
    expect(new URL(byNumber.requests[0]?.url ?? '').searchParams.get('name')).toBe('rfc5849')
  })

  test('Mojeek: results from its HTML, and its captcha page is a wall', async () => {
    expect(parseMojeek(fixtures['mojeek.html'], 2).map((h) => h.url)).toEqual([
      'https://en.wikipedia.org/wiki/Rate_limiting',
      'https://stripe.com/blog/rate-limiters',
    ])
    const web = fakeWeb({ 'https://www.mojeek.com/': { body: fixtures['mojeek-captcha.html'], type: 'text/html' } })
    const error = await searchBackend('mojeek', 'x', { http: web.http, limit: 3 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(BackendError)
    expect((error as BackendError).reason).toBe('wall')
  })

  test('failures are typed: rate limits, HTTP errors, refusals, malformed answers; an abort is an AbortError', async () => {
    const reason = async (route: Parameters<typeof fakeWeb>[0]) => {
      const web = fakeWeb(route)
      const e = await searchBackend('openalex', 'x', { http: web.http, limit: 3 }).catch((x: unknown) => x)
      return e instanceof BackendError ? e.reason : String(e)
    }
    expect(await reason({ 'https://api.openalex.org/': { status: 429, body: '' } })).toBe('rate-limited')
    expect(await reason({ 'https://api.openalex.org/': { status: 500, body: '' } })).toBe('http')
    expect(await reason({ 'https://api.openalex.org/': { body: '', refuse: true } })).toBe('unreachable')
    expect(await reason({ 'https://api.openalex.org/': { body: '<html>' } })).toBe('malformed')
    const controller = new AbortController()
    controller.abort()
    const web = fakeWeb(backendRoutes(fixtures))
    const e = await searchBackend('openalex', 'x', { http: web.http, limit: 3, signal: controller.signal }).catch(
      (x: unknown) => x,
    )
    expect((e as Error).name).toBe('AbortError')
    expect(web.requests).toEqual([])
  })

  test('an empty query asks nothing; an OpenAlex abstract is put back in order', async () => {
    const web = fakeWeb(backendRoutes(fixtures))
    expect(await searchBackend('wikipedia', '   ', { http: web.http, limit: 3 })).toEqual([])
    expect(web.requests).toEqual([])
    expect(invertedAbstract({ world: [1], hello: [0], again: [2, 9_999_999] })).toBe('hello world again')
  })
})
