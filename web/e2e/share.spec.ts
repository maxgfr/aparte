import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { media } from '../src/i18n/en/media.ts'
import { composer, createVault, lock, messageBox, unlock } from './fixtures/chat-ui.ts'
import { PNG_BASE64 } from './fixtures/media.ts'
import { dumpStorage, plaintextHits } from './fixtures/storage.ts'
import { accessible, expect, test } from './gates.ts'

/*
 * The share target (spec/FORMAT.md section 16), simulated as the operating system does it: a multipart POST to
 * `<base>share` that the service worker answers. While the vault is locked, the share is sealed to the inbox key as
 * it arrives: the plaintext canary (in the text and inside the photo's bytes) must appear nowhere on the device. Once
 * unlocked, the share opens and becomes the draft of a new chat. Without a vault, the share is refused and the worker
 * creates no database. Chromium only: it is the engine that implements the Web Share Target.
 */

const canary = (what: string) => `canary-${what}-${randomUUID()}`

test.beforeEach(({ browserName }) => {
  test.skip(browserName !== 'chromium', 'The Web Share Target is a Chromium feature')
})

/** Waits until the service worker is active and controls the page (one reload when it did not claim it). */
async function waitForController(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  const controlled = await page.evaluate(
    () =>
      navigator.serviceWorker.controller !== null ||
      new Promise<boolean>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(true), { once: true })
        setTimeout(() => resolve(navigator.serviceWorker.controller !== null), 5_000)
      }),
  )
  if (!controlled) await page.reload()
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
}

/** Shares `text` and a photo whose bytes carry `marker`, as another app would, through the service worker. */
async function share(page: Page, text: string, marker: string): Promise<number> {
  return page.evaluate(
    async ({ text, marker, png }) => {
      const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0))
      // Bytes after the PNG's end are ignored by decoders: the marker rides along with the photo.
      const photo = new File([bytes, new TextEncoder().encode(marker)], 'shared.png', { type: 'image/png' })
      const form = new FormData()
      form.append('title', 'Shared title')
      form.append('text', text)
      form.append('files', photo)
      const res = await fetch('./share', { method: 'POST', body: form })
      return res.status
    },
    { text, marker, png: PNG_BASE64 },
  )
}

/** The items waiting in the inbox database, or null when the database does not exist. */
async function inboxCount(page: Page): Promise<number | null> {
  return page.evaluate(async () => {
    const names = (await indexedDB.databases()).map((d) => d.name)
    if (!names.includes('aparte-inbox-v1')) return null
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('aparte-inbox-v1')
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
    try {
      const store = db.transaction('items', 'readonly').objectStore('items')
      return await new Promise<number>((resolve, reject) => {
        const r = store.count()
        r.onsuccess = () => resolve(r.result)
        r.onerror = () => reject(r.error)
      })
    } finally {
      db.close()
    }
  })
}

/** Whether this device's inbox key file exists (the page writes it once the vault is unlocked). */
async function hasInboxKey(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const names = (await indexedDB.databases()).map((d) => d.name)
    if (!names.includes('aparte-inbox-v1')) return false
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('aparte-inbox-v1')
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
    try {
      const store = db.transaction('key', 'readonly').objectStore('key')
      return await new Promise<boolean>((resolve, reject) => {
        const r = store.get('inbox-key')
        r.onsuccess = () => resolve(typeof r.result === 'string')
        r.onerror = () => reject(r.error)
      })
    } finally {
      db.close()
    }
  })
}

test('a share made while locked is stored sealed, then opens after unlock as a new chat', async ({ page }) => {
  test.setTimeout(240_000)
  const text = `Look at this ${canary('share-text')}`
  const marker = canary('share-photo')
  const passphrase = await createVault(page)
  await waitForController(page)
  await expect.poll(() => hasInboxKey(page), { timeout: 20_000 }).toBe(true)
  await lock(page)

  expect(await share(page, text, marker)).toBe(200)
  await expect.poll(() => inboxCount(page)).toBe(1)
  // Sealed as it arrived: neither the text nor the photo's bytes rest anywhere in clear.
  expect(plaintextHits(await dumpStorage(page), [text, marker])).toEqual([])

  await page.goto('./#/share?received=stored')
  await unlock(page, passphrase)
  await expect(page.getByRole('heading', { level: 1, name: media.shareTitle })).toBeVisible()
  await expect(page.getByText(media.receivedStored)).toBeVisible()
  const card = page.locator('[data-share]')
  await expect(card).toHaveCount(1)
  await expect(card).toContainText(text)
  await expect(card.getByRole('img', { name: 'shared.png' })).toBeVisible()
  await accessible(page, 'share inbox')

  await card.getByRole('button', { name: media.shareStart, exact: true }).click()
  await expect(messageBox(page)).toHaveValue(`Shared title\n\n${text}`)
  await expect(composer(page).getByRole('img')).toHaveCount(1, { timeout: 20_000 })
  await expect.poll(() => inboxCount(page)).toBe(0)
  // Taken into the draft in memory; the photo was prepared and stored encrypted, the text is stored nowhere yet.
  expect(plaintextHits(await dumpStorage(page), [text, marker])).toEqual([])
})

test('a share another page sends while the app is open is announced, never acted on', async ({ page }) => {
  test.setTimeout(180_000)
  await createVault(page)
  await waitForController(page)
  await expect.poll(() => hasInboxKey(page), { timeout: 20_000 }).toBe(true)
  const text = `Unexpected ${canary('share-open')}`
  expect(await share(page, text, canary('photo'))).toBe(200)
  await expect(page.getByText(media.shareArrived)).toBeVisible()
  await page.getByRole('button', { name: media.shareReview, exact: true }).click()
  await expect(page.locator('[data-share]')).toContainText(text)
  await page.getByRole('button', { name: media.shareDiscard, exact: true }).click()
  await expect(page.getByText(media.shareEmpty)).toBeVisible()
  await expect.poll(() => inboxCount(page)).toBe(0)
})

test('without a vault, a share is refused and the worker creates nothing', async ({ page }) => {
  await page.goto('./')
  await waitForController(page)
  expect(await share(page, `Nowhere ${canary('no-vault')}`, canary('no-vault-photo'))).toBe(200)
  expect(await inboxCount(page)).toBeNull()
  await page.goto('./#/share?received=no-key')
  await expect(page.getByText(media.receivedNoKey)).toBeVisible()
})
