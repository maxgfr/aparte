import { readFile } from 'node:fs/promises'
import type { Download, Locator, Page } from '@playwright/test'
import { chat } from '../../src/i18n/en/chat.ts'
import { shell } from '../../src/i18n/en/shell.ts'
import { transfer } from '../../src/i18n/en/transfer.ts'
import { vault } from '../../src/i18n/en/vault.ts'
import { expect } from '../gates.ts'
import { ARGON2_WAIT } from './chat-ui.ts'

/*
 * The Import and export screen and the conversation export sheet, as the transfer specs drive them. Controls are
 * found by role and English name (web/src/i18n/en/transfer.ts):
 *
 *   the conversation's "More actions" (chat header) opens "Actions for “{title}”", whose "Export" button opens the
 *   dialog "Export “{title}”" with one button per format, named from its title ("Markdown", "Web page", "JSON");
 *   the screen is reached through the "More" tab, row "Import and export"; its file inputs are labelled
 *   "Choose an export file" (imports) and "Merge a backup into this vault"; "Save a backup" saves the .aparte file.
 */

const escapeRe = (text: string) => text.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')

/** Clicks the navigation entry `name`, a link or a button of the tab bar or the sidebar. */
export async function go(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation')
    .getByRole('link', { name, exact: true })
    .or(page.getByRole('navigation').getByRole('button', { name, exact: true }))
    .first()
    .click()
}

/** Opens the Import and export screen from the More tab. */
export async function openTransfer(page: Page): Promise<void> {
  await go(page, shell.navMore)
  await page.getByRole('link', { name: new RegExp(`^${escapeRe(shell.moreTransfer)}`) }).click()
  await expect(page.getByRole('heading', { level: 1, name: transfer.title })).toBeVisible()
}

/** Creates a vault with the generated passphrase, reads the Secret Key off the kit, confirms it. */
export async function createVaultWithKit(page: Page): Promise<{ passphrase: string; secretKey: string }> {
  await page.goto('./')
  await page.getByRole('link', { name: shell.welcomeCreateVault }).click()
  const passphrase = await page.getByLabel(vault.generatedLabel, { exact: true }).inputValue()
  await page.getByRole('button', { name: vault.create }).click()
  await expect(page.getByRole('heading', { level: 1, name: vault.kitTitle })).toBeVisible(ARGON2_WAIT)
  const secretKey = ((await page.locator('[data-key="secret-key"]').textContent()) ?? '').trim()
  await page.getByLabel(vault.kitConfirm).check()
  await page.getByRole('button', { name: vault.kitContinue }).click()
  await expect(page.getByRole('navigation').getByRole('link', { name: chat.navChats }).first()).toBeVisible(ARGON2_WAIT)
  return { passphrase, secretKey }
}

/** The export dialog of the open chat's conversation. */
export async function openExport(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: chat.more, exact: true }).first().click()
  const actions = page.getByRole('dialog', {
    name: new RegExp(`^${escapeRe(chat.actionsFor.split('{title}')[0] ?? '')}`),
  })
  await actions.getByRole('button', { name: transfer.exportAction, exact: true }).click()
  const sheet = page.getByRole('dialog', {
    name: new RegExp(`^${escapeRe(transfer.exportTitle.split('{title}')[0] ?? '')}`),
  })
  await expect(sheet).toBeVisible()
  return sheet
}

/** Clicks `trigger` and returns the file it saves, with its bytes. */
export async function saved(page: Page, trigger: Locator): Promise<{ download: Download; bytes: Buffer }> {
  const [download] = await Promise.all([page.waitForEvent('download'), trigger.click()])
  return { download, bytes: await readFile(await download.path()) }
}

/** Exports the open chat in the format whose button title is `format`. */
export async function exportAs(page: Page, format: string): Promise<{ download: Download; bytes: Buffer }> {
  const sheet = await openExport(page)
  const out = await saved(page, sheet.getByRole('button', { name: new RegExp(`^${escapeRe(format)}`) }))
  await expect(sheet).toBeHidden()
  return out
}
