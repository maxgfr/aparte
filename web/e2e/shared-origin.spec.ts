import type { BrowserContext, FrameLocator, Page } from '@playwright/test'
import { chat } from '../src/i18n/en/chat.ts'
import { common } from '../src/i18n/en/common.ts'
import { vault } from '../src/i18n/en/vault.ts'
import { REFUSAL } from '../src/security/frame.ts'
import {
  ARGON2_WAIT,
  confirmKit,
  createVault,
  lock,
  openApp,
  openProtect,
  protectFromSettings,
  unlock,
} from './fixtures/chat-ui.ts'
import { dumpStorage, plaintextHits } from './fixtures/storage.ts'
import { expect, type Gates, test } from './gates.ts'

/*
 * The shared origin. maxgfr.github.io serves every GitHub Pages site of the account, so a page under another path
 * (here `/evil/`, served by the test on the app's own origin) shares Aparté's IndexedDB, CacheStorage, service worker
 * registrations and BroadcastChannels. These tests play that page and check each defence the app has against it
 * (docs/security-model.md, "Shared origin"):
 *
 * - what it reads from the app's storage is ciphertext;
 * - while no passphrase protects the vault, it can use the device slot key to unwrap the master key (documented, not
 *   defended: the key cannot be exported, and the passphrase protection removes it); once a passphrase protects the
 *   vault it finds no such key, and a device slot it plants opens nothing;
 * - what it plants in the app's precache is never served;
 * - a window it opens on the app is cut off from it once the service worker controls the app (COOP), even when it
 *   sets the window's opener to null;
 * - it cannot frame the app: `frame-ancestors 'none'` while the worker controls the app, the in-page refusal when it
 *   does not, even when the framing page replaced the frame's `self`;
 * - unregistering the worker costs the app its headers until the next visit registers it again;
 * - a pending-kit marker it writes into localStorage does not make the next unlock retire the recovery key;
 * - it finds no passkey to trigger: the shared-origin build never calls WebAuthn.
 *
 * What it can still do (delete the data, unregister the worker and then script a window it opens, phish on the same
 * origin) is listed in docs/security-model.md; only a dedicated origin removes it.
 */

/** The path the build is served under. */
const BASE = process.env.VITE_BASE ?? '/aparte/'

/** A marker no build file contains: finding it in what the app serves means a planted entry was served. */
const PLANTED = 'planted-by-a-sibling-site'

/** How each engine logs a frame `frame-ancestors` refused (Firefox reports it as the worker's failed response). */
const FRAME_REFUSED = /frame-ancestors|ServiceWorker intercepted the request/

/** Serves a bare page at `<origin>/evil/` from the test: another site of the shared origin. */
async function siblingPage(context: BrowserContext, origin: string): Promise<Page> {
  const url = `${origin}/evil/`
  await context.route(url, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Sibling site</title><p>Sibling</p>' }),
  )
  const page = await context.newPage()
  await page.goto(url)
  return page
}

/** The composer of the home's new chat: on screen only once the app runs, its vault open. */
const homeComposer = (scope: Page | FrameLocator) =>
  scope.getByRole('textbox', { name: chat.composerLabel, exact: true })

/** The home, named in the hash: a new chat, its composer ready once the vault this device made is open. */
async function openHome(page: Page) {
  await page.goto('./#/')
  await expect(homeComposer(page)).toBeVisible()
}

/** Waits until this app's service worker controls the page (as e2e/shell.spec.ts does). */
async function waitForController(page: Page) {
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

/** Unregisters, from the sibling page, every service worker registration of the app's scope; returns how many. */
function unregisterApp(sibling: Page, scope: string): Promise<number> {
  return sibling.evaluate(async (scope) => {
    const mine = (await navigator.serviceWorker.getRegistrations()).filter((r) => r.scope === scope)
    await Promise.all(mine.map((r) => r.unregister()))
    return mine.length
  }, scope)
}

/** Frames the app from the sibling page, in place of any frame it had. */
async function frameApp(sibling: Page, app: string): Promise<void> {
  await sibling.evaluate((src) => {
    for (const old of document.querySelectorAll('iframe')) old.remove()
    const frame = document.createElement('iframe')
    frame.title = 'Framed app'
    frame.src = src
    document.body.append(frame)
  }, app)
}

/**
 * Expects the frame-ancestors refusal, as the browser reports it: a console error, and no document of the app in the
 * frame (the frame is left on an error page, which Firefox does not let a test look into, so its URL is what is read).
 */
async function expectFrameRefused(sibling: Page, gates: Gates, before: number): Promise<void> {
  await expect.poll(() => gates.consoleErrors.slice(before).some((m) => FRAME_REFUSED.test(m))).toBe(true)
  const frames = sibling.frames().filter((f) => f !== sibling.mainFrame())
  expect(frames).toHaveLength(1)
  for (const frame of frames) expect(frame.isDetached()).toBe(false)
}

test('a sibling page reads the app storage and finds only ciphertext', async ({ page, context, baseURL }) => {
  test.setTimeout(120_000)
  const passphrase = await createVault(page)
  const sibling = await siblingPage(context, new URL(baseURL ?? '').origin)
  const stored = await dumpStorage(sibling)
  // The sibling sees the app's database (IndexedDB is per origin, not per path): the check below is not vacuous.
  expect(stored.some((s) => s.where.startsWith('indexedDB ') && s.text.length > 0)).toBe(true)
  expect(plaintextHits(stored, [passphrase])).toEqual([])
})

test('an entry a sibling page plants in the precache is never served', async ({
  page,
  context,
  baseURL,
  browserName,
}) => {
  const origin = new URL(baseURL ?? '').origin
  await openHome(page)
  await waitForController(page)
  const sibling = await siblingPage(context, origin)
  const planted = await sibling.evaluate(
    async ({ scope, marker }) => {
      const name = (await caches.keys()).find((n) => n.includes('precache') && n.endsWith(scope))
      if (!name) return []
      const cache = await caches.open(name)
      const urls: string[] = []
      for (const request of await cache.keys()) {
        const path = new URL(request.url).pathname
        const html = path.endsWith('.html')
        if (!html && !path.endsWith('.js')) continue
        const body = html
          ? `<!doctype html><title>${marker}</title><h1>${marker}</h1>`
          : `document.title = ${JSON.stringify(marker)}`
        const type = html ? 'text/html' : 'text/javascript'
        await cache.put(request, new Response(body, { headers: { 'Content-Type': type } }))
        urls.push(request.url)
      }
      return urls
    },
    { scope: `${origin}${BASE}`, marker: PLANTED },
  )
  // The shell and its scripts were all overwritten.
  const shellKey = planted.find((u) => new URL(u).pathname === `${BASE}index.html`)
  expect(shellKey).toBeDefined()
  expect(planted.filter((u) => new URL(u).pathname.endsWith('.js')).length).toBeGreaterThan(0)

  const response = await page.reload()
  await expect(homeComposer(page)).toBeVisible()
  // Playwright tells a response the worker made from one the network sent in Chromium only.
  if (browserName === 'chromium') expect(response?.fromServiceWorker()).toBe(true)
  expect(await page.title()).not.toContain(PLANTED)
  expect(await page.content()).not.toContain(PLANTED)
  // The worker put the verified shell back in place of the planted one.
  await expect
    .poll(() =>
      sibling.evaluate(async (url) => {
        const name = (await caches.keys()).find((n) => n.includes('precache'))
        const hit = name ? await (await caches.open(name)).match(url) : undefined
        return hit ? hit.text() : null
      }, shellKey ?? ''),
    )
    .toContain('<div id="root">')
})

test('a window a sibling page opens on the app is cut off from it, even with its opener set to null', async ({
  page,
  context,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? '').origin
  await openHome(page)
  await waitForController(page)
  const sibling = await siblingPage(context, origin)
  const opened = context.waitForEvent('page')
  await sibling.evaluate((app) => {
    const w = window.open(app)
    // Disowning keeps the handle and hides the opener from the app's own check: COOP is what has to cut it.
    if (w) w.opener = null
    ;(window as unknown as { opened: Window | null }).opened = w
  }, `${origin}${BASE}#/`)
  const popup = await opened
  // The app runs in the popup: served by its worker with Cross-Origin-Opener-Policy, it is in a context of its own.
  await expect(homeComposer(popup)).toBeVisible()
  await expect
    .poll(() => sibling.evaluate(() => (window as unknown as { opened: Window | null }).opened?.closed))
    .toBe(true)
  const reached = await sibling.evaluate(() => {
    const w = (window as unknown as { opened: Window | null }).opened
    try {
      return w?.document?.querySelector('h1')?.textContent ?? null
    } catch {
      return null
    }
  })
  expect(reached).toBeNull()
})

test('a sibling page cannot frame the app, with the service worker or without it', async ({
  page,
  context,
  baseURL,
  gates,
}) => {
  const origin = new URL(baseURL ?? '').origin
  const app = `${origin}${BASE}`
  gates.expectConsoleError(FRAME_REFUSED)
  // A framing page of the same origin may replace the frame's `self` before the app's script runs (it can reach into
  // a same-origin frame as soon as its document exists); the init script plays it winning that race.
  await context.addInitScript(() => {
    try {
      if (window.top !== window && window.top?.location.pathname.startsWith('/evil/'))
        (window as unknown as { self: unknown }).self = window.top
    } catch {
      // A cross-origin parent (the evil page's own frames never are): nothing to replace.
    }
  })
  await openHome(page)
  await waitForController(page)
  const sibling = await siblingPage(context, origin)

  // While the worker controls the app, its header policy says frame-ancestors 'none': the frame is refused outright.
  await frameApp(sibling, app)
  await expectFrameRefused(sibling, gates, 0)

  // Without the worker (the sibling unregistered it), the meta policy cannot refuse a frame; the page refuses itself.
  expect(await unregisterApp(sibling, app)).toBe(1)
  await frameApp(sibling, app)
  const framed = sibling.frameLocator('iframe')
  await expect(framed.getByRole('heading', { level: 1, name: REFUSAL.title })).toBeVisible()
  await expect(framed.getByText(REFUSAL.framed)).toBeVisible()
  await expect(framed.locator('#root')).toHaveCount(0)
})

test('a sibling page that unregisters the service worker costs the app its headers until the next visit', async ({
  page,
  context,
  baseURL,
  gates,
}) => {
  const origin = new URL(baseURL ?? '').origin
  const app = `${origin}${BASE}`
  gates.expectConsoleError(FRAME_REFUSED)
  await openHome(page)
  await waitForController(page)
  const sibling = await siblingPage(context, origin)
  expect(await unregisterApp(sibling, app)).toBe(1)

  // The next visit loads from the network with the meta policy, and registers the worker again.
  await page.reload()
  await expect(homeComposer(page)).toBeVisible()
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveCount(1)
  await waitForController(page)
  await expect
    .poll(() =>
      sibling.evaluate(
        async (scope) => (await navigator.serviceWorker.getRegistrations()).filter((r) => r.scope === scope).length,
        app,
      ),
    )
    .toBe(1)

  // And with it the header policy: a frame is refused again.
  const before = gates.consoleErrors.length
  await frameApp(sibling, app)
  await expectFrameRefused(sibling, gates, before)
})

test('the shared-origin build never asks for a passkey', async ({ page, context }) => {
  test.setTimeout(120_000)
  // A sibling site could make the browser use a passkey made for the shared origin; this build offers none.
  await context.addInitScript(() => {
    const calls: string[] = []
    ;(window as unknown as { webauthnCalls: string[] }).webauthnCalls = calls
    const credentials = navigator.credentials as CredentialsContainer | undefined
    if (!credentials) return
    for (const method of ['create', 'get'] as const) {
      const original = credentials[method].bind(credentials)
      Object.defineProperty(credentials, method, {
        configurable: true,
        value: (options?: CredentialCreationOptions & CredentialRequestOptions) => {
          calls.push(method)
          return original(options)
        },
      })
    }
  })
  const passphrase = await createVault(page)
  await lock(page)
  await unlock(page, passphrase)
  expect(await page.evaluate(() => (window as unknown as { webauthnCalls: string[] }).webauthnCalls)).toEqual([])
  await expect(page.getByText(/passkey/i)).toHaveCount(0)
})

/** The keyslot entries of the app's `meta` store, read from the sibling page, and the vault id. */
function keyslots(sibling: Page): Promise<{ vault: string; slots: string[] }> {
  return sibling.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('aparte-v1')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const store = db.transaction('meta', 'readonly').objectStore('meta')
          const keys = store.getAllKeys()
          const vault = store.get('vault')
          store.transaction.oncomplete = () => {
            db.close()
            resolve({
              vault: String(vault.result),
              slots: keys.result.map(String).filter((k) => k.startsWith('keyslot:')),
            })
          }
        }
      }),
  )
}

test('a pending-kit marker a sibling page plants does not retire the recovery key', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000)
  const passphrase = await createVault(page)
  await lock(page)
  const sibling = await siblingPage(context, new URL(baseURL ?? '').origin)
  const before = await keyslots(sibling)
  expect(before.slots).toHaveLength(2)
  // The marker of an earlier build, then one in the current shape with a proof the vault never made.
  for (const planted of [`create:${before.vault}`, `create:${before.vault}:${'A'.repeat(59)}`]) {
    await sibling.evaluate((value) => localStorage.setItem('aparte:kit-pending', value), planted)
    await unlock(page, passphrase)
    await expect(page.getByRole('heading', { level: 1, name: vault.kitTitle })).toHaveCount(0)
    expect((await keyslots(sibling)).slots).toEqual(before.slots)
    // A marker of the current shape is dropped once its proof failed; one of another shape is never even read.
    const left = await sibling.evaluate(() => localStorage.getItem('aparte:kit-pending'))
    expect(left).toBe(planted.split(':').length === 3 ? null : planted)
    await lock(page)
  }
})

test('a kit left unconfirmed is renewed at the next unlock', async ({ page, context, baseURL }) => {
  test.setTimeout(180_000)
  await openApp(page)
  await openProtect(page)
  const passphrase = await page.getByLabel(vault.generatedLabel, { exact: true }).inputValue()
  await page.getByRole('button', { name: vault.protect }).click()
  await expect(page.getByRole('heading', { level: 1, name: vault.kitTitle })).toBeVisible(ARGON2_WAIT)
  const sibling = await siblingPage(context, new URL(baseURL ?? '').origin)
  const before = await keyslots(sibling)
  // The tab goes away before the kit is confirmed.
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: common.appName, exact: true })).toBeVisible()
  await page.getByLabel(vault.passphraseLabel, { exact: true }).fill(passphrase)
  await page.getByRole('button', { name: vault.unlock, exact: true }).click()
  await expect(page.getByRole('heading', { level: 1, name: vault.kitTitle })).toBeVisible(ARGON2_WAIT)
  await expect(page.getByText(vault.kitRenewedLead)).toBeVisible()
  // The unconfirmed recovery slot was replaced by a new one; the passphrase slot is untouched.
  const after = await keyslots(sibling)
  expect(after.slots).toHaveLength(2)
  expect(after.slots.filter((s) => before.slots.includes(s))).toHaveLength(1)
})

/**
 * What the sibling page gets from the device slot of the app's `meta` store (spec/FORMAT.md section 17): whether it is
 * there, whether its key can be exported, and the length of what the key unwraps (the master key), or null.
 */
function useDeviceSlot(sibling: Page): Promise<{ found: boolean; exportable: boolean; unwrapped: number | null }> {
  return sibling.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('aparte-v1')
      open.onerror = () => reject(open.error)
      open.onsuccess = () => resolve(open.result)
    })
    const read = (key: string) =>
      new Promise<unknown>((resolve, reject) => {
        const r = db.transaction('meta', 'readonly').objectStore('meta').get(key)
        r.onsuccess = () => resolve(r.result)
        r.onerror = () => reject(r.error)
      })
    try {
      const [vault, slot, key] = [await read('vault'), await read('device-slot'), await read('device-slot-key')]
      if (!(key instanceof CryptoKey) || !(slot instanceof Uint8Array)) {
        return { found: false, exportable: false, unwrapped: null }
      }
      const exportable = await crypto.subtle.exportKey('raw', key).then(
        () => true,
        () => false,
      )
      const aad = new TextEncoder().encode(`aparte/1|device-slot|${String(vault)}`)
      const mk = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: slot.slice(0, 12), additionalData: aad },
        key,
        slot.slice(12),
      )
      return { found: true, exportable, unwrapped: mk.byteLength }
    } finally {
      db.close()
    }
  })
}

/** Writes, from the sibling page, a device slot of its own (its key, a master key it chose) for the app's vault. */
function plantDeviceSlot(sibling: Page): Promise<void> {
  return sibling.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('aparte-v1')
      open.onerror = () => reject(open.error)
      open.onsuccess = () => resolve(open.result)
    })
    try {
      const vault = await new Promise<unknown>((resolve, reject) => {
        const r = db.transaction('meta', 'readonly').objectStore('meta').get('vault')
        r.onsuccess = () => resolve(r.result)
        r.onerror = () => reject(r.error)
      })
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const aad = new TextEncoder().encode(`aparte/1|device-slot|${String(vault)}`)
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv, additionalData: aad },
          key,
          crypto.getRandomValues(new Uint8Array(32)),
        ),
      )
      const slot = new Uint8Array(60)
      slot.set(iv)
      slot.set(sealed, 12)
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('meta', 'readwrite')
        tx.objectStore('meta').put(slot, 'device-slot')
        tx.objectStore('meta').put(key, 'device-slot-key')
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  })
}

test('without a passphrase, a sibling page can use the device slot key to unwrap the master key, never export it', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(120_000)
  await openApp(page)
  const sibling = await siblingPage(context, new URL(baseURL ?? '').origin)
  // The gap docs/security-model.md states for a vault no passphrase protects: the key is usable from any page of the
  // origin. What rests on the disk is still ciphertext and a key object, never the key's bytes.
  expect(await useDeviceSlot(sibling)).toEqual({ found: true, exportable: false, unwrapped: 32 })
})

test('with a passphrase, a sibling page finds no device slot, and one it plants opens nothing', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000)
  await openApp(page)
  const { passphrase } = await protectFromSettings(page)
  await confirmKit(page)
  const sibling = await siblingPage(context, new URL(baseURL ?? '').origin)
  expect(await useDeviceSlot(sibling)).toEqual({ found: false, exportable: false, unwrapped: null })

  // A device slot the sibling makes for the app's vault would open the app without the passphrase, to a master key
  // the sibling knows, if the app used it: it does not while a passphrase slot exists, and the next unlock deletes it.
  await plantDeviceSlot(sibling)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1, name: common.appName, exact: true })).toBeVisible()
  await expect(page.getByLabel(vault.passphraseLabel, { exact: true })).toBeVisible()
  await expect(page.getByRole('navigation')).toHaveCount(0)
  await unlock(page, passphrase)
  expect(await useDeviceSlot(sibling)).toEqual({ found: false, exportable: false, unwrapped: null })
})
