import type { Page } from '@playwright/test'
import { common } from '../src/i18n/en/common.ts'
import { shell } from '../src/i18n/en/shell.ts'
import { vault } from '../src/i18n/en/vault.ts'
import { accessible, expect, test } from './gates.ts'

/*
 * The vault from the user's side, on every project: create (generated passphrase), the Emergency Kit, lock and
 * unlock, a wrong passphrase, recovery with the recovery key, auto-lock, and the custom passphrase rules. The app
 * runs with its production Argon2 parameters (m = 64 MiB, t = 3): every create or unlock below costs a real run, so
 * the waits are generous.
 */

const ARGON2_WAIT = { timeout: 60_000 }

const SECRET_KEY = /^A1(-[A-Z2-7]{5}){6}$/
const RECOVERY_KEY = /^[A-Z2-7]{4}(-[A-Z2-7]{4}){12}$/

const welcomeHeading = (page: Page) => page.getByRole('heading', { level: 1, name: shell.welcomeTitle })
const lockHeading = (page: Page) => page.getByRole('heading', { level: 1, name: common.appName, exact: true })

/** Creates a vault with the generated passphrase; returns it and the kit texts, the kit still on screen. */
async function createVault(page: Page) {
  await page.goto('./')
  await expect(welcomeHeading(page)).toBeVisible()
  await page.getByRole('link', { name: shell.welcomeCreateVault }).click()
  await expect(page.getByRole('heading', { level: 1, name: vault.createTitle })).toBeVisible()
  const field = page.getByLabel(vault.generatedLabel, { exact: true })
  const first = await field.inputValue()
  await page.getByRole('button', { name: vault.regenerate }).click()
  await expect(field).not.toHaveValue(first)
  const passphrase = await field.inputValue()
  expect(passphrase.length).toBeGreaterThan(12)
  await page.getByRole('button', { name: vault.create }).click()
  await expect(page.getByRole('heading', { level: 1, name: vault.kitTitle })).toBeVisible(ARGON2_WAIT)
  const secretKey = (await page.locator('[data-key="secret-key"]').textContent()) ?? ''
  const recoveryKey = (await page.locator('[data-key="recovery-key"]').textContent()) ?? ''
  expect(secretKey).toMatch(SECRET_KEY)
  expect(recoveryKey).toMatch(RECOVERY_KEY)
  return { passphrase, secretKey, recoveryKey }
}

async function confirmKit(page: Page) {
  const proceed = page.getByRole('button', { name: vault.kitContinue })
  await expect(proceed).toBeDisabled()
  await page.getByLabel(vault.kitConfirm).check()
  await proceed.click()
  await expect(welcomeHeading(page)).toBeVisible()
}

async function unlock(page: Page, passphrase: string) {
  await page.getByLabel(vault.passphraseLabel, { exact: true }).fill(passphrase)
  await page.getByRole('button', { name: vault.unlock, exact: true }).click()
}

test('create, Emergency Kit, lock, wrong passphrase, unlock and recovery', async ({ page }) => {
  test.setTimeout(240_000)
  const { passphrase, recoveryKey } = await createVault(page)
  await accessible(page, 'emergency kit')

  // On paper the kit stands alone: no buttons, and a line to write the passphrase by hand.
  await page.emulateMedia({ media: 'print' })
  await expect(page.getByRole('button', { name: vault.kitContinue })).toBeHidden()
  await expect(page.getByText(vault.kitPassphraseLine)).toBeVisible()
  await page.emulateMedia({ media: 'screen' })
  await expect(page.getByText(vault.kitPassphraseLine)).toBeHidden()
  await expect(page.getByRole('button', { name: vault.kitPrint })).toBeVisible()
  await confirmKit(page)
  await expect(page.getByText(vault.homeUnlocked)).toBeVisible()

  // A reload forgets every key: the vault comes back locked, and nothing of the app shows behind the lock.
  await page.reload()
  await expect(lockHeading(page)).toBeVisible()
  await expect(welcomeHeading(page)).toHaveCount(0)
  await expect(page.getByRole('navigation')).toHaveCount(0)
  // The Secret Key is remembered on this device: only the passphrase is asked for.
  await expect(page.getByLabel(vault.secretKeyLabel)).toHaveCount(0)
  await expect(page.getByLabel(vault.passphraseLabel, { exact: true })).toBeFocused()
  await accessible(page, 'lock screen')

  await unlock(page, `${passphrase}x`)
  await expect(page.getByText(vault.wrongPassphrase)).toBeVisible(ARGON2_WAIT)
  await expect(page.getByLabel(vault.passphraseLabel, { exact: true })).toHaveAttribute('aria-invalid', 'true')
  await accessible(page, 'lock screen with an error')

  await unlock(page, passphrase)
  await expect(welcomeHeading(page)).toBeVisible(ARGON2_WAIT)

  // The lock button locks at once when nothing holds the lock.
  await page.getByRole('button', { name: vault.lock, exact: true }).click()
  await expect(lockHeading(page)).toBeVisible()

  await page.getByRole('button', { name: vault.forgot }).click()
  await expect(page.getByRole('heading', { level: 1, name: vault.recoverTitle })).toBeVisible()
  await accessible(page, 'recovery')
  const recoveryField = page.getByLabel(vault.recoveryKeyLabel, { exact: true })
  await recoveryField.fill('ABCD-EFGH')
  await page.getByRole('button', { name: vault.recover }).click()
  await expect(page.getByText(vault.badRecoveryKey)).toBeVisible()

  const next = await page.getByLabel(vault.newPassphraseLabel, { exact: true }).inputValue()
  expect(next).not.toBe(passphrase)
  // Case, spaces and hyphens do not matter in a recovery key.
  await recoveryField.fill(recoveryKey.toLowerCase().replaceAll('-', ' '))
  await page.getByRole('button', { name: vault.recover }).click()
  await expect(welcomeHeading(page)).toBeVisible(ARGON2_WAIT)
  await expect(page.getByText(vault.recovered)).toBeVisible()
  // The device kept its Secret Key, so no new Emergency Kit was needed.
  await expect(page.getByRole('heading', { name: vault.kitTitle })).toHaveCount(0)

  // The new passphrase opens the vault.
  await page.getByRole('button', { name: vault.lock, exact: true }).click()
  await expect(lockHeading(page)).toBeVisible()
  await unlock(page, next)
  await expect(welcomeHeading(page)).toBeVisible(ARGON2_WAIT)
})

test('the vault locks itself after five idle minutes', async ({ page }) => {
  test.setTimeout(120_000)
  await page.clock.install()
  const { passphrase } = await createVault(page)
  await confirmKit(page)
  await page.clock.fastForward('06:00')
  await expect(lockHeading(page)).toBeVisible()
  await expect(page.getByText(vault.lockedIdle)).toBeVisible()
  await unlock(page, passphrase)
  await expect(welcomeHeading(page)).toBeVisible(ARGON2_WAIT)
})

test('a custom passphrase must be strong and typed twice the same', async ({ page }) => {
  await page.goto('./')
  await page.getByRole('link', { name: shell.welcomeCreateVault }).click()
  await expect(page.getByRole('heading', { level: 1, name: vault.createTitle })).toBeVisible()
  await accessible(page, 'create vault')
  await page.getByLabel(vault.choiceCustom).check()
  const field = page.getByLabel(vault.generatedLabel, { exact: true })
  const confirm = page.getByLabel(vault.confirmLabel, { exact: true })
  const create = page.getByRole('button', { name: vault.create })

  await field.fill('password')
  await expect(page.getByText(vault.strengthTooWeak)).toBeVisible()
  await confirm.fill('password')
  await expect(create).toBeDisabled()

  const strong = 'my cat files tax returns in Lisbon every leap year'
  await field.fill(strong)
  await expect(page.getByText(vault.strength4)).toBeVisible()
  await confirm.fill(`${strong}!`)
  await expect(page.getByText(vault.confirmMismatch)).toBeVisible()
  await expect(create).toBeDisabled()
  await confirm.fill(strong)
  await expect(page.getByText(vault.confirmMismatch)).toHaveCount(0)
  await expect(create).toBeEnabled()
  await accessible(page, 'create vault, custom passphrase')
})
