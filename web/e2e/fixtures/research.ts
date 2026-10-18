import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { BrowserContext, Route } from '@playwright/test'
import type { Gates } from '../gates.ts'

/*
 * The world of a Deep research spec, played by the test: every search backend of spec/network-allowlist.json purpose
 * `research` (with the CORS answer a browser needs; a backend the spec does not script answers an empty result), and
 * the pages a search finds, on an origin the gate admits for the test only, since the pages a conversation reads are
 * never fixed hosts. No spec reaches a real search service. Every request is recorded, and a page can be held until
 * the spec releases it, to watch the progress of a run while it reads.
 */

const allowlist = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../spec/network-allowlist.json', import.meta.url)), 'utf8'),
) as { research: string[] }

export const PAGES = 'https://pages.example'

const CORS = { 'access-control-allow-origin': '*' }

export interface WikiArticle {
  readonly key: string
  readonly title: string
  readonly description: string
  readonly extract: string
}

export interface FoundPage {
  readonly path: string
  readonly title: string
  readonly snippet: string
  readonly html: string
}

export class ResearchWorld {
  readonly requests: string[] = []
  readonly problems: string[] = []
  private readonly held = new Map<string, { release: () => void; promise: Promise<void> }>()

  constructor(
    readonly articles: readonly WikiArticle[],
    /** Found by Marginalia, served on PAGES. */
    readonly pages: readonly FoundPage[],
  ) {}

  static async install(context: BrowserContext, gates: Gates, world: ResearchWorld): Promise<ResearchWorld> {
    gates.userEndpoint(PAGES)
    for (const origin of allowlist.research) await context.route(`${origin}/**`, (route) => world.handle(route))
    await context.route(`${PAGES}/**`, (route) => world.handle(route))
    return world
  }

  /** Holds the page at `path` until `release()` is called. */
  hold(path: string): () => void {
    let release: () => void = () => undefined
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    this.held.set(path, { release, promise })
    return release
  }

  pageUrl(path: string): string {
    return `${PAGES}${path}`
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request()
    const url = new URL(request.url())
    const headers = await request.allHeaders()
    if (request.method() === 'OPTIONS') {
      this.problems.push(`A preflight was needed for ${url.href}`)
      await route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-methods': 'GET' } })
      return
    }
    this.requests.push(url.href)
    if (headers.cookie !== undefined) this.problems.push(`Cookie sent to ${url.href}`)
    if (headers.authorization !== undefined) this.problems.push(`Authorization sent to ${url.href}`)
    const json = (body: unknown) =>
      route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    if (url.origin === PAGES) {
      const page = this.pages.find((p) => p.path === url.pathname)
      await this.held.get(url.pathname)?.promise
      if (page === undefined) return route.fulfill({ status: 404, headers: CORS, body: 'not found' })
      return route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'text/html; charset=utf-8' },
        body: page.html,
      })
    }
    if (url.hostname.endsWith('.wikipedia.org')) {
      if (url.pathname === '/w/rest.php/v1/search/page')
        return json({
          pages: this.articles.map((a, i) => ({
            id: i + 1,
            key: a.key,
            title: a.title,
            excerpt: a.description,
            description: a.description,
          })),
        })
      if (url.pathname === '/w/api.php') {
        const wanted = (url.searchParams.get('titles') ?? '').replace(/ /g, '_')
        const article = this.articles.find((a) => a.key === wanted)
        return json({
          batchcomplete: true,
          query: {
            pages:
              article === undefined
                ? [{ title: wanted, missing: true }]
                : [{ title: article.title, extract: article.extract }],
          },
        })
      }
    }
    if (url.origin === 'https://api.marginalia-search.com')
      return json({
        query: url.pathname,
        results: this.pages.map((p) => ({
          url: this.pageUrl(p.path),
          title: p.title,
          description: p.snippet,
          format: 'html',
        })),
      })
    if (url.origin === 'https://www.mojeek.com')
      return route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'text/html' },
        body: '<!doctype html><title>Mojeek</title><ul class="results-standard"></ul>',
      })
    if (url.origin === 'https://hn.algolia.com') return json({ hits: [] })
    if (url.origin === 'https://api.stackexchange.com') return json({ items: [], quota_remaining: 290 })
    if (url.origin === 'https://api.openalex.org') return json({ results: [] })
    if (url.origin === 'https://api.crossref.org') return json({ message: { items: [] } })
    if (url.origin === 'https://api.github.com') return json({ items: [] })
    return json({})
  }
}
