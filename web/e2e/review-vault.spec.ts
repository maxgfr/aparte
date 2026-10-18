import type { Page } from '@playwright/test'
import { common } from '../src/i18n/en/common.ts'
import { shell } from '../src/i18n/en/shell.ts'
import { vault } from '../src/i18n/en/vault.ts'
import { expect, test } from './gates.ts'

/*
 * Adversarial review of the vault from the user's side: several pages of the app open at once, a device-wrapped
 * Secret Key that no longer unwraps, an Emergency Kit that is lost or left on screen, and the copied passphrase.
 * Each test states the behaviour the app should have; a failure here is a defect.
 */

const ARGON2_WAIT = { timeout: 60_000 }

const welcomeHeading = (page: Page) => page.getByRole('heading', { level: 1, name: shell.welcomeTitle })
const lockHeading = (page: Page) => page.getByRole('heading', { level: 1, name: common.appName, exact: true })
const kitHeading = (page: Page) => page.getByRole('heading', { level: 1, name: vault.kitTitle })

/** Creates the vault with the generated passphrase, the kit left on screen. */
async function createVault(page: Page) {
  await page.goto('./')
  await expect(welcomeHeading(page)).toBeVisible()
  await page.getByRole('link', { name: shell.welcomeCreateVault }).click()
  await expect(page.getByRole('heading', { level: 1, name: vault.createTitle })).toBeVisible()
  const passphrase = await page.getByLabel(vault.generatedLabel, { exact: true }).inputValue()
  await page.getByRole('button', { name: vault.create }).click()
  await expect(kitHeading(page)).toBeVisible(ARGON2_WAIT)
  const secretKey = (await page.locator('[data-key="secret-key"]').textContent()) ?? ''
  const recoveryKey = (await page.locator('[data-key="recovery-key"]').textContent()) ?? ''
  return { passphrase, secretKey, recoveryKey }
}

async function confirmKit(page: Page) {
  await page.getByLabel(vault.kitConfirm).check()
  await page.getByRole('button', { name: vault.kitContinue }).click()
  await expect(page.getByText(vault.homeUnlocked)).toBeVisible()
}

async function unlock(page: Page, passphrase: string) {
  await page.getByLabel(vault.passphraseLabel, { exact: true }).fill(passphrase)
  await page.getByRole('button', { name: vault.unlock, exact: true }).click()
}

test('a second tab still on the welcome screen cannot destroy the vault the first tab created', async ({
  context,
  page,
}) => {
  test.setTimeout(240_000)
  const second = await context.newPage()
  // The first tab tells the others that a vault now exists, at a moment no test controls: the second tab is a page
  // that does not hear it (a browser without BroadcastChannel, which the app does without), so that it is still on
  // the welcome screen when the user acts there, as a tab the notice reaches late is.
  await second.addInitScript(() => Reflect.deleteProperty(globalThis, 'BroadcastChannel'))
  await second.goto('./')
  await expect(welcomeHeading(second)).toBeVisible()

  const { passphrase } = await createVault(page)
  await confirmKit(page)

  // The second tab loaded before the vault existed and still offers to create one. Whatever the user does there,
  // the vault of the first tab, with its kit already written down, must survive.
  await second.getByRole('link', { name: shell.welcomeCreateVault }).click()
  await expect(second.getByRole('heading', { level: 1, name: vault.createTitle })).toBeVisible()
  await second.getByRole('button', { name: vault.create }).click()
  // The attempt ends with the kit of a vault it made, or with the vault on this device shown locked.
  await expect(kitHeading(second).or(lockHeading(second))).toBeVisible(ARGON2_WAIT)

  await page.reload()
  await expect(lockHeading(page)).toBeVisible()
  await unlock(page, passphrase)
  await expect(welcomeHeading(page)).toBeVisible(ARGON2_WAIT)
  await expect(page.getByText(vault.homeUnlocked)).toBeVisible()
})

test('locking in one tab locks the other tabs of the same vault', async ({ context, page }) => {
  test.setTimeout(240_000)
  const { passphrase } = await createVault(page)
  await confirmKit(page)

  const second = await context.newPage()
  await second.goto('./')
  await expect(lockHeading(second)).toBeVisible()
  await unlock(second, passphrase)
  await expect(second.getByText(vault.homeUnlocked)).toBeVisible(ARGON2_WAIT)

  // The user presses Lock in the first tab and walks away believing the app is locked.
  await page.getByRole('button', { name: vault.lock, exact: true }).click()
  await expect(lockHeading(page)).toBeVisible()
  await expect(lockHeading(second)).toBeVisible({ timeout: 5_000 })
})

test('a device-wrapped Secret Key that no longer unwraps does not lock the user out', async ({ page }) => {
  test.setTimeout(240_000)
  const { passphrase, secretKey, recoveryKey } = await createVault(page)
  await confirmKit(page)

  // `secret-key` stops unwrapping under `device-key` (a partial restore of site data, or another page of the shared
  // origin overwriting it, spec/FORMAT.md section 14). 44 bytes passes the length check.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('aparte-v1')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const tx = db.transaction('meta', 'readwrite')
          tx.objectStore('meta').put(crypto.getRandomValues(new Uint8Array(44)), 'secret-key')
          tx.oncomplete = () => {
            db.close()
            resolve()
          }
          tx.onerror = () => reject(tx.error)
        }
      }),
  )
  await page.reload()
  await expect(lockHeading(page)).toBeVisible()

  // The user holds the passphrase and the whole Emergency Kit: one of the two ways back in must work.
  await unlock(page, passphrase)
  const secretKeyField = page.getByLabel(vault.secretKeyLabel, { exact: true })
  const unlocked = page.getByText(vault.homeUnlocked)
  await expect(unlocked.or(secretKeyField).or(page.getByText(vault.unlockFailed))).toBeVisible(ARGON2_WAIT)
  if (await unlocked.isVisible()) return
  if (await secretKeyField.isVisible()) {
    // The device copy is gone, so the app asks for the Secret Key from the Emergency Kit: the user types it.
    await secretKeyField.fill(secretKey)
    await page.getByRole('button', { name: vault.unlock, exact: true }).click()
  } else {
    // No Secret Key field is offered: the recovery key is the last resort.
    await page.getByRole('button', { name: vault.forgot }).click()
    await page.getByLabel(vault.recoveryKeyLabel, { exact: true }).fill(recoveryKey)
    await page.getByRole('button', { name: vault.recover }).click()
  }
  await expect(unlocked).toBeVisible(ARGON2_WAIT)
})

test('an Emergency Kit closed before it was confirmed is offered again', async ({ context, page }) => {
  test.setTimeout(240_000)
  const { passphrase } = await createVault(page)
  // The tab goes away with the kit unconfirmed: the phone reclaims a backgrounded app while the user looks for a pen,
  // the tab crashes, or the browser is closed. No beforeunload prompt runs in any of these.
  await page.close()

  const again = await context.newPage()
  await again.goto('./')
  await expect(lockHeading(again)).toBeVisible()
  await unlock(again, passphrase)
  await expect(welcomeHeading(again).or(kitHeading(again))).toBeVisible(ARGON2_WAIT)
  // The recovery key was never kept and no screen can show or replace it: the kit must come back.
  await expect(kitHeading(again)).toBeVisible()
})

test('an Emergency Kit left on screen does not stay readable forever', async ({ page }) => {
  test.setTimeout(240_000)
  await page.clock.install()
  await createVault(page)
  // The user walks away from the kit. An hour later the recovery key, which opens the vault on its own, is still on
  // screen in an unlocked app: the kit's hold defers the idle lock and the visibility lock indefinitely.
  await page.clock.fastForward('01:00:00')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect(page.locator('[data-key="recovery-key"]')).toHaveCount(0, { timeout: 5_000 })
})

test('the copied passphrase does not stay on the clipboard', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Reading the clipboard from a test needs Chromium permissions')
  test.setTimeout(240_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.clock.install()
  await page.goto('./')
  await page.getByRole('link', { name: shell.welcomeCreateVault }).click()
  const passphrase = await page.getByLabel(vault.generatedLabel, { exact: true }).inputValue()
  await page.getByRole('button', { name: vault.copy }).click()
  await expect(page.getByText(vault.copied)).toBeVisible()
  await page.getByRole('button', { name: vault.create }).click()
  await expect(kitHeading(page)).toBeVisible(ARGON2_WAIT)
  await confirmKit(page)
  await page.getByRole('button', { name: vault.lock, exact: true }).click()
  await expect(lockHeading(page)).toBeVisible()
  // Locked, and a minute later: the master passphrase is still in the system clipboard (and its history or
  // cross-device sync) for any app to read.
  await page.clock.fastForward('02:00')
  expect(await page.evaluate(() => navigator.clipboard.readText())).not.toBe(passphrase)
})
