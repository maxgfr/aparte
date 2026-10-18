import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { type BaseLocale, createTranslator, loadCatalog, type Translate } from '../src/i18n/index.ts'
import { ANSWER_WAIT, ARGON2_WAIT } from './fixtures/chat-ui.ts'
import { anthropicText } from './fixtures/sse.ts'
import { expect, test } from './fixtures/test.ts'
import { accessible } from './gates.ts'

/*
 * The French and German interfaces on every project (phone and desktop widths): the main screens reached through
 * `?locale=`, from the first chat and the passphrase protection to a chat with a mocked answer, each one accessible
 * and with no control, tab or heading wider than its box, then the language picker of About, which switches in place
 * and is remembered across a reload. Controls are found by their translated name, read from the catalog under test.
 *
 * I18N_SHOTS=<folder> also saves a screenshot of each screen there (Chromium projects), for a look at the layout by eye.
 */

test.use({ netPurposes: ['provider'] })

const SHOTS = process.env.I18N_SHOTS

async function translator(locale: BaseLocale): Promise<Translate> {
  await Promise.all([loadCatalog('en'), loadCatalog(locale)])
  return createTranslator(locale)
}

/** Every visible control, tab and heading whose content is wider than its box, and a page wider than the screen. */
async function overflows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const found: string[] = []
    const root = document.documentElement
    if (root.scrollWidth > root.clientWidth + 1) found.push(`page ${root.scrollWidth} > ${root.clientWidth}`)
    const boxes = document.querySelectorAll<HTMLElement>(
      'button, [role="button"], [role="tab"], a, label, legend, h1, h2, h3, h4',
    )
    for (const el of boxes) {
      // Text for assistive tech only (global.css `.sr-only`) and elements not laid out have nothing to overflow.
      if (el.closest('.sr-only') || el.clientWidth <= 1 || el.getClientRects().length === 0) continue
      const style = getComputedStyle(el)
      // A box that ends its text with an ellipsis truncates on purpose (a chat title, a model id: user content).
      if (style.visibility === 'hidden' || style.textOverflow === 'ellipsis') continue
      if (el.scrollWidth > el.clientWidth + 1) {
        const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60)
        found.push(`${el.tagName.toLowerCase()} "${text}" ${el.scrollWidth} > ${el.clientWidth}`)
      }
    }
    return found
  })
}

/** Accessible, nothing overflowing, and a screenshot when asked for. */
async function check(page: Page, info: TestInfo, locale: BaseLocale, screen: string): Promise<void> {
  await accessible(page, `${locale} ${screen}`)
  expect(await overflows(page), `${locale} ${screen}: horizontal overflow`).toEqual([])
  // Chromium only: WebKit and Firefox take a screenshot by adding a style element, which the CSP gate reports.
  if (SHOTS && info.project.name.startsWith('chromium')) {
    mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: join(SHOTS, `${locale}-${info.project.name}-${screen}.png`), fullPage: true })
  }
}

const h1 = (page: Page, name: string) => page.getByRole('heading', { level: 1, name, exact: true })

/** A control named `name`, whether the app made it a link or a button. */
const control = (scope: Page | Locator, name: string) =>
  scope.getByRole('link', { name, exact: true }).or(scope.getByRole('button', { name, exact: true }))

/** Opens a screen of the unlocked app by its hash path, as a link would (no reload, the vault stays open). */
async function open(page: Page, path: string, title: string): Promise<void> {
  await page.evaluate((hash) => {
    location.hash = hash
  }, `#${path}`)
  await expect(h1(page, title)).toBeVisible()
}

/** `s` as a pattern; any space matches any space (accessible names turn the no-break spaces of French into spaces). */
const literal = (s: string) => s.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&').replace(/\s/g, '\\s')

/** A message whose `{name}` placeholders were left unfilled, as a pattern matching any value in their place. */
const pattern = (message: string) => new RegExp(`^${literal(message).replace(/\\\{\w+\\\}/g, '.+')}$`)

for (const locale of ['fr', 'de'] as const) {
  test(`${locale}: the main screens are translated, accessible and fit the screen`, async ({
    page,
    providers,
  }, info) => {
    test.setTimeout(180_000)
    const t = await translator(locale)
    const key = `sk-ant-api03-i18n-${locale}`

    // The first launch, under the query override, lands in a chat; then the start screen.
    await page.goto(`./?locale=${locale}`)
    await expect(page.getByRole('textbox', { name: t('chat.composerLabel'), exact: true })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('lang', new RegExp(`^${locale}-`))
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
    await expect(page.getByText(t('vault.hintBody'))).toBeVisible()
    await check(page, info, locale, 'first chat')
    await open(page, '/', t('shell.welcomeTitle'))
    await check(page, info, locale, 'welcome')

    // Passphrase protection, from the settings.
    await open(page, '/protection', t('vault.protectionTitle'))
    await check(page, info, locale, 'protection')
    await open(page, '/sync', t('sync.title'))
    await expect(page.getByRole('heading', { level: 2, name: t('sync.needsPassphraseTitle') })).toBeVisible()
    await check(page, info, locale, 'sync without a passphrase')
    await open(page, '/protection', t('vault.protectionTitle'))
    await page.getByRole('link', { name: t('vault.protectAction'), exact: true }).click()
    await expect(h1(page, t('vault.protectTitle'))).toBeVisible()
    const passphrase = await page.getByLabel(t('vault.generatedLabel'), { exact: true }).inputValue()
    await check(page, info, locale, 'protect')
    await page.getByRole('button', { name: t('vault.protect'), exact: true }).click()
    await expect(h1(page, t('vault.kitTitle'))).toBeVisible(ARGON2_WAIT)
    await check(page, info, locale, 'kit')
    await page.getByLabel(t('vault.kitConfirm')).check()
    await page.getByRole('button', { name: t('vault.kitContinue'), exact: true }).click()
    await expect(control(page, t('chat.navNewChat')).first()).toBeVisible(ARGON2_WAIT)

    // Unlock: a reload locks the vault and keeps the language.
    await page.reload()
    await expect(page.getByLabel(t('vault.passphraseLabel'), { exact: true })).toBeVisible()
    await check(page, info, locale, 'unlock')
    await page.getByLabel(t('vault.passphraseLabel'), { exact: true }).fill(passphrase)
    await page.getByRole('button', { name: t('vault.unlock'), exact: true }).click()
    await expect(control(page, t('chat.navNewChat')).first()).toBeVisible(ARGON2_WAIT)

    // Providers: one added with its key, tested and its models listed.
    providers.expectKey('anthropic', key)
    await open(page, '/providers', t('chat.providersTitle'))
    await check(page, info, locale, 'providers')
    const add = control(page, t('chat.providersAdd')).first()
    if (await add.isVisible()) await add.click()
    await page
      .getByRole('link', { name: /^Anthropic(?:\s|$)/ })
      .or(page.getByRole('button', { name: /^Anthropic(?:\s|$)/ }))
      .first()
      .click()
    await page.getByLabel(t('chat.providerKey'), { exact: true }).fill(key)
    const create = page.getByRole('button', { name: t('chat.providerCreate'), exact: true })
    if (await create.isVisible()) await create.click()
    const save = page.getByRole('button', { name: t('chat.providerKeySave'), exact: true })
    if ((await save.isVisible()) && (await save.isEnabled())) await save.click()
    await expect(
      page
        .getByText(t('chat.providerKeyStored'))
        .or(page.getByText(t('chat.providerKeySaved')))
        .first(),
    ).toBeVisible()
    await page.getByRole('button', { name: t('chat.providerTest'), exact: true }).click()
    await expect(
      page.getByText(pattern(t('chat.providerTestOk'))).or(page.getByText(pattern(t('chat.providerTestOkModels')))),
    ).toBeVisible(ANSWER_WAIT)
    await page.getByRole('button', { name: t('chat.providerModelsRefresh'), exact: true }).click()
    await expect(page.getByText(pattern(t('chat.providerModelsRefreshed')))).toBeVisible(ANSWER_WAIT)
    await check(page, info, locale, 'provider')

    // A chat with a mocked answer.
    await control(page.getByRole('navigation').or(page.getByRole('banner')), t('chat.navNewChat'))
      .first()
      .click()
    const composer = page.getByRole('region', { name: t('chat.composerLabel'), exact: true })
    const box = composer.getByRole('textbox', { name: t('chat.composerLabel'), exact: true })
    await expect(box).toBeVisible()
    await composer
      .getByRole('button', { name: new RegExp(`^${literal(t('chat.modelChipLabel', { model: '' }))}`) })
      .click()
    const sheet = page.getByRole('dialog', { name: t('chat.modelPick') })
    await sheet.getByRole('searchbox', { name: t('chat.modelSearch') }).fill('claude-opus-5-5')
    await sheet.locator('ul button').first().click()
    await expect(sheet).toBeHidden()
    providers.serve('anthropic', anthropicText(['**Paris** est la capitale.']))
    await box.fill(locale === 'fr' ? 'Quelle est la capitale de la France ?' : 'Was ist die Hauptstadt Frankreichs?')
    await composer.getByRole('button', { name: t('chat.send'), exact: true }).click()
    const answer = page.locator('[data-message][data-role="assistant"]').last()
    await expect(answer).toHaveAttribute('data-status', 'done', ANSWER_WAIT)
    await expect(answer.locator('[aria-busy="true"]')).toHaveCount(0, ANSWER_WAIT)
    await check(page, info, locale, 'chat')

    // The other screens.
    await open(page, '/sync', t('sync.title'))
    await check(page, info, locale, 'sync')
    await open(page, '/more', t('shell.moreTitle'))
    await check(page, info, locale, 'more')
    await open(page, '/knowledge', t('knowledge.title'))
    await check(page, info, locale, 'knowledge')
    await open(page, '/mcp', t('mcp.title'))
    await check(page, info, locale, 'mcp')
    await open(page, '/protection', t('vault.protectionTitle'))
    await check(page, info, locale, 'protection with a passphrase')
    await open(page, '/about', t('about.title'))
    await check(page, info, locale, 'about')
  })
}

test('the language picker switches in place and is remembered across a reload', async ({ page }) => {
  const [en, fr, de] = await Promise.all([translator('en'), translator('fr'), translator('de')])
  await page.goto('./#/about')
  await expect(h1(page, en('about.title'))).toBeVisible()
  const picker = (t: Translate) => page.getByRole('group', { name: t('about.language'), exact: true })

  // Each language is named in itself, the same whatever the interface language.
  await expect(picker(en).getByText('Français', { exact: true })).toHaveAttribute('lang', 'fr')
  await picker(en).getByRole('radio', { name: 'Français', exact: true }).click()
  await expect(h1(page, fr('about.title'))).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', /^fr-/)
  await expect(picker(fr).getByRole('radio', { name: 'Français' })).toBeChecked()

  await page.reload()
  await expect(h1(page, fr('about.title'))).toBeVisible()
  await picker(fr).getByRole('radio', { name: 'Deutsch', exact: true }).click()
  await expect(h1(page, de('about.title'))).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', /^de-/)
  await accessible(page, 'about in German')

  await page.reload()
  await expect(h1(page, de('about.title'))).toBeVisible()
  // Back to the device language (English on the test devices), which is stored as no preference at all.
  await picker(de)
    .getByRole('radio', { name: de('about.languageSystem'), exact: true })
    .click()
  await expect(h1(page, en('about.title'))).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('aparte:locale'))).toBeNull()
  await page.reload()
  await expect(h1(page, en('about.title'))).toBeVisible()
})
