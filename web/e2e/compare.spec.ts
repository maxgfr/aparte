import type { Locator, Page } from '@playwright/test'
import { chat } from '../src/i18n/en/chat.ts'
import { compare } from '../src/i18n/en/compare.ts'
import { shell } from '../src/i18n/en/shell.ts'
import { stats } from '../src/i18n/en/stats.ts'
import { ANSWER_WAIT, answers, branchOf, composer, content, send, settled, startChat } from './fixtures/chat-ui.ts'
import { anthropicText } from './fixtures/sse.ts'
import { expect, test } from './fixtures/test.ts'
import { accessible } from './gates.ts'

/*
 * Comparing models from the user's side, against the providers the test plays: Beam sends one message to two models
 * at once and keeps one answer or merges them; the Arena asks two models blind, records the vote and ranks them; the
 * Usage screen draws what the answers reported. Both models come from one mocked Anthropic provider, whose answers
 * are served in the order the requests arrive, so the specs check what each request asked for, not which answer
 * went where.
 */

test.use({ netPurposes: ['provider'] })

const CLAUDE = { kind: 'anthropic', model: 'claude-opus-5-5' } as const
const KEY = 'sk-ant-api03-e2e-compare-placeholder'
const candidates = (page: Page) => page.locator('[data-candidate]')

/** Opens the composer's Beam sheet and switches on every model it offers (two here). */
async function beamOn(page: Page): Promise<void> {
  await composer(page)
    .getByRole('button', { name: new RegExp(`^${compare.beamButton}`) })
    .click()
  const sheet = page.getByRole('dialog', { name: compare.beamSheetTitle })
  const switches = sheet.getByRole('switch')
  await expect(switches).toHaveCount(2)
  for (const s of await switches.all()) await s.check()
  await sheet.getByRole('button', { name: chat.done, exact: true }).click()
  await expect(sheet).toBeHidden()
  await expect(composer(page).getByRole('button', { name: compare.beamButtonOn.replace('{count}', '2') })).toBeVisible()
}

/** Opens a screen of the More hub. */
async function openMore(page: Page, row: string): Promise<void> {
  await page.getByRole('navigation').getByRole('link', { name: shell.navMore, exact: true }).first().click()
  await page.getByRole('link', { name: new RegExp(`^${row}`) }).click()
}

const done = async (cards: Locator) => {
  for (const c of await cards.all()) await expect(c).not.toHaveAttribute('data-status', 'streaming', ANSWER_WAIT)
}

test('Beam: one message, two models side by side, keep one, then merge', async ({ page, providers }) => {
  test.setTimeout(180_000)
  await startChat(page, providers, { ...CLAUDE, key: KEY })
  await beamOn(page)

  providers.serve('anthropic', anthropicText(['Paris is the capital.']), anthropicText(['It is Paris.']))
  await send(page, 'Capital of France?')
  await expect(candidates(page)).toHaveCount(2)
  await done(candidates(page))
  const calls = await providers.waitForGenerations('anthropic', 2)
  // One request per model, each the plain question: nothing else of the other answer leaks in.
  expect(new Set(calls.map((c) => (c.body as { model: string }).model))).toEqual(
    new Set(['claude-opus-5-5', 'claude-haiku-5-5']),
  )
  for (const c of calls) expect(JSON.stringify((c.body as { messages: unknown }).messages)).not.toContain('It is Paris')
  const texts = (await page.locator('[data-candidate-content]').allInnerTexts()).map((x) => x.trim()).sort()
  expect(texts).toEqual(['It is Paris.', 'Paris is the capital.'])
  await accessible(page, 'beam comparison')

  // Keep the second: the comparison closes and the kept answer is version 2 of 2.
  const second = candidates(page).nth(1)
  const kept = (await second.locator('[data-candidate-content]').innerText()).trim()
  await second.getByRole('button', { name: compare.beamKeep }).click()
  await expect(candidates(page)).toHaveCount(0)
  await expect(content(answers(page).last())).toHaveText(kept)
  expect(await branchOf(answers(page).last())).toMatch(/^[12]\/2$/)

  // A second beam, merged by one of the models: the merge request carries both answers, the merged one is kept.
  providers.serve(
    'anthropic',
    anthropicText(['Lyon has the traboules.']),
    anthropicText(['Lyon, for its food.']),
    anthropicText(['Lyon: food and traboules.']),
  )
  await send(page, 'And a second city?')
  await expect(candidates(page)).toHaveCount(2)
  await done(candidates(page))
  await page.getByRole('button', { name: compare.beamMerge, exact: true }).click()
  const merged = page.getByRole('article', { name: compare.beamMerged })
  await expect(merged).toHaveAttribute('data-status', 'done', ANSWER_WAIT)
  const mergeBody = JSON.stringify(providers.lastBody('anthropic'))
  expect(mergeBody).toContain('Lyon has the traboules.')
  expect(mergeBody).toContain('Lyon, for its food.')
  await merged.getByRole('button', { name: compare.beamKeep }).click()
  await expect(content(await settled(page))).toHaveText('Lyon: food and traboules.')
  expect(await branchOf(answers(page).last())).toBe('3/3')
})

test('Arena: two blind answers, a vote, the leaderboard; Usage draws the tokens', async ({ page, providers }) => {
  test.setTimeout(180_000)
  await startChat(page, providers, { ...CLAUDE, key: KEY })
  await openMore(page, shell.moreArena)
  await expect(page.getByRole('heading', { level: 1, name: compare.arenaTitle })).toBeVisible()
  await expect(page.getByText(compare.arenaLeaderboardEmpty)).toBeVisible()
  await accessible(page, 'arena')

  providers.serve('anthropic', anthropicText(['First answer.']), anthropicText(['Second answer.']))
  await page.getByLabel(compare.arenaPrompt).fill('Name a colour.')
  await page.getByRole('button', { name: compare.arenaSend }).click()
  await expect(candidates(page)).toHaveCount(2)
  await done(candidates(page))
  // Blind: the cards are numbered, never named.
  await expect(page.getByRole('article', { name: compare.beamAnswerNumber.replace('{index}', '1') })).toBeVisible()
  await expect(page.getByRole('article', { name: /Claude/ })).toHaveCount(0)
  await accessible(page, 'arena round')

  await page.getByRole('button', { name: compare.arenaVoteA }).click()
  await expect(page.getByText(/^Answer 1 was .+; answer 2 was .+\.$/)).toBeVisible()
  const rows = page.getByRole('table').getByRole('row')
  // The header and one row per model.
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(1).getByRole('cell').nth(1)).toHaveText('1,016')
  await expect(rows.nth(2).getByRole('cell').nth(1)).toHaveText('984')
  await accessible(page, 'arena leaderboard')

  // The usage of both answers is counted on this device.
  await page.getByRole('button', { name: compare.arenaNext }).click()
  await openMore(page, shell.moreStats)
  await expect(page.getByRole('heading', { level: 1, name: stats.title })).toBeVisible()
  await expect(page.getByRole('img', { name: /^Tokens per day/ })).toBeVisible(ANSWER_WAIT)
  // Two answers of 20 input and 1 output token each.
  await expect(page.getByText(stats.tileTokensDetail.replace('{input}', '40').replace('{output}', '2'))).toBeVisible()
  await page.getByRole('radio', { name: stats.groupModel }).check({ force: true })
  await expect(page.getByRole('table').first().getByRole('row')).toHaveCount(3)
  await accessible(page, 'usage')
})
