import type { BrowserContext, Locator, Page, Request, Route } from '@playwright/test'
import { FakeMcpServer, ISSUER, SERVER_ORIGIN, SERVER_URL } from '../../src/core/mcp/testkit.ts'
import { chat } from '../../src/i18n/en/chat.ts'
import { mcp } from '../../src/i18n/en/mcp.ts'
import { expect, type Gates } from '../gates.ts'
import { ANSWER_WAIT } from './chat-ui.ts'

/*
 * An MCP server and its OAuth authorization server, played by the test: the in-memory server of the unit specs
 * (web/src/core/mcp/testkit.ts) behind Playwright routes, with the CORS answers a server reachable from a browser
 * gives. Both hosts are endpoints the user typed, so the network gate admits them for the test only.
 *
 * Every request is recorded and checked: no AI SDK user-agent and no header a real server's CORS preflight would
 * have to allow beyond MCP's own. The authorization endpoint plays the user approving in the popup: it sends the
 * popup back to the app's `oauth-callback.html` with a code bound to the request (PKCE challenge, redirect URI).
 */

export { ISSUER, SERVER_ORIGIN, SERVER_URL }

const BROWSER_HEADERS = new Set([
  'accept-encoding',
  'accept-language',
  'cache-control',
  'connection',
  'content-length',
  'dnt',
  'host',
  'origin',
  'pragma',
  'priority',
  'referer',
  'te',
  'user-agent',
  'upgrade-insecure-requests',
])
const ALLOWED_HEADERS = new Set([
  'accept',
  'authorization',
  'content-type',
  'mcp-protocol-version',
  'mcp-session-id',
  'last-event-id',
])

export interface McpCall {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

export class McpMock {
  readonly server = new FakeMcpServer()
  readonly requests: McpCall[] = []
  private readonly found: string[] = []

  /** Routes both hosts of `context` to this mock and admits them through the gate. Install it after the gates. */
  static async install(context: BrowserContext, gates: Gates): Promise<McpMock> {
    const mock = new McpMock()
    gates.userEndpoint(SERVER_ORIGIN)
    gates.userEndpoint(ISSUER)
    await context.route(`${SERVER_ORIGIN}/**`, (route) => mock.handle(route))
    await context.route(`${ISSUER}/**`, (route) => mock.handle(route))
    return mock
  }

  problems(): string[] {
    return [...this.found]
  }

  private async handle(route: Route): Promise<void> {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const headers = await request.allHeaders()
    const cors = {
      'access-control-allow-origin': headers.origin ?? '*',
      'access-control-expose-headers': 'mcp-session-id, www-authenticate',
      vary: 'origin',
    }
    if (method === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          ...cors,
          'access-control-allow-methods': 'GET, POST, DELETE',
          'access-control-allow-headers': [...ALLOWED_HEADERS].join(', '),
          'access-control-max-age': '600',
        },
      })
      return
    }
    this.record(request, url, method, headers)
    // The user approves in the popup: back to the app with a code and the state.
    if (url.origin === ISSUER && url.pathname === '/authorize') {
      const { code, state } = this.server.authorize(url.href)
      const back = new URL(url.searchParams.get('redirect_uri') ?? '')
      back.search = new URLSearchParams({ code, state, iss: ISSUER }).toString()
      // A redirect cannot be fulfilled in every engine: the page sends the popup on, as an approval page would.
      const target = back.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><meta http-equiv="refresh" content="0;url=${target}"><title>Approve</title>`,
      })
      return
    }
    // Streamable HTTP's optional stream of server messages: an empty one, so no request ever fails.
    if (url.href === SERVER_URL && method === 'GET') {
      await route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: '' })
      return
    }
    const response = await this.server.request(url.href, {
      method,
      headers,
      ...(request.postData() === null ? {} : { body: request.postData() as string }),
      purpose: 'mcp',
    })
    const out: Record<string, string> = { ...cors }
    response.headers.forEach((value, name) => {
      out[name] = value
    })
    await route.fulfill({ status: response.status, headers: out, body: Buffer.from(await response.arrayBuffer()) })
  }

  private record(request: Request, url: URL, method: string, headers: Record<string, string>): void {
    this.requests.push({ url: url.href, method, headers, body: request.postData() ?? '' })
    if (request.isNavigationRequest()) return
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase()
      if (BROWSER_HEADERS.has(lower) || lower.startsWith('sec-') || lower.startsWith(':')) continue
      if (!ALLOWED_HEADERS.has(lower)) this.found.push(`Header ${lower} sent to ${method} ${url.href}`)
    }
    if (/ai-sdk/i.test(headers['user-agent'] ?? '')) this.found.push(`AI SDK user-agent sent to ${url.href}`)
  }
}

// The MCP screens, as a user drives them (web/src/i18n/en/mcp.ts).

/** Opens the MCP servers screen from the Models tab. */
export async function openMcp(page: Page): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name: chat.navProviders, exact: true }).first().click()
  await page.getByRole('link', { name: new RegExp(`^${mcp.entry}`) }).click()
  await expect(page.getByRole('heading', { level: 1, name: mcp.title })).toBeVisible()
}

export type AuthLabel = typeof mcp.authNone | typeof mcp.authOauth | typeof mcp.authBearer | typeof mcp.authHeaders

/** Adds the mock server and waits for its screen. */
export async function addServer(page: Page, name: string, auth: AuthLabel = mcp.authNone): Promise<void> {
  await openMcp(page)
  await page.getByRole('link', { name: new RegExp(`^${mcp.add}`) }).click()
  await page.getByLabel(mcp.url, { exact: true }).fill(SERVER_URL)
  await page.getByLabel(mcp.name, { exact: true }).fill(name)
  await page.getByRole('radio', { name: auth, exact: true }).check()
  await page.getByRole('button', { name: mcp.create, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible()
}

/** The status line of the server screen. */
export const serverStatus = (page: Page): Locator => page.locator('[data-mcp-status]')

export async function connected(page: Page): Promise<void> {
  await expect(serverStatus(page)).toHaveAttribute('data-mcp-status', 'connected', ANSWER_WAIT)
}

/** The row of tool `name` (its MCP name) on the server screen. */
export const toolRow = (page: Page, name: string): Locator => page.locator(`[data-mcp-tool="${name}"]`)
