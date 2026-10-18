import type { Page } from '@playwright/test'
import { chat } from '../src/i18n/en/chat.ts'
import { common } from '../src/i18n/en/common.ts'
import { shell } from '../src/i18n/en/shell.ts'
import { vault } from '../src/i18n/en/vault.ts'
import { createVault, openApp } from './fixtures/chat-ui.ts'
import { dumpStorage, plaintextHits } from './fixtures/storage.ts'
import { go } from './fixtures/transfer.ts'
import { accessible, expect, test } from './gates.ts'

/*
 * Erasing everything Aparté keeps on this device, on every project: from the lock screen for a user who lost the
 * passphrase and the recovery key, and from the settings. A wrong confirmation word erases nothing; the right one
 * erases the vault, the inbox, the preferences and Aparté's caches (the models only when asked), in every open tab,
 * and the app starts over as on a first launch. What another site of the shared origin keeps (a localStorage key, a
 * database, a cache) survives.
 */

const lockHeading = (page: Page) => page.getByRole('heading', { level: 1, name: common.appName, exact: true })
const composer = (page: Page) => page.getByRole('textbox', { name: chat.composerLabel, exact: true })
const sheet = (page: Page) => page.getByRole('dialog', { name: vault.eraseTitle })

/** The vault id this device holds, or null. */
function vaultId(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      new Promise<string | null>((resolve, reject) => {
        const open = indexedDB.open('aparte-v1')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          if (!db.objectStoreNames.contains('meta')) {
            db.close()
            resolve(null)
            return
          }
          const r = db.transaction('meta', 'readonly').objectStore('meta').get('vault')
          r.onsuccess = () => {
            db.close()
            resolve(typeof r.result === 'string' ? r.result : null)
          }
          r.onerror = () => reject(r.error)
        }
      }),
  )
}

/** The keys of the vault's `meta` store, sorted. */
function metaKeys(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('aparte-v1')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const r = db.transaction('meta', 'readonly').objectStore('meta').getAllKeys()
          r.onsuccess = () => {
            db.close()
            resolve(r.result.map(String).sort())
          }
          r.onerror = () => reject(r.error)
        }
      }),
  )
}

/** What the origin holds, by name: the IndexedDB databases, the caches and the localStorage keys. */
function names(page: Page): Promise<{ databases: string[]; caches: string[]; local: string[] }> {
  return page.evaluate(async () => {
    const local: string[] = []
    for (let i = 0; i < localStorage.length; i++) local.push(localStorage.key(i) ?? '')
    return {
      databases: (await indexedDB.databases()).map((d) => d.name ?? '').sort(),
      caches: (await caches.keys()).sort(),
      local: local.sort(),
    }
  })
}

/** Each precache of the page's origin, with the number of files it holds. */
function precached(page: Page): Promise<{ name: string; files: number }[]> {
  return page.evaluate(async () => {
    const out: { name: string; files: number }[] = []
    for (const name of (await caches.keys()).sort()) {
      if (name.includes('precache')) out.push({ name, files: (await (await caches.open(name)).keys()).length })
    }
    return out
  })
}

/** Plays another site of the origin and the app's own downloads: a key, a database and a cache of each. */
async function plant(page: Page): Promise<void> {
  await page.evaluate(async () => {
    localStorage.setItem('other-site:session', 'keep')
    localStorage.setItem('aparte:theme', 'dark')
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('other-site-db', 1)
      open.onupgradeneeded = () => open.result.createObjectStore('store')
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        open.result.close()
        resolve()
      }
    })
    for (const name of ['other-site-cache', 'aparte-webllm/model', 'aparte-runtime-v1']) {
      await (await caches.open(name)).put(new Request(`/planted/${encodeURIComponent(name)}`), new Response('public'))
    }
  })
}

/** Opens the erase sheet from the More tab. */
async function openEraseFromSettings(page: Page): Promise<void> {
  await go(page, shell.navMore)
  await page.getByRole('button', { name: vault.eraseTitle }).click()
  await expect(sheet(page)).toBeVisible()
}

/** Types `word` in the sheet and presses the destructive button when it can be pressed. */
async function confirmWith(page: Page, word: string): Promise<void> {
  await sheet(page).getByLabel(vault.eraseConfirmLabel.replace('{word}', vault.eraseWord), { exact: true }).fill(word)
}

test('a lost passphrase and recovery key: erasing from the lock screen, and only what is Aparté’s goes', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const passphrase = await createVault(page)
  const before = await vaultId(page)
  await plant(page)
  await page.reload()
  await expect(lockHeading(page)).toBeVisible()

  await page.getByRole('button', { name: vault.eraseLost, exact: true }).click()
  await expect(sheet(page)).toBeVisible()
  await expect(sheet(page).getByText(vault.eraseLostLead)).toBeVisible()
  await expect(sheet(page).getByText(vault.eraseSynced)).toBeVisible()
  await expect(sheet(page).getByLabel(vault.eraseModels)).not.toBeChecked()
  await accessible(page, 'erase from the lock screen')

  // A wrong word erases nothing, by the button or the return key.
  const erase = sheet(page).getByRole('button', { name: vault.eraseAction, exact: true })
  await confirmWith(page, `${vault.eraseWord}s`)
  await expect(erase).toBeDisabled()
  await sheet(page)
    .getByLabel(vault.eraseConfirmLabel.replace('{word}', vault.eraseWord), { exact: true })
    .press('Enter')
  await expect(sheet(page)).toBeVisible()
  expect(await vaultId(page)).toBe(before)

  await confirmWith(page, ` ${vault.eraseWord.toUpperCase()} `)
  await expect(erase).toBeEnabled()
  await erase.click()

  // The app starts over as on a first launch: a new vault, straight into the chat.
  await expect(composer(page)).toBeVisible({ timeout: 30_000 })
  await expect(lockHeading(page)).toHaveCount(0)
  await expect(page.getByTestId('protect-hint')).toBeVisible()
  await expect.poll(() => vaultId(page)).not.toBe(before)
  expect(await vaultId(page)).not.toBeNull()

  // Nothing of the old vault or its preferences remains; what is not Aparté's is all there.
  const after = await names(page)
  expect(after.local).toEqual(['other-site:session'])
  expect(after.databases).toContain('other-site-db')
  expect(after.caches).toContain('other-site-cache')
  // The models and runtimes stay unless the box is ticked.
  expect(after.caches).toContain('aparte-webllm/model')
  expect(after.caches).toContain('aparte-runtime-v1')
  expect(await page.evaluate(() => localStorage.getItem('other-site:session'))).toBe('keep')
  const stored = await dumpStorage(page)
  expect(plaintextHits(stored, [passphrase, before ?? 'no vault id'])).toEqual([])
  // The vault on the device is the new, empty one: a device slot, no keyslot of the erased vault.
  expect(await metaKeys(page)).toEqual(['device-slot', 'device-slot-key', 'fmt', 'vault'])
})

test('erasing from the settings, models included, starts every open tab over', async ({ page, context }) => {
  test.setTimeout(120_000)
  await openApp(page)
  const second = await context.newPage()
  await second.goto('./#/more')
  await expect(second.getByRole('heading', { level: 1, name: shell.moreTitle })).toBeVisible()
  const before = await vaultId(page)
  expect(await vaultId(second)).toBe(before)
  await plant(page)
  // The worker has installed the app precache (it is named after Workbox's `aparte` prefix, src/sw.ts).
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  await expect.poll(async () => (await precached(page)).length, { timeout: 30_000 }).toBeGreaterThan(0)
  const precache = await precached(page)

  await openEraseFromSettings(page)
  await expect(sheet(page).getByText(vault.eraseLostLead)).toHaveCount(0)
  await accessible(page, 'erase from the settings')
  await sheet(page).getByLabel(vault.eraseModels).check()
  const erase = sheet(page).getByRole('button', { name: vault.eraseAction, exact: true })
  await expect(erase).toBeDisabled()
  await confirmWith(page, vault.eraseWord)
  await erase.click()

  await expect(composer(page)).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => vaultId(page)).not.toBe(before)
  // The other tab dropped its keys and started over on the new vault, at the app's start.
  await expect(composer(second)).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => (await vaultId(second)) === (await vaultId(page))).toBe(true)
  expect(new URL(second.url()).hash).toBe('#/chat')

  const after = await names(page)
  expect(after.caches).not.toContain('aparte-webllm/model')
  expect(after.caches).not.toContain('aparte-runtime-v1')
  expect(after.caches).toContain('other-site-cache')
  // The app precache stays, whole: the app still opens offline. (A deleted one would come back with only the few
  // files the next page load fetched again, and none at all once the deployed build is newer than the worker.)
  expect(await precached(page)).toEqual(precache)
  expect(after.local).toEqual(['other-site:session'])
  expect(after.databases).toContain('other-site-db')
})
