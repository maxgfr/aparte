import type { Locator, Page } from '@playwright/test'
import { chat } from '../../src/i18n/en/chat.ts'
import { common } from '../../src/i18n/en/common.ts'
import { shell } from '../../src/i18n/en/shell.ts'
import { tools } from '../../src/i18n/en/tools.ts'
import { vault } from '../../src/i18n/en/vault.ts'
import { expect } from '../gates.ts'
import { CUSTOM_BASE_URL, type MockKind, type ProviderMock } from './providers.ts'

/*
 * The chat screens as the specs drive them. Every lookup the chat specs make is in this file, so a change of markup
 * is one edit here and never a weaker spec. Controls are found the way a user finds them, by role and by their
 * English name (web/src/i18n/en/chat.ts). What a user only sees as styling is read from data attributes:
 *
 *   [data-message]           one per message of the current path, in order, with data-role (user | assistant |
 *                            system) and data-status (`streaming` while the answer streams, then done | stopped |
 *                            error | refused);
 *   [data-message-content]   inside it, the rendered text of the message (the sanitised Markdown of an answer),
 *                            apart from its reasoning, its refusal notice and its controls.
 *
 * Inside a message: the reasoning is a details element whose summary is "Reasoning"; the branch controls are the
 * "Previous version" and "Next version" buttons around the text "Version {index} of {count}"; "Regenerate" and
 * "Edit" may show on hover or focus only. A photo of a user message is an img.
 *
 * Tools (web/src/i18n/en/tools.ts): the composer's "Tools" button opens the "Tools" sheet of switches; a tool call is
 * a region named "Tool call: {name}" with data-tool-status (approval | running | done | failed | denied | refused |
 * skipped | pending); a call waiting for approval shows its arguments in full, the "Allow" radio group and the
 * "Allow" and "Decline" buttons; the sources of an answer are buttons in the region "Sources".
 */

export const ARGON2_WAIT = { timeout: 60_000 }
/** A mocked answer renders well within this; a stream that hangs fails here, not at the test timeout. */
export const ANSWER_WAIT = { timeout: 20_000 }

export type MessageStatus = 'streaming' | 'done' | 'stopped' | 'error' | 'refused'

const lockHeading = (page: Page) => page.getByRole('heading', { level: 1, name: common.appName, exact: true })

/** A control named `name`, whether the app made it a link or a button. */
const control = (scope: Page | Locator, name: string) =>
  scope.getByRole('link', { name, exact: true }).or(scope.getByRole('button', { name, exact: true }))

/** Clicks the navigation entry `name` ("New chat", "Models", "Chats"). */
async function navigate(page: Page, name: string): Promise<void> {
  await control(page.getByRole('navigation').or(page.getByRole('banner')), name)
    .first()
    .click()
}

/** Waits until the unlocked app is on screen. */
async function unlocked(page: Page): Promise<void> {
  await expect(lockHeading(page)).toHaveCount(0, ARGON2_WAIT)
  await expect(control(page, chat.navNewChat).first()).toBeVisible(ARGON2_WAIT)
}

/** Creates a vault with the generated passphrase, confirms the kit and returns the passphrase. */
export async function createVault(page: Page): Promise<string> {
  await page.goto('./')
  await expect(page.getByRole('heading', { level: 1, name: shell.welcomeTitle })).toBeVisible()
  await page.getByRole('link', { name: shell.welcomeCreateVault }).click()
  const passphrase = await page.getByLabel(vault.generatedLabel, { exact: true }).inputValue()
  await page.getByRole('button', { name: vault.create }).click()
  await expect(page.getByRole('heading', { level: 1, name: vault.kitTitle })).toBeVisible(ARGON2_WAIT)
  await page.getByLabel(vault.kitConfirm).check()
  await page.getByRole('button', { name: vault.kitContinue }).click()
  await unlocked(page)
  return passphrase
}

export async function lock(page: Page): Promise<void> {
  await page.getByRole('button', { name: vault.lock, exact: true }).click()
  await expect(lockHeading(page)).toBeVisible()
  // Locked means nothing of the conversation is left on screen.
  await expect(page.locator('[data-message]')).toHaveCount(0)
}

export async function unlock(page: Page, passphrase: string): Promise<void> {
  await expect(lockHeading(page)).toBeVisible()
  await page.getByLabel(vault.passphraseLabel, { exact: true }).fill(passphrase)
  await page.getByRole('button', { name: vault.unlock, exact: true }).click()
  await unlocked(page)
}

export interface ProviderSetup {
  readonly kind: MockKind
  readonly key: string
  /** The model the new chats use. */
  readonly model: string
}

/**
 * The name the Models screen shows for each mocked provider: the bundled catalog's provider name for a maker's own
 * API (web/src/core/ai/catalog.json), chat.providerCustom for a custom endpoint.
 */
const PRESET_NAMES: Record<MockKind, string> = {
  anthropic: 'Anthropic',
  google: 'Google',
  'openai-compatible': chat.providerCustom,
}

/** A provider entry of the Models screen: a link or button whose name starts with `name` (a subtitle may follow). */
const preset = (page: Page, name: string) => {
  const escaped = name.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')
  const starts = new RegExp(`^${escaped}(?:\\s|$)`)
  return page.getByRole('link', { name: starts }).or(page.getByRole('button', { name: starts }))
}

/** Adds a provider with its key from the Models screen, and checks the connection test passes. */
export async function addProvider(page: Page, providers: ProviderMock, setup: ProviderSetup): Promise<void> {
  providers.expectKey(setup.kind, setup.key)
  await navigate(page, chat.navProviders)
  await expect(page.getByRole('heading', { level: 1, name: chat.providersTitle })).toBeVisible()
  // The screen may list the presets at once, or behind an "Add a provider" control.
  const add = control(page, chat.providersAdd).first()
  if (await add.isVisible()) await add.click()
  await preset(page, PRESET_NAMES[setup.kind]).first().click()
  if (setup.kind === 'openai-compatible')
    await page.getByLabel(chat.providerBaseUrl, { exact: true }).fill(CUSTOM_BASE_URL)
  const keyField = page.getByLabel(chat.providerKey, { exact: true })
  await keyField.fill(setup.key)
  // The key is never shown once typed.
  await expect(keyField).toHaveAttribute('type', 'password')
  const create = page.getByRole('button', { name: chat.providerCreate, exact: true })
  if (await create.isVisible()) await create.click()
  const saveKey = page.getByRole('button', { name: chat.providerKeySave, exact: true })
  if ((await saveKey.isVisible()) && (await saveKey.isEnabled())) await saveKey.click()
  await expect(page.getByText(chat.providerKeyStored).or(page.getByText(chat.providerKeySaved)).first()).toBeVisible()
  await page.getByRole('button', { name: chat.providerTest, exact: true }).click()
  await expect(page.getByText(/^Connected\./).first()).toBeVisible(ANSWER_WAIT)
  // The models the server lists become the ones the picker offers (the catalog's may not include the mocked id).
  await page.getByRole('button', { name: chat.providerModelsRefresh, exact: true }).click()
  await expect(
    page.getByText(new RegExp(`^${chat.providerModelsRefreshed.replace('{count}', '\\d+').replace('.', '\\.')}$`)),
  ).toBeVisible(ANSWER_WAIT)
  // A connection test and a model refresh list the models and never generate.
  expect(providers.generations(setup.kind)).toHaveLength(0)
}

export const composer = (page: Page) => page.getByRole('region', { name: chat.composerLabel, exact: true })
export const messageBox = (page: Page) => composer(page).getByRole('textbox', { name: chat.composerLabel, exact: true })
export const stopButton = (page: Page) => composer(page).getByRole('button', { name: chat.stop, exact: true })
export const messages = (page: Page) => page.locator('[data-message]')
export const userMessages = (page: Page) => page.locator('[data-message][data-role="user"]')
export const answers = (page: Page) => page.locator('[data-message][data-role="assistant"]')
export const content = (message: Locator) => message.locator('[data-message-content]')
export const reasoningOf = (message: Locator) => message.locator('details').filter({ hasText: chat.reasoning })

/** Picks the model `id` in the composer's model sheet, searching for it by id. */
export async function chooseModel(page: Page, id: string): Promise<void> {
  await composer(page)
    .getByRole('button', { name: new RegExp(`^${chat.modelChipLabel.replace('{model}', '')}`) })
    .click()
  const sheet = page.getByRole('dialog', { name: chat.modelPick })
  await sheet.getByRole('searchbox', { name: chat.modelSearch }).fill(id)
  await sheet.locator('ul button').first().click()
  await expect(sheet).toBeHidden()
}

/** Opens a new chat on model `id`. */
export async function newChat(page: Page, id: string): Promise<void> {
  await navigate(page, chat.navNewChat)
  await expect(messageBox(page)).toBeVisible()
  await chooseModel(page, id)
}

/** Creates the vault, adds one provider and opens a new chat on its model; returns the passphrase. */
export async function startChat(page: Page, providers: ProviderMock, setup: ProviderSetup): Promise<string> {
  const passphrase = await createVault(page)
  await addProvider(page, providers, setup)
  await newChat(page, setup.model)
  return passphrase
}

/** Sets the effort of the chat (a level of web/src/core/contracts/ai.ts `Effort`). */
export async function setEffort(page: Page, effort: string): Promise<void> {
  // A chip named "Effort" or "Effort: <level>" opens a sheet of one radio button per level.
  await composer(page)
    .getByRole('button', { name: new RegExp(`^${chat.effortLabel}(?::|$)`) })
    .click()
  const sheet = page.getByRole('dialog', { name: chat.effortLabel })
  await sheet.locator(`input[type="radio"][value="${effort}"]`).check()
  await expect(sheet).toBeHidden()
}

/** Types `text` in the composer and sends it. */
export async function send(page: Page, text: string): Promise<void> {
  await messageBox(page).fill(text)
  await composer(page).getByRole('button', { name: chat.send, exact: true }).click()
  await expect(messageBox(page)).toHaveValue('')
}

/** Waits for the latest answer to reach `status` and returns it. */
export async function settled(page: Page, status: MessageStatus = 'done'): Promise<Locator> {
  const last = answers(page).last()
  await expect(last).toHaveAttribute('data-status', status, ANSWER_WAIT)
  // Settled means rendered for good too: no part of the answer is still being prepared (a code block waiting for
  // its highlighter is aria-busy).
  await expect(last.locator('[aria-busy="true"]')).toHaveCount(0, ANSWER_WAIT)
  return last
}

/** Clicks the control `name` of `message`, which may show on hover or focus only. */
export async function act(message: Locator, name: string): Promise<void> {
  await message.hover()
  await message.getByRole('button', { name, exact: true }).first().click()
}

export const regenerate = (message: Locator) => act(message, chat.regenerate)
export const previousVersion = (message: Locator) => act(message, chat.branchPrevious)
export const nextVersion = (message: Locator) => act(message, chat.branchNext)

const POSITION = new RegExp(`^${chat.branchPosition.replace('{index}', '(\\d+)').replace('{count}', '(\\d+)')}$`)

/** The branch position of `message` as "index/count", or null when it has no sibling. */
export async function branchOf(message: Locator): Promise<string | null> {
  const position = message.getByText(POSITION)
  if ((await position.count()) === 0) return null
  const match = POSITION.exec(((await position.first().textContent()) ?? '').trim())
  return match ? `${match[1]}/${match[2]}` : null
}

/** Edits user message `message` to `text` and sends it, which starts a new branch. */
export async function edit(message: Locator, text: string): Promise<void> {
  await act(message, chat.edit)
  await message.getByRole('textbox', { name: chat.editLabel, exact: true }).fill(text)
  await message.getByRole('button', { name: chat.editSend, exact: true }).click()
}

/** Attaches `bytes` as a photo named `name` in the composer and waits until it is prepared. */
export async function attachPhoto(page: Page, name: string, bytes: Buffer, mimeType = 'image/jpeg'): Promise<void> {
  await composer(page).locator('input[type="file"]:not([capture])').setInputFiles({ name, mimeType, buffer: bytes })
  // A photo shows as its thumbnail once prepared (a status line while it is being prepared).
  await expect(composer(page).getByRole('img')).toHaveCount(1, ANSWER_WAIT)
}

/** Opens the conversation whose title matches `title` from the conversation list. */
export async function openConversation(page: Page, title: RegExp): Promise<void> {
  await navigate(page, chat.navChats)
  await page
    .getByRole('link', { name: title })
    .or(page.getByRole('button', { name: title }))
    .first()
    .click()
  await expect(messages(page).first()).toBeVisible()
}

/** The composer's Tools control ("Tools" or "Tools: {count} on"). */
export const toolsButton = (page: Page) =>
  composer(page).getByRole('button', { name: new RegExp(`^${tools.button}(?::|$)`) })

/** Opens the Tools sheet of the chat and returns it. */
export async function openTools(page: Page): Promise<Locator> {
  await toolsButton(page).click()
  const sheet = page.getByRole('dialog', { name: tools.sheetTitle })
  await expect(sheet).toBeVisible()
  return sheet
}

/** Closes an open sheet with its Close button. */
export async function closeSheet(sheet: Locator): Promise<void> {
  await sheet.getByRole('button', { name: common.close, exact: true }).click()
  await expect(sheet).toBeHidden()
}

/** The switch named `label` in the Tools sheet. */
export const toolSwitch = (sheet: Locator, label: string) => sheet.getByRole('switch', { name: label, exact: true })

/** The card of the latest call of tool `title` (its display name). */
export const toolCard = (page: Page, title: string) =>
  page.getByRole('region', { name: tools.callLabel.replace('{name}', title), exact: true }).last()

/** Waits for the card of `title` to wait for approval and returns it. */
export async function awaitingApproval(page: Page, title: string): Promise<Locator> {
  const card = toolCard(page, title)
  await expect(card).toHaveAttribute('data-tool-status', 'approval', ANSWER_WAIT)
  return card
}

/** Allows the call of `card`, for the scope chosen by its label (this time only by default). */
export async function allowCall(card: Locator, scope: string = tools.rememberOnce): Promise<void> {
  await card.getByRole('radio', { name: scope, exact: true }).check()
  await card.getByRole('button', { name: tools.approve, exact: true }).click()
}

export async function declineCall(card: Locator): Promise<void> {
  await card.getByRole('button', { name: tools.deny, exact: true }).click()
}

/** The sources of an answer, as buttons. */
export const sourcesOf = (answer: Locator) =>
  answer.getByRole('region', { name: tools.sources, exact: true }).getByRole('button')
