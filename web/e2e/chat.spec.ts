import { randomUUID } from 'node:crypto'
import { about } from '../src/i18n/en/about.ts'
import { chat } from '../src/i18n/en/chat.ts'
import { shell } from '../src/i18n/en/shell.ts'
import {
  addProvider,
  answers,
  attachPhoto,
  branchOf,
  content,
  createVault,
  edit,
  lock,
  messages,
  navigate,
  newChat,
  nextVersion,
  openConversation,
  previousVersion,
  reasoningOf,
  regenerate,
  send,
  setEffort,
  settled,
  startChat,
  stopButton,
  unlock,
  userMessages,
} from './fixtures/chat-ui.ts'
import { canvasJpeg, decodedPayloads, EXIF_MARKER, isImage, withGpsExif } from './fixtures/exif.ts'
import { CUSTOM_BASE_URL } from './fixtures/providers.ts'
import { answerOf, anthropicText, openAIChunks, recorded } from './fixtures/sse.ts'
import { dumpStorage, plaintextHits } from './fixtures/storage.ts'
import { admitCustomEndpoint, expect, test } from './fixtures/test.ts'
import { accessible } from './gates.ts'

/*
 * The chat from the user's side, on every project, against providers the test plays (spec/sse): streaming, stop,
 * regenerate and edit as branches, persistence across a reload and a lock, the reasoning and refusal displays, the
 * effort parameter and the absence of sampling parameters on the wire, a photo's metadata kept off the wire and off
 * the disk. The requests are checked by the provider mock (fixtures/providers.ts) as well as by each test.
 *
 * WebKit does not route the requests of a page its service worker controls, so a spec sends nothing after a reload.
 */

test.use({ netPurposes: ['provider'] })

const CLAUDE = { kind: 'anthropic', model: 'claude-opus-5-5' } as const
/** Request fields that set sampling: Claude Opus 5.5 takes none of them. */
const SAMPLING = ['temperature', 'top_p', 'top_k']

/** A string that occurs nowhere in the app, so finding it on disk can only mean it was stored in plaintext. */
const canary = (what: string) => `canary-${what}-${randomUUID()}`

type AnthropicMessage = { role: string; content: string | { type: string; [k: string]: unknown }[] }

/**
 * The text blocks of the messages an Anthropic request carries, in order. Consecutive user turns may be merged into
 * one message, so the blocks are listed rather than the messages.
 */
function sentTexts(body: Record<string, unknown>): string[] {
  return (body.messages as AnthropicMessage[]).flatMap((m) =>
    typeof m.content === 'string'
      ? [m.content]
      : m.content.filter((c) => c.type === 'text').map((c) => c.text as string),
  )
}

/** The roles of the messages an Anthropic request carries, in order. */
const sentRoles = (body: Record<string, unknown>) => (body.messages as AnthropicMessage[]).map((m) => m.role)

test('send, stream, regenerate, edit and branch; the conversation survives a reload and a lock', async ({
  page,
  providers,
}) => {
  test.setTimeout(240_000)
  const key = `sk-ant-api03-${canary('key')}`
  const question = `What is the capital of France? ${canary('question')}`
  const passphrase = await startChat(page, providers, { ...CLAUDE, key })
  await accessible(page, 'new chat')

  // Send: the recorded answer streams in and renders as Markdown.
  const first = recorded('anthropic-text.sse')
  providers.serve('anthropic', answerOf(first))
  await send(page, question)
  const answer = await settled(page)
  await expect(content(answer).locator('strong')).toHaveText('Paris')
  await expect(content(answer)).toHaveText(first.expect.text.replaceAll('**', ''))
  let body = providers.lastBody('anthropic')
  expect(body.model).toBe(CLAUDE.model)
  expect(body.stream).toBe(true)
  expect(sentTexts(body)).toEqual([question])
  for (const field of SAMPLING) expect(field in body, `${field} sent to ${CLAUDE.model}`).toBe(false)
  await accessible(page, 'chat with an answer')

  // Regenerate: a sibling answer to the same question, sent without the first answer (no prefill, no rewrite).
  const answerCanary = canary('answer')
  const regenerated = `Paris, on the Seine. ${answerCanary}`
  providers.serve('anthropic', anthropicText(['Paris, on', ' the Seine. ', answerCanary]))
  await regenerate(answers(page).last())
  await expect(content(await settled(page))).toHaveText(regenerated)
  body = providers.lastBody('anthropic')
  expect(sentTexts(body)).toEqual([question])
  expect(await branchOf(answers(page).last())).toBe('2/2')
  await previousVersion(answers(page).last())
  await expect(content(answers(page).last())).toHaveText(first.expect.text.replaceAll('**', ''))
  expect(await branchOf(answers(page).last())).toBe('1/2')
  await nextVersion(answers(page).last())
  await expect(content(answers(page).last())).toHaveText(regenerated)

  // Edit: the edited question is a new branch of the conversation, sent alone.
  const edited = `And of Italy? ${canary('edited')}`
  providers.serve('anthropic', anthropicText(['The capital', ' of Italy is **Rome**.']))
  await edit(userMessages(page).first(), edited)
  await expect(content(await settled(page)).locator('strong')).toHaveText('Rome')
  expect(sentTexts(providers.lastBody('anthropic'))).toEqual([edited])
  await expect(userMessages(page)).toHaveCount(1)
  expect(await branchOf(userMessages(page).first())).toBe('2/2')
  // The first branch is still there, with its own two answers.
  await previousVersion(userMessages(page).first())
  await expect(content(userMessages(page).first())).toHaveText(question)
  expect(await branchOf(answers(page).last())).toMatch(/^[12]\/2$/)
  await nextVersion(userMessages(page).first())
  await expect(content(userMessages(page).first())).toHaveText(edited)
  await expect(content(answers(page).last()).locator('strong')).toHaveText('Rome')
  await accessible(page, 'chat with branches')

  // Nothing of it is on the disk in plaintext: not the key, not a question, not an answer.
  const secrets = [key, question, edited, regenerated]
  expect(plaintextHits(await dumpStorage(page), secrets)).toEqual([])

  // A reload forgets every key; unlocking brings the conversation back where it was left.
  await page.reload()
  await unlock(page, passphrase)
  await openConversation(page, /capital of France/)
  await expect(content(userMessages(page).first())).toHaveText(edited)
  await expect(content(answers(page).last()).locator('strong')).toHaveText('Rome')
  await previousVersion(userMessages(page).first())
  await expect(content(userMessages(page).first())).toHaveText(question)

  // So does a lock and an unlock, without a reload.
  await lock(page)
  await unlock(page, passphrase)
  await openConversation(page, /capital of France/)
  await expect(messages(page)).toHaveCount(2)
  await expect(content(answers(page).last())).not.toBeEmpty()
  expect(plaintextHits(await dumpStorage(page), secrets)).toEqual([])
  expect(providers.generations('anthropic')).toHaveLength(3)
})

test('a deleted chat waits in the trash, comes back from it, and is then deleted for good', async ({
  page,
  providers,
}) => {
  const question = `Throw this away ${randomUUID().slice(0, 8)}`
  await startChat(page, providers, { ...CLAUDE, key: 'sk-ant-api03-e2e-trash' })
  providers.serve('anthropic', anthropicText(['Thrown.']))
  await send(page, question)
  await settled(page)

  // The Chats screen's own list (the sidebar holds another one on wide screens).
  await navigate(page, chat.navChats)
  const list = page.locator('main')
  const row = list.getByRole('button', { name: new RegExp(question) })
  const sheet = page.getByRole('dialog')
  const trash = async () => {
    await row.click()
    await sheet.getByRole('button', { name: chat.delete, exact: true }).click()
    await expect(row).toHaveCount(0)
    await list.getByRole('button', { name: chat.listShowTrash, exact: true }).click()
  }

  await trash()
  await expect(row).toBeVisible()
  await accessible(page, 'the trash')
  await row.click()
  await sheet.getByRole('button', { name: chat.restore, exact: true }).click()
  await expect(list.getByText(chat.listTrashEmpty)).toBeVisible()
  await list.getByRole('button', { name: chat.listShowActive, exact: true }).click()
  await expect(list.getByRole('link', { name: new RegExp(question) })).toBeVisible()

  await trash()
  await row.click()
  await sheet.getByRole('button', { name: chat.purge, exact: true }).click()
  await expect(list.getByText(chat.listTrashEmpty)).toBeVisible()
  await list.getByRole('button', { name: chat.listShowActive, exact: true }).click()
  await expect(list.getByRole('link', { name: new RegExp(question) })).toHaveCount(0)
})

test('a custom OpenAI-compatible endpoint streams, and a stop keeps what had arrived', async ({
  page,
  providers,
  gates,
}) => {
  test.setTimeout(180_000)
  admitCustomEndpoint(gates)
  await startChat(page, providers, { kind: 'openai-compatible', model: 'llama-3.3-70b-versatile', key: 'gsk_e2e-key' })

  // The answer arrives a piece at a time: what has arrived shows while the rest is still coming.
  const pieces = ['Bonjour', ' means', ' hello', ' in French', ', and', ' bonsoir', ' means good evening.']
  const chunks = openAIChunks(pieces)
  // Message start and the first two pieces, then the server stalls with the stream open.
  providers.serve('openai-compatible', { chunks: chunks.slice(0, 3), delayMs: 150, hold: true })
  await send(page, 'What does bonjour mean?')
  const streaming = answers(page).last()
  await expect(streaming).toHaveAttribute('data-status', 'streaming')
  await expect(content(streaming)).toHaveText('Bonjour means')
  const [call] = await providers.waitForGenerations('openai-compatible', 1)
  expect(call?.url).toBe(`${CUSTOM_BASE_URL}/chat/completions`)
  expect(call?.body).toMatchObject({ stream: true })

  // Stop: the request is aborted and the partial answer is kept, marked as stopped.
  await stopButton(page).click()
  const stopped = await settled(page, 'stopped')
  await expect(content(stopped)).toHaveText('Bonjour means')
  await expect.poll(() => providers.served()[0]?.closedByClient, { timeout: 10_000 }).toBe(true)
  await expect(stopButton(page)).toHaveCount(0)

  // Regenerate after a stop streams a full sibling; the stopped answer is kept as the first branch.
  providers.serve('openai-compatible', { chunks, delayMs: 20 })
  await regenerate(stopped)
  await expect(content(await settled(page))).toHaveText(pieces.join(''))
  expect(await branchOf(answers(page).last())).toBe('2/2')
  const body = providers.lastBody('openai-compatible') as { messages: { role: string }[] }
  expect(body.messages.at(-1)?.role).toBe('user')
  await accessible(page, 'chat after a stop')
})

test('Gemini answers through its own streaming API', async ({ page, providers }) => {
  test.setTimeout(180_000)
  const gemini = recorded('gemini-text.sse')
  await startChat(page, providers, { kind: 'google', model: gemini.model, key: 'AIza-e2e-key' })
  providers.serve('google', answerOf(gemini))
  await send(page, 'A haiku about rain, please.')
  const answer = await settled(page)
  await expect(content(answer)).toContainText('Soft rain on the roof')
  await expect(content(answer)).toContainText('the street shines and sleeps.')
  const [call] = providers.generations('google')
  expect(call?.url).toBe(
    `https://generativelanguage.googleapis.com/v1beta/models/${gemini.model}:streamGenerateContent?alt=sse`,
  )
})

test('a reasoning block shows apart from the answer, and is replayed unchanged on the next turn', async ({
  page,
  providers,
}) => {
  test.setTimeout(180_000)
  const thinking = recorded('anthropic-thinking.sse')
  const block = thinking.expect.reasoning?.[0]
  if (!block) throw new Error('anthropic-thinking.sse has no reasoning block')
  await startChat(page, providers, { ...CLAUDE, key: 'sk-ant-e2e-reasoning' })
  providers.serve('anthropic', answerOf(thinking))
  await send(page, 'Is 1009 prime?')
  const answer = await settled(page)
  await expect(content(answer)).toHaveText(thinking.expect.text)
  const reasoning = reasoningOf(answer)
  await expect(reasoning).toHaveCount(1)
  // The reasoning is not part of the answer, and it opens to its full text.
  await expect(content(answer)).not.toContainText('Checking divisibility')
  if (!(await reasoning.evaluate((d) => (d as HTMLDetailsElement).open))) await reasoning.locator('summary').click()
  await expect(reasoning).toHaveJSProperty('open', true)
  await expect(reasoning).toContainText(block.text)
  await accessible(page, 'answer with reasoning')

  // Preserved thinking: the next request carries the thinking block, its signature byte for byte, before the text.
  providers.serve('anthropic', anthropicText(['And 1013 is prime too.']))
  await send(page, 'And 1013?')
  await settled(page)
  const turns = providers.lastBody('anthropic').messages as AnthropicMessage[]
  const replayed = turns[1]?.content
  if (!Array.isArray(replayed)) throw new Error('The answer was not replayed as content blocks')
  const signature = (block.providerMeta as { anthropic: { signature: string } }).anthropic.signature
  expect(replayed[0]).toEqual({ type: 'thinking', thinking: block.text, signature })
  expect(replayed[1]).toMatchObject({ type: 'text', text: thinking.expect.text })
})

test('a refusal shows why, keeps nothing of the partial answer and is left out of the next request', async ({
  page,
  providers,
}) => {
  test.setTimeout(180_000)
  const refusal = recorded('anthropic-refusal.sse')
  await startChat(page, providers, { ...CLAUDE, key: 'sk-ant-e2e-refusal' })
  providers.serve('anthropic', answerOf(refusal))
  await send(page, 'Write the payload.')
  const refused = await settled(page, 'refused')
  // "The model declined to answer", with or without its category.
  await expect(refused).toContainText(chat.refused.replace(/\.$/, ''))
  await expect(refused).not.toContainText('Here is how the first stage')
  await accessible(page, 'refused answer')

  providers.serve('anthropic', anthropicText(['Here is a safer idea.']))
  await send(page, 'Something else, then.')
  await settled(page)
  const body = providers.lastBody('anthropic')
  expect(sentTexts(body)).toEqual(['Write the payload.', 'Something else, then.'])
  expect(sentRoles(body)).not.toContain('assistant')
})

test('the effort selector sends the mapped parameter, and Claude gets no sampling parameter', async ({
  page,
  providers,
}) => {
  test.setTimeout(180_000)
  await startChat(page, providers, { ...CLAUDE, key: 'sk-ant-e2e-effort' })
  // Claude Opus 5.5 takes low to max with xhigh, as output_config.effort with summarized adaptive thinking.
  for (const effort of ['xhigh', 'low', 'max'] as const) {
    await setEffort(page, effort)
    providers.serve('anthropic', anthropicText([`Thought at ${effort}.`]))
    await send(page, `Think at ${effort}.`)
    await settled(page)
    const body = providers.lastBody('anthropic')
    expect(body.output_config).toEqual({ effort })
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
    for (const field of SAMPLING) expect(field in body, `${field} sent with effort ${effort}`).toBe(false)
  }
  // The effort is sent explicitly on every turn, never left to the provider's default.
  expect(providers.generations('anthropic').map((c) => (c.body as { output_config?: unknown }).output_config)).toEqual([
    { effort: 'xhigh' },
    { effort: 'low' },
    { effort: 'max' },
  ])
  await accessible(page, 'effort selector')
})

test('a photo with GPS EXIF reaches neither the provider nor the disk with its metadata', async ({
  page,
  providers,
}) => {
  test.setTimeout(180_000)
  const gps = canary('gps')
  await createVault(page)
  await addProvider(page, providers, { ...CLAUDE, key: 'sk-ant-e2e-photo' })
  await newChat(page, CLAUDE.model)
  const photo = withGpsExif(await canvasJpeg(page), gps)
  // The canary is really in the photo the user picks, as a camera writes it.
  expect(photo.includes(EXIF_MARKER)).toBe(true)
  expect(photo.includes(Buffer.from(gps, 'latin1'))).toBe(true)

  await attachPhoto(page, 'IMG_0001.jpg', photo)
  providers.serve('anthropic', anthropicText(['A green and sand gradient.']))
  await send(page, 'What is in this photo?')
  await settled(page)
  await expect(userMessages(page).last().getByRole('img')).toHaveCount(1)

  // The request carries the image, re-encoded: no EXIF segment, no GPS canary.
  const call = providers.generations('anthropic').at(-1)
  if (!call) throw new Error('No request was sent')
  const images = decodedPayloads(call.body).filter(isImage)
  expect(images).toHaveLength(1)
  for (const bytes of images) {
    expect(bytes.includes(EXIF_MARKER), 'EXIF segment sent to the provider').toBe(false)
    expect(bytes.includes(Buffer.from(gps, 'latin1')), 'GPS canary sent to the provider').toBe(false)
  }
  expect(call.raw).not.toContain(gps)

  // Nor is it on the disk, in any readable form. The EXIF marker itself is looked for where user data lives (the
  // app's own cached files may legitimately contain image metadata).
  const stored = await dumpStorage(page)
  expect(plaintextHits(stored, [gps])).toEqual([])
  const userData = stored.filter((s) => s.where.startsWith('indexedDB') || s.where.startsWith('OPFS'))
  expect(plaintextHits(userData, [EXIF_MARKER.toString('latin1')])).toEqual([])
})

test('About lists every origin this page contacted and why, without paths', async ({ page, providers }) => {
  test.setTimeout(120_000)
  await startChat(page, providers, { ...CLAUDE, key: `sk-ant-api03-${canary('panel')}` })
  providers.serve('anthropic', anthropicText(['Paris.']))
  await send(page, 'What is the capital of France?')
  await settled(page)
  // In place, not a reload: the log lives in this page's memory only (and a reload locks the vault).
  await page.evaluate(() => {
    location.hash = '#/about'
  })
  await expect(page.getByRole('heading', { level: 1, name: shell.navAbout })).toBeVisible()
  const panel = page.getByRole('region', { name: about.networkTitle })
  await expect(panel).toBeVisible()
  const row = panel.getByRole('listitem').filter({ hasText: 'https://api.anthropic.com' })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(about.networkPurposeProvider)
  await expect(row).toContainText(/Requests: \d+/)
  // The origin only: no path, no query, no key.
  await expect(panel).not.toContainText('/v1/')
  await expect(panel).not.toContainText('sk-ant')
  await accessible(page, 'about with network')
})
