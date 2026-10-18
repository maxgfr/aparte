import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { chat } from '../src/i18n/en/chat.ts'
import { answers, content, createVault, navigate, newChat, send, settled } from './fixtures/chat-ui.ts'
import { CUSTOM_BASE_URL } from './fixtures/providers.ts'
import { openAIChunks } from './fixtures/sse.ts'
import { admitCustomEndpoint, expect, test } from './fixtures/test.ts'
import { accessible } from './gates.ts'

/*
 * Every provider of the llm-models catalog (web/src/core/ai/catalog-all.json), on every project: the Models screen
 * setting adds the providers a browser cannot call directly, each with its badge; one behind a proxy explains why and
 * takes the address of the user's proxy, after which the chat goes there; one no adapter speaks to is listed for its
 * models only. The proxy is the loopback endpoint the provider mock plays.
 */

test.use({ netPurposes: ['provider'] })

interface Entry {
  readonly id: string
  readonly name: string
  readonly api?: string
  readonly models: readonly { readonly id: string; readonly name: string; readonly released?: string }[]
}

const all = JSON.parse(readFileSync(new URL('../src/core/ai/catalog-all.json', import.meta.url), 'utf8')) as {
  providers: Entry[]
  foreign: Entry[]
}
/** A provider that refused the CORS preflight, called through the OpenAI-compatible adapter. */
const PROXIED = all.providers.find((p) => p.id === 'nvidia') as Entry
/** A provider of a protocol no adapter speaks. */
const FOREIGN = all.foreign.find((p) => p.id === 'azure') as Entry
/** The model a new provider offers first: the newest, as the provider screen orders them. */
const MODEL = [...PROXIED.models].sort(
  (a, b) => (b.released ?? '').localeCompare(a.released ?? '') || a.name.localeCompare(b.name),
)[0] as Entry['models'][number]
const KEY = 'e2e-proxy-key'

const row = (page: Page, name: string) =>
  page.getByRole('link', { name: new RegExp(`^${name.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')}(?:\\s|$)`) })

test('the setting lists every provider; one behind a proxy chats through the base URL the user gives', async ({
  page,
  providers,
  gates,
}) => {
  test.setTimeout(180_000)
  expect(PROXIED?.api).toBe('https://integrate.api.nvidia.com/v1')
  admitCustomEndpoint(gates)
  providers.expectKey('openai-compatible', KEY)
  await createVault(page)
  await navigate(page, chat.navProviders)
  await expect(page.getByRole('heading', { level: 1, name: chat.providersTitle })).toBeVisible()
  const search = page.getByRole('searchbox', { name: chat.providerSearch })
  const toggle = page.getByRole('switch', { name: chat.providerAll })

  // Off: only the providers a browser calls directly.
  await expect(toggle).not.toBeChecked()
  await search.fill(PROXIED.name)
  await expect(page.getByText(chat.providerSearchNone)).toBeVisible()
  await expect(row(page, PROXIED.name)).toHaveCount(0)

  // On: the provider behind a proxy and the foreign one show, each with its badge.
  await toggle.check()
  await expect(row(page, PROXIED.name)).toContainText(chat.providerBadgeProxy)
  await expect(page.getByText(chat.providerAllLegend)).toBeVisible()
  await search.fill(FOREIGN.name)
  await expect(row(page, FOREIGN.name).first()).toContainText(chat.providerBadgeNone)
  await search.fill('')
  await expect(row(page, PROXIED.name)).toBeVisible()
  await accessible(page, 'every provider')

  // Off again: gone.
  await toggle.uncheck()
  await search.fill(PROXIED.name)
  await expect(row(page, PROXIED.name)).toHaveCount(0)
  await toggle.check()

  // The foreign provider says why it cannot be called, and offers nothing to add.
  await search.fill(FOREIGN.name)
  await row(page, FOREIGN.name).first().click()
  await expect(page.getByRole('heading', { level: 1, name: FOREIGN.name })).toBeVisible()
  await expect(page.getByText(chat.providerForeignExplain.replace('{name}', FOREIGN.name))).toBeVisible()
  await expect(page.getByRole('heading', { name: chat.providerCatalogModels })).toBeVisible()
  await expect(page.getByRole('button', { name: chat.providerCreate })).toHaveCount(0)
  await page.goBack()

  // The provider behind a proxy: the badge, why, and its own address to start from.
  await search.fill(PROXIED.name)
  await row(page, PROXIED.name).click()
  await expect(page.getByRole('heading', { level: 1, name: PROXIED.name })).toBeVisible()
  await expect(page.getByText(chat.providerProxyExplain.replace('{name}', PROXIED.name))).toBeVisible()
  const baseUrl = page.getByLabel(chat.providerBaseUrl, { exact: true })
  await expect(baseUrl).toHaveValue(PROXIED.api as string)
  await page.getByLabel(chat.providerKey, { exact: true }).fill(KEY)
  await page.getByRole('button', { name: chat.providerCreate, exact: true }).click()

  // Created at its own address, it warns that a browser cannot reach it; the address of a proxy clears that.
  const still = page.getByText(chat.providerProxyStill.replace('{name}', PROXIED.name))
  await expect(still).toBeVisible()
  await baseUrl.fill('http://192.168.1.2:4000/v1')
  await expect(page.getByText(chat.providerBaseUrlInsecure)).toBeVisible()
  await baseUrl.fill(CUSTOM_BASE_URL)
  await page.getByRole('button', { name: chat.save, exact: true }).click()
  await expect(still).toHaveCount(0)
  await accessible(page, 'provider behind a proxy')

  // The chat goes to the proxy, with the provider's model id.
  await newChat(page, MODEL.id)
  providers.serve('openai-compatible', { chunks: openAIChunks(['Through ', 'the proxy.'], MODEL.id) })
  await send(page, 'Hello through the proxy')
  await expect(content(await settled(page))).toHaveText('Through the proxy.')
  const [call] = providers.generations('openai-compatible')
  expect(call?.url).toBe(`${CUSTOM_BASE_URL}/chat/completions`)
  expect(call?.body).toMatchObject({ model: MODEL.id, stream: true })
  await expect(answers(page)).toHaveCount(1)
})
