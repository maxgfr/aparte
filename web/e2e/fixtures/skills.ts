import { createHash } from 'node:crypto'
import type { BrowserContext, Page, Route } from '@playwright/test'
import { shell } from '../../src/i18n/en/shell.ts'
import { skills } from '../../src/i18n/en/skills.ts'
import { expect } from '../gates.ts'

/*
 * A public GitHub repository of skills as the skill specs play it: the REST API calls an import makes (the
 * repository, the commit a ref points to, the recursive tree) and the raw files at that commit, answered from an
 * in-memory tree with the CORS headers GitHub sends. No spec reaches the real GitHub. Every request is recorded and
 * checked: an import is unauthenticated, so no Authorization header and no cookie may ever be sent.
 */

export const API = 'https://api.github.com'
export const RAW = 'https://raw.githubusercontent.com'

const CORS = { 'access-control-allow-origin': '*' }

export class SkillRepoMock {
  readonly requests: string[] = []
  readonly problems: string[] = []
  readonly commit: string

  constructor(
    readonly owner: string,
    readonly repo: string,
    /** Files by path from the repository's root. */
    readonly files: Readonly<Record<string, string>>,
    readonly branch = 'main',
  ) {
    this.commit = createHash('sha1').update(JSON.stringify(files)).digest('hex')
  }

  async install(context: BrowserContext): Promise<void> {
    await context.route(`${API}/**`, (route) => this.handle(route))
    await context.route(`${RAW}/**`, (route) => this.handle(route))
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request()
    const url = new URL(request.url())
    const headers = await request.allHeaders()
    this.requests.push(`${request.method()} ${url.href}`)
    if (headers.authorization !== undefined) this.problems.push(`Authorization sent to ${url.href}`)
    if (headers.cookie !== undefined) this.problems.push(`Cookie sent to ${url.href}`)
    if (request.method() !== 'GET') {
      this.problems.push(`${request.method()} ${url.href}`)
      await route.fulfill({ status: 405, headers: CORS, body: '' })
      return
    }
    const base = `/repos/${this.owner}/${this.repo}`
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (url.origin === API && url.pathname === base)
      return json({ full_name: `${this.owner}/${this.repo}`, default_branch: this.branch, private: false })
    if (url.origin === API && url.pathname === `${base}/commits/${this.branch}`)
      return json({ sha: this.commit, commit: { tree: { sha: this.commit } } })
    if (url.origin === API && url.pathname === `${base}/git/trees/${this.commit}`) {
      const dirs = new Set<string>()
      for (const path of Object.keys(this.files)) {
        const segments = path.split('/')
        for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join('/'))
      }
      return json({
        sha: this.commit,
        truncated: false,
        tree: [
          ...[...dirs].map((path) => ({ path, mode: '040000', type: 'tree', sha: this.commit })),
          ...Object.entries(this.files).map(([path, text]) => ({
            path,
            mode: '100644',
            type: 'blob',
            sha: createHash('sha1').update(text).digest('hex'),
            size: Buffer.byteLength(text),
          })),
        ],
      })
    }
    const rawPrefix = `/${this.owner}/${this.repo}/${this.commit}/`
    if (url.origin === RAW && url.pathname.startsWith(rawPrefix)) {
      const path = decodeURIComponent(url.pathname.slice(rawPrefix.length))
      const text = this.files[path]
      if (text !== undefined)
        return route.fulfill({
          status: 200,
          headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' },
          body: text,
        })
    }
    return json({ message: 'Not Found' }, 404)
  }
}

/** Opens the Skills screen from the More tab. */
export async function openSkills(page: Page): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name: shell.navMore, exact: true }).first().click()
  await page.getByRole('link', { name: new RegExp(`^${skills.navSkills}`) }).click()
  await expect(page.getByRole('heading', { level: 1, name: skills.title })).toBeVisible()
}

/** Imports `source` from GitHub on the Skills screen and waits for the outcome. */
export async function importFromGitHub(page: Page, source: string): Promise<void> {
  await page.getByLabel(skills.githubLabel, { exact: true }).fill(source)
  await page.getByRole('button', { name: skills.githubImport, exact: true }).click()
  await expect(page.locator('[data-skill-import]')).toBeVisible({ timeout: 20_000 })
}

/** The card of an installed skill. */
export const skillCard = (page: Page, name: string) => page.locator(`[data-skill="${name}"]`)
