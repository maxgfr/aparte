import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { chat } from '../src/i18n/en/chat.ts'
import { common } from '../src/i18n/en/common.ts'
import { sync } from '../src/i18n/en/sync.ts'
import { transfer } from '../src/i18n/en/transfer.ts'
import { vault } from '../src/i18n/en/vault.ts'
import {
  ANSWER_WAIT,
  ARGON2_WAIT,
  addProvider,
  answers,
  attachPhoto,
  branchOf,
  content,
  createVault,
  newChat,
  openApp,
  previousVersion,
  send,
  settled,
  userMessages,
} from './fixtures/chat-ui.ts'
import { canvasJpeg } from './fixtures/exif.ts'
import { anthropicText } from './fixtures/sse.ts'
import { expect, test } from './fixtures/test.ts'
import { createVaultWithKit, exportAs, go, openExport, openTransfer, saved } from './fixtures/transfer.ts'
import { accessible } from './gates.ts'

/*
 * Import and export from the user's side: one conversation saved as JSON, Markdown and a self-contained web page,
 * and its JSON imported back; the encrypted `.aparte` backup carrying a vault, photo included, to a device opened for
 * the first time, in place of the vault it started with; and a ChatGPT export imported with its branches.
 */

test.use({ netPurposes: ['provider'] })

const CLAUDE = { kind: 'anthropic', model: 'claude-opus-5-5' } as const
const canary = (what: string) => `canary-${what}-${randomUUID()}`
const lockHeading = (page: Page) => page.getByRole('heading', { level: 1, name: common.appName, exact: true })
const fill = (template: string, values: Record<string, string | number>) =>
  Object.entries(values).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), template)

test('a conversation exports as JSON, Markdown and a web page, and its JSON imports back', async ({
  page,
  providers,
}) => {
  test.setTimeout(240_000)
  const question = `Name a river. ${canary('question')}`
  const answer = `The Loire. ${canary('answer')}`
  await createVault(page)
  await addProvider(page, providers, { ...CLAUDE, key: `sk-ant-api03-${canary('key')}` })
  await newChat(page, CLAUDE.model)
  providers.serve('anthropic', anthropicText(['The Loire', `. ${answer.slice('The Loire. '.length)}`]))
  await send(page, question)
  await expect(content(await settled(page))).toHaveText(answer)

  await openExport(page)
  await accessible(page, 'export sheet')
  await page.keyboard.press('Escape')

  const json = await exportAs(page, transfer.exportJson)
  expect(json.download.suggestedFilename()).toMatch(/\.aparte\.json$/)
  const doc = JSON.parse(json.bytes.toString('utf8')) as {
    format: string
    version: number
    conversations: { messages: { role: string; parts: { type: string; text?: string }[] }[] }[]
  }
  expect(doc.format).toBe('aparte-conversation')
  expect(doc.version).toBe(1)
  const texts = doc.conversations[0]?.messages.map((m) => m.parts.find((p) => p.type === 'text')?.text)
  expect(texts).toEqual([question, answer])

  const md = await exportAs(page, transfer.exportMarkdown)
  expect(md.download.suggestedFilename()).toMatch(/\.md$/)
  const markdown = md.bytes.toString('utf8')
  expect(markdown).toContain(`## ${transfer.docYou}\n\n${question}`)
  expect(markdown).toContain(answer)

  const web = await exportAs(page, transfer.exportHtml)
  expect(web.download.suggestedFilename()).toMatch(/\.html$/)
  const html = web.bytes.toString('utf8')
  expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="default-src 'none';`)
  expect(html.toLowerCase()).not.toContain('<script')
  expect(html).toContain(question)
  expect(html).toContain(answer)

  // The JSON comes back as a second copy of the conversation.
  await openTransfer(page)
  await accessible(page, 'import and export')
  await page
    .getByLabel(transfer.importPick, { exact: true })
    .setInputFiles({ name: 'chat.aparte.json', mimeType: 'application/json', buffer: json.bytes })
  await expect(
    page.getByText(fill(transfer.importFound, { count: 1, source: transfer.sourceAparte }), { exact: true }),
  ).toBeVisible(ANSWER_WAIT)
  await page.getByRole('button', { name: transfer.importButton, exact: true }).click()
  await expect(page.getByText(fill(transfer.importDone, { count: 1 }), { exact: true }).first()).toBeVisible(
    ANSWER_WAIT,
  )
  await page.getByRole('link', { name: transfer.openChats, exact: true }).click()
  // The list of the screen (a wide window also lists them in the sidebar).
  const listed = page.getByRole('main').getByRole('link', { name: new RegExp(question.slice(0, 13)) })
  await expect(listed).toHaveCount(2, ANSWER_WAIT)
  await listed.first().click()
  await expect(userMessages(page).first()).toContainText(question)
  await expect(content(answers(page).first())).toHaveText(answer)
})

test('the encrypted backup carries the vault, photo included, to a device without one', async ({
  page,
  providers,
  browser,
  gates,
  baseURL,
}) => {
  test.setTimeout(300_000)
  const question = `Keep this photo safe. ${canary('question')}`
  const answer = canary('answer')
  const { passphrase, secretKey } = await createVaultWithKit(page)
  await addProvider(page, providers, { ...CLAUDE, key: `sk-ant-api03-${canary('key')}` })
  await newChat(page, CLAUDE.model)
  await attachPhoto(page, 'IMG_0002.jpg', await canvasJpeg(page))
  providers.serve('anthropic', anthropicText(['Kept. ', answer]))
  await send(page, question)
  await settled(page)

  await openTransfer(page)
  const backup = await saved(page, page.getByRole('button', { name: transfer.backupExport, exact: true }))
  expect(backup.download.suggestedFilename()).toMatch(/^aparte-backup-\d{4}-\d{2}-\d{2}\.aparte$/)
  // A zip of ciphertext: the question is nowhere in it.
  expect(backup.bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  expect(backup.bytes.toString('latin1').includes(question)).toBe(false)

  // Merging it into the same vault changes nothing visible.
  await page
    .getByLabel(transfer.backupImportLabel, { exact: true })
    .setInputFiles({ name: 'mine.aparte', mimeType: 'application/octet-stream', buffer: backup.bytes })
  await expect(page.getByText(transfer.backupImported).first()).toBeVisible(ANSWER_WAIT)

  const contextB = await browser.newContext({ baseURL, serviceWorkers: 'block' })
  await gates.watch(contextB)
  const b = await contextB.newPage()
  await openApp(b)
  await go(b, sync.navSync)
  await b.getByRole('link', { name: sync.welcomeJoin }).click()
  await b.getByRole('radio', { name: sync.joinArchive, exact: true }).check()
  await b
    .getByLabel(sync.joinArchivePick, { exact: true })
    .setInputFiles({ name: 'backup.aparte', mimeType: 'application/octet-stream', buffer: backup.bytes })
  await expect(lockHeading(b)).toBeVisible(ANSWER_WAIT)
  await b.getByLabel(vault.passphraseLabel, { exact: true }).fill(passphrase)
  await b.getByLabel(vault.secretKeyLabel, { exact: true }).fill(secretKey)
  await b.getByRole('button', { name: vault.unlock, exact: true }).click()
  await expect(lockHeading(b)).toHaveCount(0, ARGON2_WAIT)
  await go(b, chat.navChats)
  const listed = b.getByRole('link', { name: new RegExp(question.slice(0, 20)) }).first()
  await expect(listed).toBeVisible({ timeout: 60_000 })
  await listed.click()
  await expect(userMessages(b).first()).toContainText(question)
  const photo = userMessages(b).first().getByRole('img')
  await expect(photo).toHaveCount(1, ANSWER_WAIT)
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth), ANSWER_WAIT).toBeGreaterThan(0)
  await expect(answers(b).first()).toContainText(answer)
  await contextB.close()
})

test('a ChatGPT export imports with its branches', async ({ page }) => {
  test.setTimeout(180_000)
  const file = await readFile(new URL('../src/core/transfer/fixtures/chatgpt.json', import.meta.url))
  await createVault(page)
  await openTransfer(page)
  await page
    .getByLabel(transfer.importPick, { exact: true })
    .setInputFiles({ name: 'conversations.json', mimeType: 'application/json', buffer: file })
  await expect(
    page.getByText(fill(transfer.importFound, { count: 1, source: transfer.sourceChatgpt }), { exact: true }),
  ).toBeVisible(ANSWER_WAIT)
  await page.getByRole('button', { name: transfer.importButton, exact: true }).click()
  await page.getByRole('link', { name: transfer.openChats, exact: true }).click()
  await page
    .getByRole('link', { name: /Packing for Lisbon/ })
    .first()
    .click()

  // The branch ChatGPT showed: the second version of the question, its answer after the dropped tool round.
  await expect(userMessages(page)).toHaveCount(1, ANSWER_WAIT)
  await expect(userMessages(page).first()).toContainText('And the weather in late May?')
  await expect(answers(page).first()).toContainText('Warm days around 24 °C')
  expect(await branchOf(userMessages(page).first())).toBe('2/2')
  await previousVersion(userMessages(page).first())
  await expect(userMessages(page).first()).toContainText('What should I pack for Lisbon in May?')
  await expect(content(answers(page).first()).locator('strong')).toHaveText('comfortable shoes')
  expect(await branchOf(userMessages(page).first())).toBe('1/2')
  await accessible(page, 'imported chat with branches')
})
