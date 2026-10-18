import type { BrowserContext, Locator, Page, Request } from '@playwright/test'
import {
  addProvider,
  answers,
  content,
  createVault,
  navigate,
  newChat,
  send,
  setEffort,
} from '../e2e/fixtures/chat-ui.ts'
import { dumpStorage, plaintextHits } from '../e2e/fixtures/storage.ts'
import { expect, test } from '../e2e/gates.ts'
import { chat } from '../src/i18n/en/chat.ts'

/*
 * The live suite: the production build talking to real model servers, under the same gates as e2e/ (no CSP or
 * Trusted Types violation, no request outside the allowlist for the declared purposes, no console error). Run it with
 * `bun run test:live` (playwright.live.config.ts); each test runs only when what it needs is there:
 *
 *   ANTHROPIC_API_KEY                  a key for Anthropic's API; APARTE_LIVE_ANTHROPIC_MODEL picks the model
 *                                      (default claude-haiku-5-5), asked at the low effort for one short word;
 *   Ollama on http://localhost:11434   with the model APARTE_LIVE_OLLAMA_MODEL (default qwen2.5:7b) pulled.
 *
 * The key never leaves this process in a report: failures name where a key was found, never its value.
 */

const LIVE = process.env.APARTE_LIVE === '1'
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? ''
const ANTHROPIC_MODEL = process.env.APARTE_LIVE_ANTHROPIC_MODEL ?? 'claude-haiku-5-5'
const ANTHROPIC_HOST = 'api.anthropic.com'
const OLLAMA = 'http://localhost:11434'
const OLLAMA_MODEL = process.env.APARTE_LIVE_OLLAMA_MODEL ?? 'qwen2.5:7b'
const PROMPT = 'Reply with the single word: pong'
/** A real model answers within this, a cold local model included. */
const LIVE_ANSWER = { timeout: 120_000 }

test.skip(!LIVE, 'the live suite runs only through `bun run test:live` (APARTE_LIVE=1)')

/**
 * Watches every request of `context` for `secret` and returns where it was found, as `<method> <origin>: <place>`
 * without the value. The only place it may be is the `x-api-key` header of a request to `allowedHost`.
 */
function watchSecret(context: BrowserContext, secret: string, allowedHost: string): () => Promise<string[]> {
  const pending: Promise<string[]>[] = []
  const inspect = async (request: Request): Promise<string[]> => {
    const url = new URL(request.url())
    const where = `${request.method()} ${url.origin}`
    const found: string[] = []
    if (request.url().includes(secret)) found.push(`${where}: the URL`)
    if ((request.postData() ?? '').includes(secret)) found.push(`${where}: the body`)
    for (const [name, value] of Object.entries(await request.allHeaders())) {
      if (!value.includes(secret)) continue
      if (name.toLowerCase() === 'x-api-key' && url.hostname === allowedHost && url.protocol === 'https:') continue
      found.push(`${where}: the ${name} header`)
    }
    return found
  }
  context.on('request', (request) => {
    pending.push(inspect(request).catch(() => [`${request.method()} ${new URL(request.url()).origin}: unreadable`]))
  })
  return async () => (await Promise.all(pending)).flat()
}

/** Waits for the latest answer to finish, however long a real model takes, and returns it. */
async function answered(page: Page): Promise<Locator> {
  const last = answers(page).last()
  await expect(last).toHaveAttribute('data-status', 'done', LIVE_ANSWER)
  return last
}

test.describe('Anthropic', () => {
  test.use({ netPurposes: ['provider'] })
  test.skip(ANTHROPIC_KEY === '', 'needs ANTHROPIC_API_KEY')

  test('a streamed answer, with the key only in its own header and never stored in plaintext', async ({
    page,
    context,
    gates,
  }) => {
    test.setTimeout(300_000)
    const leaks = watchSecret(context, ANTHROPIC_KEY, ANTHROPIC_HOST)
    await createVault(page)
    await addProvider(page, null, { kind: 'anthropic', key: ANTHROPIC_KEY, model: ANTHROPIC_MODEL })
    await newChat(page, ANTHROPIC_MODEL)
    await setEffort(page, 'low')
    await send(page, PROMPT)
    const answer = await answered(page)
    await expect(content(answer)).toContainText(/pong/i)

    expect(await leaks(), 'places the API key was sent other than its own header').toEqual([])
    const stored = plaintextHits(await dumpStorage(page), [ANTHROPIC_KEY])
    expect(stored.length, 'places the API key is stored in plaintext').toBe(0)
    const app = new URL(page.url()).origin
    const contacted = [...gates.contacted.keys()].filter((origin) => origin !== app)
    expect(contacted, 'origins contacted besides the app').toEqual([`https://${ANTHROPIC_HOST}`])
  })
})

test.describe('Ollama', () => {
  test('a streamed answer from the model server on this computer', async ({ page, gates, request }) => {
    test.setTimeout(300_000)
    const tags = await request.get(`${OLLAMA}/api/tags`, { timeout: 5_000 }).catch(() => null)
    test.skip(tags === null || !tags.ok(), `needs Ollama answering at ${OLLAMA}`)
    const listed = ((await tags?.json()) as { models?: { name?: string }[] } | undefined)?.models ?? []
    test.skip(!listed.some((m) => m.name === OLLAMA_MODEL), `needs ${OLLAMA_MODEL} pulled in Ollama`)

    gates.userEndpoint(OLLAMA)
    await createVault(page)
    await navigate(page, chat.navProviders)
    await expect(page.getByRole('heading', { level: 1, name: chat.providersTitle })).toBeVisible()
    await page.getByRole('link', { name: /^Ollama/ }).click()
    await page.getByRole('button', { name: chat.providerCreate, exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Ollama' })).toBeVisible()
    await page.getByRole('button', { name: chat.providerModelsRefresh, exact: true }).click()
    await expect(page.getByText(OLLAMA_MODEL, { exact: true }).first()).toBeVisible(LIVE_ANSWER)

    await newChat(page, OLLAMA_MODEL)
    await send(page, PROMPT)
    const answer = await answered(page)
    await expect(content(answer)).toContainText(/pong/i)
    const app = new URL(page.url()).origin
    const contacted = [...gates.contacted.keys()].filter((origin) => origin !== app)
    expect(contacted, 'origins contacted besides the app').toEqual([OLLAMA])
  })
})
