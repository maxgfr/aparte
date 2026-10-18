import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { COMMIT_AUTHOR, COMMIT_MESSAGE } from '../src/core/sync/providers/github.ts'
import { chat } from '../src/i18n/en/chat.ts'
import { common } from '../src/i18n/en/common.ts'
import { sync } from '../src/i18n/en/sync.ts'
import { vault } from '../src/i18n/en/vault.ts'
import {
  ANSWER_WAIT,
  ARGON2_WAIT,
  addProvider,
  attachPhoto,
  createVaultWithKit,
  newChat,
  openApp,
  send,
  settled,
  userMessages,
} from './fixtures/chat-ui.ts'
import { canvasJpeg, EXIF_MARKER, withGpsExif } from './fixtures/exif.ts'
import { GitHubMock } from './fixtures/github.ts'
import { anthropicText } from './fixtures/sse.ts'
import { dumpStorage, plaintextHits } from './fixtures/storage.ts'
import { expect, test } from './fixtures/test.ts'
import { accessible } from './gates.ts'

/*
 * End-to-end encrypted sync between two devices (two browser contexts) through a GitHub repository the test plays
 * (fixtures/github.ts): device A writes a conversation with a photo, protects its vault with a passphrase from the
 * settings and syncs; device B, opened for the first time, joins from the repository with the passphrase and the
 * Secret Key in place of the vault it started with, sees the conversation and the photo, renames it; A sees the new
 * title. The repository and both devices' storage hold no plaintext: no message, no title, no key, no token, no GPS.
 */

test.use({ netPurposes: ['provider', 'sync'] })

const CLAUDE = { kind: 'anthropic', model: 'claude-opus-5-5' } as const
const canary = (what: string) => `canary-${what}-${randomUUID()}`

const lockHeading = (page: Page) => page.getByRole('heading', { level: 1, name: common.appName, exact: true })

/** Clicks the navigation entry `name`, a link or a button in the tab bar or the sidebar. */
async function go(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation')
    .getByRole('link', { name, exact: true })
    .or(page.getByRole('navigation').getByRole('button', { name, exact: true }))
    .first()
    .click()
}

/** Device B: the app opened for the first time, then "I already have a vault" from the sync screen. */
async function openJoin(page: Page): Promise<void> {
  await openApp(page)
  await go(page, sync.navSync)
  await expect(page.getByRole('heading', { level: 2, name: sync.needsPassphraseTitle })).toBeVisible()
  await page.getByRole('link', { name: sync.welcomeJoin }).click()
  await expect(page.getByRole('heading', { level: 1, name: sync.joinTitle })).toBeVisible()
}

async function fillGitHub(page: Page, github: GitHubMock): Promise<void> {
  await page.getByLabel(sync.ghOwner, { exact: true }).fill(github.owner)
  await page.getByLabel(sync.ghRepo, { exact: true }).fill(github.repo)
  const token = page.getByLabel(sync.ghToken, { exact: true })
  await token.fill(github.token)
  await expect(token).toHaveAttribute('type', 'password')
}

/** The destination card of the sync screen. */
const destination = (page: Page) => page.locator('[data-destination="github"]')

/** Syncs now from the sync screen and waits for the destination to be up to date with nothing queued. */
async function syncNow(page: Page): Promise<void> {
  await go(page, sync.navSync)
  await expect(page.getByRole('heading', { level: 1, name: sync.title })).toBeVisible()
  await page.getByRole('button', { name: sync.syncNow }).click()
  await expect(destination(page).getByRole('status')).toHaveText(sync.stateIdle, { timeout: 120_000 })
  await expect(destination(page)).not.toContainText(sync.queued.replace('{count}', ''), { timeout: 120_000 })
}

test('two devices sync a conversation and its photo through a GitHub repository', async ({
  page,
  providers,
  browser,
  gates,
  baseURL,
}) => {
  test.setTimeout(420_000)
  const token = `github_pat_${canary('token').replaceAll('-', '_')}`
  const key = `sk-ant-api03-${canary('key')}`
  const question = `Describe this photo. ${canary('question')}`
  const answer = canary('answer')
  const gps = canary('gps')
  const github = new GitHubMock('me', 'vault', token)
  await github.install(page.context())

  // Device A: a vault, a provider, a conversation with a photo.
  const { passphrase, secretKey } = await createVaultWithKit(page)
  await addProvider(page, providers, { ...CLAUDE, key })
  await newChat(page, CLAUDE.model)
  await attachPhoto(page, 'IMG_0001.jpg', withGpsExif(await canvasJpeg(page), gps))
  providers.serve('anthropic', anthropicText(['A gradient. ', answer]))
  await send(page, question)
  await settled(page)

  // A connects the repository and syncs.
  await go(page, sync.navSync)
  await expect(page.getByText(sync.noDestination)).toBeVisible()
  await accessible(page, 'sync, no destination')
  await fillGitHub(page, github)
  await page.getByRole('button', { name: sync.connect, exact: true }).click()
  await expect(destination(page)).toBeVisible(ANSWER_WAIT)
  await expect(destination(page).getByRole('status')).toHaveText(sync.stateIdle, { timeout: 120_000 })
  await accessible(page, 'sync, one destination')

  // The repository holds aparte/1 objects only, under the root folder, and nothing readable.
  const objects = github.objects()
  const names = [...objects.keys()].map((p) => p.replace(/^aparte\//, ''))
  expect(names).toContain('fmt/1')
  expect(names.filter((n) => n.startsWith('keys/')).length).toBeGreaterThanOrEqual(1)
  expect(names.filter((n) => n.startsWith('b/')).length).toBeGreaterThanOrEqual(1)
  expect(names.filter((n) => n.startsWith('m/')).length).toBeGreaterThanOrEqual(1)
  expect(names.filter((n) => n.startsWith('d/')).length).toBeGreaterThanOrEqual(2)
  const remote = [...objects.values()].map((bytes, i) => ({
    where: `repository ${names[i]}`,
    text: bytes.toString('latin1'),
  }))
  expect(plaintextHits(remote, [question, answer, key, token, gps])).toEqual([])
  for (const { text } of remote) expect(text.includes(EXIF_MARKER.toString('latin1'))).toBe(false)
  // Every commit the app wrote is anonymous and alike (the oldest one is the repository's own README).
  const written = github.fake.history().slice(0, -1)
  expect(written.length).toBeGreaterThan(0)
  for (const commit of written) expect(commit).toMatchObject({ message: COMMIT_MESSAGE, author: COMMIT_AUTHOR })

  // Device B: no vault yet; it joins from the repository.
  const contextB = await browser.newContext({ baseURL, serviceWorkers: 'block' })
  await gates.watch(contextB)
  await github.install(contextB)
  const b = await contextB.newPage()
  await openJoin(b)
  await accessible(b, 'join a vault')
  await fillGitHub(b, github)
  await b.getByRole('button', { name: sync.joinFind, exact: true }).click()
  await expect(lockHeading(b)).toBeVisible(ANSWER_WAIT)
  await b.getByLabel(vault.passphraseLabel, { exact: true }).fill(passphrase)
  await b.getByLabel(vault.secretKeyLabel, { exact: true }).fill(secretKey)
  await expect(b.getByLabel(sync.rememberSecretKey)).toBeChecked()
  await b.getByRole('button', { name: vault.unlock, exact: true }).click()
  await expect(lockHeading(b)).toHaveCount(0, ARGON2_WAIT)

  // B receives the conversation and its photo.
  await go(b, chat.navChats)
  const listed = b.getByRole('link', { name: new RegExp(question.slice(0, 20)) }).first()
  await expect(listed).toBeVisible({ timeout: 120_000 })
  await listed.click()
  await expect(userMessages(b).first()).toContainText(question)
  const photo = userMessages(b).first().getByRole('img')
  await expect(photo).toHaveCount(1, ANSWER_WAIT)
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth), ANSWER_WAIT).toBeGreaterThan(0)
  await expect(b.locator('[data-message][data-role="assistant"]').first()).toContainText(answer)

  // B renames it and syncs; A syncs and sees the new title.
  const renamed = `Renamed on B ${randomUUID().slice(0, 8)}`
  await go(b, chat.navChats)
  await b
    .getByRole('button', { name: new RegExp(`^${chat.actionsFor.replace('{title}', '').replace('“”', '“.*”')}`) })
    .first()
    .click()
  await b.getByLabel(chat.renameLabel, { exact: true }).fill(renamed)
  await b.getByRole('button', { name: chat.rename, exact: true }).click()
  await syncNow(b)
  await syncNow(page)
  await go(page, chat.navChats)
  await expect(page.getByRole('link', { name: new RegExp(renamed) }).first()).toBeVisible({ timeout: 60_000 })

  // Neither device keeps anything readable: not the conversation, the key, the GPS tag, nor the GitHub token.
  for (const [device, p] of [
    ['A', page],
    ['B', b],
  ] as const) {
    expect(plaintextHits(await dumpStorage(p), [question, answer, key, token, gps, renamed]), device).toEqual([])
  }
  expect(github.problems).toEqual([])
  await contextB.close()
})

test('an exported archive carries the vault to a new device, and stays unreadable', async ({
  page,
  providers,
  browser,
  gates,
  baseURL,
}) => {
  test.setTimeout(300_000)
  const question = `Pack this up. ${canary('question')}`
  const { passphrase, secretKey } = await createVaultWithKit(page)
  await addProvider(page, providers, { ...CLAUDE, key: `sk-ant-api03-${canary('key')}` })
  await newChat(page, CLAUDE.model)
  providers.serve('anthropic', anthropicText(['Packed.']))
  await send(page, question)
  await settled(page)

  // A exports the archive from the sync screen.
  await go(page, sync.navSync)
  await page.getByRole('radio', { name: sync.kindZip, exact: true }).check()
  await accessible(page, 'sync, archive')
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: sync.zipExport, exact: true }).click(),
  ])
  expect(download.suggestedFilename()).toBe('vault.aparte.zip')
  const path = await download.path()
  const archive = await readFile(path)
  expect(archive.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  expect(plaintextHits([{ where: 'archive', text: archive.toString('latin1') }], [question])).toEqual([])

  // B, with no vault, joins from the archive.
  const contextB = await browser.newContext({ baseURL, serviceWorkers: 'block' })
  await gates.watch(contextB)
  const b = await contextB.newPage()
  await openJoin(b)
  await b.getByRole('radio', { name: sync.joinArchive, exact: true }).check()
  await b
    .getByLabel(sync.joinArchivePick, { exact: true })
    .setInputFiles({ name: 'vault.aparte.zip', mimeType: 'application/zip', buffer: archive })
  await expect(lockHeading(b)).toBeVisible(ANSWER_WAIT)
  await b.getByLabel(vault.passphraseLabel, { exact: true }).fill(passphrase)
  await b.getByLabel(vault.secretKeyLabel, { exact: true }).fill(secretKey)
  await b.getByRole('button', { name: vault.unlock, exact: true }).click()
  await expect(lockHeading(b)).toHaveCount(0, ARGON2_WAIT)
  await go(b, chat.navChats)
  const listed = b.getByRole('link', { name: new RegExp(question.slice(0, 12)) }).first()
  await expect(listed).toBeVisible({ timeout: 60_000 })
  await listed.click()
  await expect(userMessages(b).first()).toContainText(question)
  await contextB.close()
})
