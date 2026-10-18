import type { Page } from '@playwright/test'
import { chat } from '../src/i18n/en/chat.ts'
import { local } from '../src/i18n/en/local.ts'
import { ANSWER_WAIT, content, createVault, newChat, reasoningOf, send, settled } from './fixtures/chat-ui.ts'
import { LOCAL_ANSWER, LOCAL_REASONING, PROMPT_ANSWER, playPromptApi, playWebllm } from './fixtures/local.ts'
import { openAIChunks } from './fixtures/sse.ts'
import { accessible, expect, test } from './gates.ts'

/*
 * Models that run on this device, on every project: an in-browser model downloaded, used in a chat and deleted (WebLLM
 * played at its worker boundary, WebGPU faked), Chrome's built-in model (the Prompt API faked), and Ollama on this
 * computer (a routed fake server): its diagnosis, its model list and a streamed answer. No test declares a network
 * purpose: nothing but the app's own origin and the loopback server may be contacted.
 */

// Requests of a page its service worker controls cannot be routed in WebKit and Firefox (see fixtures/test.ts).
test.use({ serviceWorkers: 'block' })

const SMOL = 'SmolLM2-360M-Instruct-q4f16_1-MLC'
const SMOL_NAME = 'SmolLM2 360M (q4f16)'

const fill = (template: string, values: Record<string, string>) =>
  Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, v), template)

async function openModels(page: Page): Promise<void> {
  await page
    .getByRole('navigation')
    .or(page.getByRole('banner'))
    .getByRole('link', { name: chat.navProviders, exact: true })
    .or(
      page
        .getByRole('navigation')
        .or(page.getByRole('banner'))
        .getByRole('button', { name: chat.navProviders, exact: true }),
    )
    .first()
    .click()
  await expect(page.getByRole('heading', { level: 1, name: chat.providersTitle })).toBeVisible()
}

async function addDeviceProvider(page: Page, title: string): Promise<void> {
  await openModels(page)
  await page.getByRole('link', { name: new RegExp(`^${title}`) }).click()
  await page.getByRole('button', { name: chat.providerCreate, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible()
}

test('an in-browser model: device check, download with progress, chat on the device, delete', async ({
  page,
  context,
}) => {
  test.setTimeout(180_000)
  await playWebllm(context)
  await createVault(page)
  await addDeviceProvider(page, local.webllmTitle)

  await expect(page.getByText(/^WebGPU is available\./)).toBeVisible()
  const row = page.locator(`[data-model="${SMOL}"]`)
  await expect(row.getByText(local.badgeNoTools, { exact: true })).toBeVisible()
  await expect(
    page.locator('[data-model^="Hermes-3"]').first().getByText(chat.badgeTools, { exact: true }),
  ).toBeVisible()
  await expect(row.getByText(local.statusNone)).toBeVisible()

  await row.getByRole('button', { name: fill(local.downloadNamed, { model: SMOL_NAME }) }).click()
  await expect(page.getByText(fill(local.downloadDone, { model: SMOL_NAME }))).toBeVisible(ANSWER_WAIT)
  await expect(row.getByText(local.statusDownloaded)).toBeVisible()
  // A downloaded model joins the picker list of the provider.
  await expect(page.getByText(SMOL, { exact: true })).toBeVisible()
  await accessible(page, 'in-browser models')

  await newChat(page, SMOL)
  await send(page, 'Say something')
  const answer = await settled(page)
  await expect(content(answer)).toContainText(LOCAL_ANSWER)
  await expect(content(answer)).not.toContainText('<think>')
  await expect(reasoningOf(answer)).toHaveCount(1)
  await reasoningOf(answer).locator('summary').click()
  await expect(reasoningOf(answer)).toContainText(LOCAL_REASONING)

  await openModels(page)
  await page
    .getByRole('link', { name: new RegExp(`^${local.webllmTitle}`) })
    .first()
    .click()
  await row.getByRole('button', { name: fill(local.deleteNamed, { model: SMOL_NAME }) }).click()
  await expect(page.getByText(fill(local.deleted, { model: SMOL_NAME }))).toBeVisible()
  await expect(row.getByText(local.statusNone)).toBeVisible()
  // Only public model files were cached, under the app's own names.
  const names = await page.evaluate(() => caches.keys())
  for (const name of names) expect(name.startsWith('aparte-')).toBe(true)
})

test('Chrome built-in AI: the Prompt API answers on the device', async ({ page, context }) => {
  test.setTimeout(120_000)
  await playPromptApi(context)
  await createVault(page)
  await addDeviceProvider(page, local.chromeTitle)
  await expect(page.getByText(local.chromeAvailable)).toBeVisible()
  await accessible(page, 'chrome built-in ai')

  await newChat(page, 'gemini-nano')
  await send(page, 'Hello')
  const answer = await settled(page)
  await expect(content(answer)).toContainText(PROMPT_ANSWER)
})

const OLLAMA = 'http://localhost:11434'
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }

test('Ollama on this computer: diagnosis, model list and a streamed answer', async ({ page, context, gates }) => {
  test.setTimeout(120_000)
  gates.userEndpoint(OLLAMA)
  const chats: unknown[] = []
  await context.route(`${OLLAMA}/**`, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    if (path === '/v1/models') {
      return route.fulfill({ headers: CORS, json: { object: 'list', data: [{ id: 'qwen2.5:0.5b', object: 'model' }] } })
    }
    if (path === '/api/version') return route.fulfill({ headers: CORS, json: { version: '0.12.6' } })
    if (path === '/v1/chat/completions') {
      chats.push(request.postDataJSON())
      return route.fulfill({
        headers: { ...CORS, 'content-type': 'text/event-stream' },
        body: openAIChunks(['Hello ', 'from ', 'Ollama.'], 'qwen2.5:0.5b').join(''),
      })
    }
    return route.fulfill({ status: 404, headers: CORS })
  })

  await createVault(page)
  await openModels(page)
  await page.getByRole('link', { name: /^Ollama/ }).click()
  await page.getByRole('button', { name: chat.providerCreate, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Ollama' })).toBeVisible()

  await page.getByRole('button', { name: local.diagnoseRun, exact: true }).click()
  await expect(page.getByText(fill(local.diagOkVersion, { version: '0.12.6', count: '1' }))).toBeVisible(ANSWER_WAIT)
  await expect(page.getByText(/OLLAMA_ORIGINS=/).first()).toBeVisible()
  await accessible(page, 'ollama provider')

  await page.getByRole('button', { name: chat.providerModelsRefresh, exact: true }).click()
  await expect(page.getByText('qwen2.5:0.5b', { exact: true })).toBeVisible(ANSWER_WAIT)
  await newChat(page, 'qwen2.5:0.5b')
  await send(page, 'Hi')
  const answer = await settled(page)
  await expect(content(answer)).toContainText('Hello from Ollama.')
  expect(chats).toHaveLength(1)
  expect(chats[0]).toMatchObject({ model: 'qwen2.5:0.5b', stream: true })
})
