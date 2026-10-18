import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { roleplay } from '../src/i18n/en/roleplay.ts'
import { shell } from '../src/i18n/en/shell.ts'
import { composer, content, newChat, send, settled, startChat, userMessages } from './fixtures/chat-ui.ts'
import { anthropicText } from './fixtures/sse.ts'
import { expect, test } from './fixtures/test.ts'
import { accessible } from './gates.ts'

/*
 * Roleplay from the user's side, against the Anthropic API the test plays: a character card imported on the
 * Characters screen, an entry added to its lorebook, a chat started with the character (its prompt is the request's
 * system prompt), lore injected into the request but never shown in the bubble, a quick reply, and a character switch
 * mid-chat sent as a system update while the opening system prompt stays as it was.
 */

test.use({ netPurposes: ['provider'] })

const CLAUDE = { kind: 'anthropic', model: 'claude-opus-5-5' } as const

const card = (name: string, description: string, book?: { name: string; trigger: string; content: string }) =>
  Buffer.from(
    JSON.stringify({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name,
        description,
        personality: 'Patient.',
        scenario: '{{user}} arrives in a storm.',
        first_mes: 'Come in, {{user}}.',
        mes_example: '',
        system_prompt: '',
        ...(book === undefined
          ? {}
          : {
              character_book: {
                name: book.name,
                entries: [{ keys: [book.trigger], content: book.content, enabled: true, insertion_order: 0 }],
              },
            }),
      },
    }),
  )

/** Opens the Characters screen from the More tab. */
async function openCharacters(page: Page): Promise<void> {
  const nav = page.getByRole('navigation')
  await nav.getByRole('link', { name: shell.navMore, exact: true }).first().click()
  await page.getByRole('link', { name: new RegExp(`^${shell.moreCharacters}`) }).click()
  await expect(page.getByRole('heading', { level: 1, name: roleplay.title })).toBeVisible()
}

async function importCard(page: Page, file: string, buffer: Buffer, toast: string): Promise<void> {
  await page.getByLabel(roleplay.importCard, { exact: true }).setInputFiles({
    name: file,
    mimeType: 'application/json',
    buffer,
  })
  await expect(page.getByText(toast).first()).toBeVisible()
}

/** The sent request as one string, for "does it carry this text anywhere". */
const wire = (body: Record<string, unknown>) => JSON.stringify(body)

test('characters, lorebooks, quick replies and a character switch', async ({ page, providers }) => {
  test.setTimeout(240_000)
  const lore = `The lamp burns whale oil. ${randomUUID()}`
  const harbour = `The harbour froze last winter. ${randomUUID()}`
  await startChat(page, providers, { ...CLAUDE, key: `sk-ant-api03-e2e-${randomUUID()}` })

  // Import two cards; the first brings a lorebook.
  await openCharacters(page)
  await accessible(page, 'characters, empty')
  await importCard(
    page,
    'mira.json',
    card('Mira', '{{char}} keeps the lighthouse.', { name: 'Coast', trigger: 'lighthouse', content: lore }),
    roleplay.importedWithLorebook.replace('{name}', 'Mira'),
  )
  await importCard(
    page,
    'bram.json',
    card('Bram', '{{char}} runs the ferry.'),
    roleplay.imported.replace('{name}', 'Bram'),
  )

  // A second entry, written in the lorebook editor.
  await page.getByRole('link', { name: /^Coast/ }).click()
  await page.getByRole('button', { name: roleplay.entryAdd, exact: true }).click()
  await page.getByLabel(roleplay.entryTriggers, { exact: true }).last().fill('harbour')
  await page.getByLabel(roleplay.entryContent, { exact: true }).last().fill(harbour)
  await page.getByRole('button', { name: roleplay.lorebookSave, exact: true }).click()
  await expect(page.getByText(roleplay.lorebookSaved).first()).toBeVisible()
  await accessible(page, 'lorebook editor')

  // A quick reply.
  await openCharacters(page)
  await page.getByLabel(roleplay.quickLabel, { exact: true }).fill('Wave')
  await page.getByLabel(roleplay.quickText, { exact: true }).fill('*waves from the door*')
  await page.getByRole('button', { name: roleplay.quickAdd, exact: true }).click()
  await expect(page.getByText('*waves from the door*')).toBeVisible()
  await accessible(page, 'characters, filled')

  // A new chat with Mira and her lorebook.
  await newChat(page, CLAUDE.model)
  await composer(page).getByRole('button', { name: roleplay.chatButton, exact: true }).click()
  const sheet = page.getByRole('dialog', { name: roleplay.chatSheet })
  await sheet.getByRole('radio', { name: 'Mira', exact: true }).check()
  await sheet.getByLabel(roleplay.chatUserName, { exact: true }).fill('Ana')
  await sheet.getByRole('switch', { name: 'Coast', exact: true }).check()
  await accessible(page, 'roleplay sheet')
  await sheet.getByRole('button', { name: roleplay.chatSave, exact: true }).click()
  await expect(sheet).toBeHidden()
  await expect(
    composer(page).getByRole('button', { name: roleplay.chatButtonWith.replace('{name}', 'Mira'), exact: true }),
  ).toBeVisible()

  providers.serve('anthropic', anthropicText(['The lamp is lit, Ana.']))
  await send(page, 'Is the lighthouse lit tonight?')
  await settled(page)
  let body = providers.lastBody('anthropic')
  const system = JSON.stringify(body.system)
  expect(system).toContain('Mira keeps the lighthouse.')
  expect(system).toContain('Ana arrives in a storm.')
  expect(wire(body)).toContain(lore)
  // The lore travels with the message but is not part of what the user wrote.
  await expect(content(userMessages(page).last())).toHaveText('Is the lighthouse lit tonight?')
  await expect(userMessages(page).last().getByText(roleplay.injectedSummary)).toBeVisible()
  await accessible(page, 'chat with a character')

  // A quick reply sends its text in one tap; the harbour entry triggers on the next mention.
  providers.serve('anthropic', anthropicText(['Mira waves back.']))
  const before = providers.generations('anthropic').length
  await page.getByRole('list', { name: roleplay.quickBar }).getByRole('button', { name: 'Wave' }).click()
  // The previous answer is settled already: wait for this turn's request and answer, not the last one on screen.
  await providers.waitForGenerations('anthropic', before + 1)
  await expect(content(userMessages(page).last())).toHaveText('*waves from the door*')
  await expect(content(await settled(page))).toHaveText('Mira waves back.')
  expect(wire(providers.lastBody('anthropic'))).toContain('*waves from the door*')

  providers.serve('anthropic', anthropicText(['It did.']))
  await send(page, 'Did the harbour freeze?')
  await expect(content(await settled(page))).toHaveText('It did.')
  expect(wire(providers.lastBody('anthropic'))).toContain(harbour)

  // Switching to Bram appends a system update; the opening system prompt is still sent.
  await composer(page)
    .getByRole('button', { name: roleplay.chatButtonWith.replace('{name}', 'Mira'), exact: true })
    .click()
  await sheet.getByRole('radio', { name: 'Bram', exact: true }).check()
  await sheet.getByRole('button', { name: roleplay.chatSave, exact: true }).click()
  await expect(sheet).toBeHidden()
  providers.serve('anthropic', anthropicText(['Bram here.']))
  await send(page, 'Who is at the ferry?')
  await expect(content(await settled(page))).toHaveText('Bram here.')
  body = providers.lastBody('anthropic')
  expect(JSON.stringify(body.system)).toContain('Mira keeps the lighthouse.')
  expect(wire(body)).toContain('Bram runs the ferry.')
})
