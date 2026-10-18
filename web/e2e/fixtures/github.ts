import type { BrowserContext, Route } from '@playwright/test'
import { type FakeGitHub, fakeGitHub } from '../../src/core/sync/providers/githubFake.ts'

/*
 * GitHub as the sync specs play it: every request a page makes to api.github.com is answered by the in-memory GitHub
 * of web/src/core/sync/providers/githubFake.ts, shared by every browser context of the test (the devices), so no
 * spec ever reaches the real service. The mock also checks the request rules: the token travels only in the
 * Authorization header, and no request carries a cookie.
 */

export const GITHUB_ORIGIN = 'https://api.github.com'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers':
    'retry-after, x-ratelimit-remaining, x-ratelimit-reset, github-authentication-token-expiration',
}

export class GitHubMock {
  readonly fake: FakeGitHub
  readonly problems: string[] = []
  readonly requests: { readonly method: string; readonly url: string }[] = []

  constructor(
    readonly owner: string,
    readonly repo: string,
    readonly token: string,
  ) {
    // A repository created with a README, as the setup guide says: an empty one answers 409 to its first reads,
    // which the browser logs as a console error (the empty case is covered by the unit tests).
    this.fake = fakeGitHub({ owner, repo, token, initialized: true })
  }

  /** Routes `context`'s requests to api.github.com to this mock. Call it after the gates are installed. */
  async install(context: BrowserContext): Promise<void> {
    await context.route(`${GITHUB_ORIGIN}/**`, (route) => this.handle(route))
  }

  /** The stored objects as bytes, by path in the repository (each file holds the base64 of one object). */
  objects(): Map<string, Buffer> {
    return new Map([...this.fake.files()].map(([path, text]) => [path, Buffer.from(text, 'base64')]))
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request()
    const method = request.method()
    if (method === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          ...CORS,
          'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE',
          'access-control-allow-headers': 'authorization, accept, content-type, x-github-api-version',
          'access-control-max-age': '600',
        },
      })
      return
    }
    const headers = await request.allHeaders()
    const body = request.postData()
    const url = request.url()
    this.requests.push({ method, url })
    if (url.includes(this.token) || body?.includes(this.token)) this.problems.push(`Token outside its header: ${url}`)
    if (headers.cookie) this.problems.push(`Cookie sent to GitHub: ${url}`)
    if (headers.authorization !== `Bearer ${this.token}`) this.problems.push(`Request without the token: ${url}`)
    const res = await this.fake.handle(url, { method, headers, body })
    const out: Record<string, string> = { ...CORS }
    res.headers.forEach((value, key) => {
      out[key] = value
    })
    await route.fulfill({ status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) })
  }
}
