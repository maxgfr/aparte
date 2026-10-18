import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { about } from '../src/i18n/en/about.ts'
import { chat } from '../src/i18n/en/chat.ts'
import { common } from '../src/i18n/en/common.ts'
import { shell } from '../src/i18n/en/shell.ts'
import { sync } from '../src/i18n/en/sync.ts'
import { transfer } from '../src/i18n/en/transfer.ts'
import { vault } from '../src/i18n/en/vault.ts'
import {
  ARGON2_WAIT,
  addProvider,
  confirmKit,
  createVault,
  newChat,
  openApp,
  protectFromSettings,
  send,
  settled,
  unlock,
} from './fixtures/chat-ui.ts'
import { anthropicText } from './fixtures/sse.ts'
import { dumpStorage, plaintextHits } from './fixtures/storage.ts'
import { expect, test } from './fixtures/test.ts'
import { go, openTransfer } from './fixtures/transfer.ts'
import { accessible } from './gates.ts'

/*
 * The vault before a passphrase protects it (spec/FORMAT.md section 17), from the user's side, on every project: the
 * first launch lands in a chat with nothing to create or unlock; the app says where it matters that no passphrase
 * protects the vault; what it stores is ciphertext beside a non-extractable key object; sync and the backup wait for
 * a passphrase; protecting the vault from the settings turns on the lock screen, the auto-lock and the Lock button,
 * and removing the protection again needs the passphrase. The vault a passphrase protects is e2e/vault.spec.ts.
 */

test.use({ netPurposes: ['provider'] })

const CLAUDE = { kind: 'anthropic', model: 'claude-opus-5-5' } as const

/** A string that occurs nowhere in the app, so finding it on disk can only mean it was stored in plaintext. */
const canary = (what: string) => `canary-${what}-${randomUUID()}`

const lockHeading = (page: Page) => page.getByRole('heading', { level: 1, name: common.appName, exact: true })
const lockButton = (page: Page) => page.getByRole('button', { name: vault.lock, exact: true })
const hint = (page: Page) => page.getByTestId('protect-hint')

/** Opens the settings screen of the passphrase protection from the More tab. */
async function openProtection(page: Page): Promise<void> {
  await go(page, shell.navMore)
  await page.getByRole('link', { name: new RegExp(`^${shell.moreProtection}`) }).click()
  await expect(page.getByRole('heading', { level: 1, name: vault.protectionTitle })).toBeVisible()
}

/** What the app's database holds, read in the page: the `meta` entries and the type of every other value. */
function storedShape(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('aparte-v1')
      open.onerror = () => reject(open.error)
      open.onsuccess = () => resolve(open.result)
    })
    const all = (store: string) =>
      new Promise<{ keys: IDBValidKey[]; values: unknown[] }>((resolve, reject) => {
        const tx = db.transaction(store, 'readonly')
        const keys = tx.objectStore(store).getAllKeys()
        const values = tx.objectStore(store).getAll()
        tx.oncomplete = () => resolve({ keys: keys.result, values: values.result })
        tx.onerror = () => reject(tx.error)
      })
    try {
      const meta = await all('meta')
      const key = meta.values[meta.keys.indexOf('device-slot-key')]
      const records: string[] = []
      for (const store of ['objects', 'local', 'pending']) {
        for (const value of (await all(store)).values)
          records.push(value instanceof Uint8Array ? 'bytes' : typeof value)
      }
      return {
        meta: meta.keys.map(String).sort(),
        key: key instanceof CryptoKey ? { extractable: key.extractable, algorithm: key.algorithm.name } : null,
        records,
      }
    } finally {
      db.close()
    }
  })
}

test('the first launch lands in a chat, with no vault to create and nothing to unlock', async ({ page }) => {
  await openApp(page)
  expect(new URL(page.url()).hash).toBe('#/chat')
  await expect(lockButton(page)).toHaveCount(0)
  // Where it matters, the app says that no passphrase protects the vault.
  await expect(hint(page)).toBeVisible()
  await expect(hint(page)).toContainText(vault.protectionDevice)
  await accessible(page, 'first chat')

  // A launch again opens the vault without a prompt.
  await page.goto('./')
  await expect(page.getByRole('textbox', { name: chat.composerLabel, exact: true })).toBeVisible()
  await expect(lockHeading(page)).toHaveCount(0)

  // Dismissed, the hint stays dismissed on this device; About and the settings still say it.
  await hint(page).getByRole('button', { name: vault.hintDismiss, exact: true }).click()
  await expect(hint(page)).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('textbox', { name: chat.composerLabel, exact: true })).toBeVisible()
  await expect(hint(page)).toHaveCount(0)
  await page.goto('./#/about')
  await expect(page.getByRole('heading', { level: 1, name: about.title })).toBeVisible()
  await expect(page.getByTestId('about-vault')).toHaveText(vault.protectionDevice)
  await openProtection(page)
  await expect(page.getByTestId('protection-status')).toHaveText(vault.protectionDevice)
  await expect(page.getByText(vault.protectionDeviceBody)).toBeVisible()
  await accessible(page, 'passphrase protection, none yet')
})

test('a chat before any passphrase rests only as ciphertext, beside a key object that cannot be exported', async ({
  page,
  providers,
}) => {
  test.setTimeout(120_000)
  const key = `sk-ant-api03-${canary('key')}`
  const question = `Kept on this device. ${canary('question')}`
  const answer = canary('answer')
  await openApp(page)
  await addProvider(page, providers, { ...CLAUDE, key })
  await newChat(page, CLAUDE.model)
  providers.serve('anthropic', anthropicText(['Noted. ', answer]))
  await send(page, question)
  await settled(page)

  expect(plaintextHits(await dumpStorage(page), [question, answer, key])).toEqual([])
  const shape = await storedShape(page)
  // `meta` holds the format marker, the vault id and the device slot: no keyslot, no Secret Key, no key bytes.
  expect(shape.meta).toEqual(['device-slot', 'device-slot-key', 'fmt', 'vault'])
  expect(shape.key).toEqual({ extractable: false, algorithm: 'AES-GCM' })
  expect(shape.records.length).toBeGreaterThan(0)
  expect(new Set(shape.records)).toEqual(new Set(['bytes']))
})

test('sync and the backup wait for a passphrase, and lead to it', async ({ page }) => {
  await openApp(page)
  await go(page, sync.navSync)
  await expect(page.getByRole('heading', { level: 2, name: sync.needsPassphraseTitle })).toBeVisible()
  await expect(page.getByText(sync.needsPassphraseBody)).toBeVisible()
  await expect(page.getByLabel(sync.ghOwner, { exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: sync.welcomeJoin })).toBeVisible()
  await accessible(page, 'sync without a passphrase')

  await openTransfer(page)
  await expect(page.getByText(transfer.backupNeedsPassphrase)).toBeVisible()
  await expect(page.getByRole('button', { name: transfer.backupExport, exact: true })).toHaveCount(0)

  await go(page, sync.navSync)
  await page.getByRole('link', { name: vault.protectAction, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: vault.protectTitle })).toBeVisible()
})

test('protecting from the settings keeps the chats and brings the lock screen, the Lock button and sync', async ({
  page,
  providers,
}) => {
  test.setTimeout(240_000)
  const question = `Written before the passphrase. ${canary('question')}`
  await openApp(page)
  await addProvider(page, providers, { ...CLAUDE, key: `sk-ant-api03-${canary('key')}` })
  await newChat(page, CLAUDE.model)
  providers.serve('anthropic', anthropicText(['Kept.']))
  await send(page, question)
  await settled(page)
  await expect(lockButton(page)).toHaveCount(0)

  const { passphrase } = await protectFromSettings(page)
  await accessible(page, 'emergency kit after protecting')
  await confirmKit(page)
  await expect(lockButton(page).first()).toBeVisible()
  await go(page, sync.navSync)
  await expect(page.getByText(sync.noDestination)).toBeVisible(ARGON2_WAIT)
  // Neither the passphrase nor the conversation rests in clear once the keyslots exist.
  expect(plaintextHits(await dumpStorage(page), [passphrase, question])).toEqual([])

  await page.reload()
  await expect(lockHeading(page)).toBeVisible()
  await expect(page.getByRole('navigation')).toHaveCount(0)
  await unlock(page, passphrase)
  await go(page, chat.navChats)
  await expect(page.getByRole('link', { name: new RegExp(question.slice(0, 20)) }).first()).toBeVisible()
})

test('removing the protection needs the passphrase, then the vault opens without a prompt again', async ({ page }) => {
  test.setTimeout(240_000)
  const passphrase = await createVault(page)
  await openProtection(page)
  await expect(page.getByTestId('protection-status')).toHaveText(vault.protectionPassphrase)
  await accessible(page, 'passphrase protection, on')
  const field = page.getByLabel(vault.passphraseLabel, { exact: true })
  const remove = page.getByRole('button', { name: vault.unprotect, exact: true })

  await field.fill(`${passphrase}x`)
  await remove.click()
  await expect(page.getByText(vault.wrongPassphrase)).toBeVisible(ARGON2_WAIT)
  await expect(page.getByTestId('protection-status')).toHaveText(vault.protectionPassphrase)

  await field.fill(passphrase)
  await remove.click()
  await expect(page.getByText(vault.unprotected)).toBeVisible(ARGON2_WAIT)
  await expect(page.getByTestId('protection-status')).toHaveText(vault.protectionDevice)
  await expect(lockButton(page)).toHaveCount(0)

  await page.goto('./')
  await expect(page.getByRole('textbox', { name: chat.composerLabel, exact: true })).toBeVisible()
  await expect(lockHeading(page)).toHaveCount(0)
})
