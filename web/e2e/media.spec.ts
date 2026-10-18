import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'
import { chat } from '../src/i18n/en/chat.ts'
import { media } from '../src/i18n/en/media.ts'
import {
  act,
  answers,
  composer,
  messageBox,
  newChat,
  send,
  settled,
  startChat,
  stopButton,
} from './fixtures/chat-ui.ts'
import {
  fakeMicrophone,
  fakeNotifications,
  fakeStalledAudio,
  fakeVoices,
  PNG_BASE64,
  servePost,
} from './fixtures/media.ts'
import { CUSTOM_ORIGIN, GOOGLE_ORIGIN } from './fixtures/providers.ts'
import { openAIText } from './fixtures/sse.ts'
import { dumpStorage, plaintextHits } from './fixtures/storage.ts'
import { admitCustomEndpoint, expect, test } from './fixtures/test.ts'
import { accessible } from './gates.ts'

/*
 * Voice, images and notifications from the user's side, on every project, against providers the test plays: dictation
 * through a provider's transcription API (a tone from a stand-in microphone, sent as WAV), push to talk, reading an
 * answer aloud with this device's own voices only, an image created by Gemini and stored encrypted, the "answer
 * ready" notification that never carries the answer, and the browser's speech service off until the user accepts it.
 * On-device Whisper downloads a 77 MB model, so its protocol is covered by unit tests rather than here.
 */

test.use({ netPurposes: ['provider'] })

const CUSTOM = { kind: 'openai-compatible', model: 'llama-3.3-70b-versatile' } as const

const canary = (what: string) => `canary-${what}-${randomUUID()}`

/** Opens the Voice and media screen from the Models screen. */
async function openVoiceSettings(page: Page): Promise<void> {
  await page
    .getByRole('navigation')
    .getByRole('link', { name: chat.navProviders, exact: true })
    .or(page.getByRole('banner').getByRole('link', { name: chat.navProviders, exact: true }))
    .first()
    .click()
  await page.getByRole('link', { name: new RegExp(`^${media.settingsLink}`) }).click()
  await expect(page.getByRole('heading', { level: 1, name: media.settingsTitle })).toBeVisible()
}

test('dictation through a provider sends the recording as WAV and fills the field; push to talk too', async ({
  page,
  context,
  providers,
  gates,
  browserName,
}) => {
  test.setTimeout(180_000)
  admitCustomEndpoint(gates)
  await fakeMicrophone(page)
  const key = 'sk-test-media-dictation'
  let reply = 'Hello from the microphone.'
  const transcriptions = await servePost(context, `${CUSTOM_ORIGIN}/v1/audio/transcriptions`, () => ({
    contentType: 'application/json',
    body: JSON.stringify({ text: reply }),
  }))
  await startChat(page, providers, { ...CUSTOM, key })

  await openVoiceSettings(page)
  // On this device is the default; the browser's own service is never chosen silently.
  await expect(page.getByRole('radio', { name: media.engineLocal })).toBeChecked()
  await page.getByRole('group', { name: media.dictationTitle }).getByRole('radio', { name: media.engineApi }).check()
  await page.getByRole('group', { name: media.transcriptionProvider }).getByRole('radio').first().check()
  await expect(page.getByLabel(media.transcriptionModel, { exact: true })).toHaveValue('whisper-1')
  await accessible(page, 'voice settings')

  await newChat(page, CUSTOM.model)
  await composer(page).getByRole('button', { name: media.dictate, exact: true }).click()
  await expect(composer(page).getByText(media.dictateListening)).toBeVisible()
  await page.waitForTimeout(900)
  await composer(page).getByRole('button', { name: media.dictateStop, exact: true }).click()
  await expect(messageBox(page)).toHaveValue(reply, { timeout: 20_000 })
  expect(await page.evaluate(() => (window as unknown as { __microphoneCalls: number }).__microphoneCalls)).toBe(1)

  expect(transcriptions).toHaveLength(1)
  const request = transcriptions[0]
  if (!request) throw new Error('no transcription request')
  expect(request.headers().authorization).toBe(`Bearer ${key}`)
  const body = (request.postDataBuffer() ?? Buffer.alloc(0)).toString('latin1')
  expect(request.headers()['content-type']).toMatch(/^multipart\/form-data; boundary=/)
  // WebKit does not hand a test the parts of a multipart body; the other engines do.
  if (browserName !== 'webkit') {
    expect(body).toContain('name="model"')
    expect(body).toContain('whisper-1')
    // A WAV file: the RIFF header, then the "fmt " chunk.
    expect(body).toContain('RIFF')
    expect(body).toContain('WAVEfmt ')
  }

  // Push to talk: dictation runs while the button is held.
  await openVoiceSettings(page)
  await page.getByRole('switch', { name: media.pushToTalk }).check()
  await newChat(page, CUSTOM.model)
  reply = 'Held down.'
  const hold = composer(page).getByRole('button', { name: media.dictateHold, exact: true })
  await hold.hover()
  await page.mouse.down()
  await expect(composer(page).getByText(media.dictateListeningHold)).toBeVisible()
  await page.waitForTimeout(900)
  await page.mouse.up()
  await expect(messageBox(page)).toHaveValue(reply, { timeout: 20_000 })
  expect(transcriptions).toHaveLength(2)
})

test('without a running sound system, dictation says so and lets go of the microphone', async ({
  page,
  context,
  providers,
  gates,
}) => {
  admitCustomEndpoint(gates)
  await fakeStalledAudio(page)
  const transcriptions = await servePost(context, `${CUSTOM_ORIGIN}/v1/audio/transcriptions`, () => ({
    contentType: 'application/json',
    body: JSON.stringify({ text: 'Never heard.' }),
  }))
  await startChat(page, providers, { ...CUSTOM, key: 'sk-test-media-stalled' })
  await openVoiceSettings(page)
  await page.getByRole('group', { name: media.dictationTitle }).getByRole('radio', { name: media.engineApi }).check()
  await page.getByRole('group', { name: media.transcriptionProvider }).getByRole('radio').first().check()

  await newChat(page, CUSTOM.model)
  await composer(page).getByRole('button', { name: media.dictate, exact: true }).click()
  // Not "Listening…" forever: the wait for Web Audio is bounded, then the reason shows and the button is back.
  await expect(composer(page).getByText(media.dictateNoAudio)).toBeVisible({ timeout: 10_000 })
  await expect(composer(page).getByRole('button', { name: media.dictate, exact: true })).toBeEnabled()
  const tracks = await page.evaluate(() =>
    (window as unknown as { __microphoneTracks: MediaStreamTrack[] }).__microphoneTracks.map((t) => t.readyState),
  )
  expect(tracks.length).toBeGreaterThan(0)
  expect(tracks.every((state) => state === 'ended')).toBe(true)
  await expect(messageBox(page)).toHaveValue('')
  expect(transcriptions).toHaveLength(0)
})

test('reading aloud uses this device’s own voices only', async ({ page, providers, gates }) => {
  admitCustomEndpoint(gates)
  await fakeVoices(page, [
    { name: 'Cloud voice', lang: 'en-US', localService: false },
    { name: 'Local voice', lang: 'en-US', localService: true },
  ])
  await startChat(page, providers, { ...CUSTOM, key: 'sk-test-media-read' })
  providers.serve('openai-compatible', openAIText('The **answer** to read.'))
  await send(page, 'Read me something')
  const answer = await settled(page)
  await act(answer, media.readAloud)
  await expect(answer.getByRole('button', { name: media.readStop, exact: true })).toBeVisible()
  const spoken = await page.evaluate(() => (window as unknown as { __spoken: unknown[] }).__spoken)
  expect(spoken).toEqual([{ text: 'The answer to read.', voice: 'Local voice', local: true }])
  await expect(answer.getByRole('button', { name: media.readAloud, exact: true })).toBeAttached({ timeout: 5_000 })
})

test('without a voice of this device, nothing offers to read aloud', async ({ page, providers, gates }) => {
  admitCustomEndpoint(gates)
  await fakeVoices(page, [{ name: 'Cloud voice', lang: 'en-US', localService: false }])
  await startChat(page, providers, { ...CUSTOM, key: 'sk-test-media-remote' })
  providers.serve('openai-compatible', openAIText('Not to be read by a remote voice.'))
  await send(page, 'Hello')
  const answer = await settled(page)
  await answer.hover()
  await expect(answer.getByRole('button', { name: media.readAloud })).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { __spoken: unknown[] }).__spoken)).toEqual([])
})

test('an image created by Gemini shows in the chat and is stored encrypted', async ({ page, context, providers }) => {
  test.setTimeout(120_000)
  const key = 'sk-test-media-image'
  const prompt = `A lighthouse at dusk ${canary('prompt')}`
  const generations = await servePost(
    context,
    `${GOOGLE_ORIGIN}/v1beta/models/gemini-2.5-flash-image:generateContent`,
    () => ({
      contentType: 'application/json',
      body: JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: PNG_BASE64 } }] },
            finishReason: 'STOP',
            index: 0,
          },
        ],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 1290, totalTokenCount: 1299 },
      }),
    }),
  )
  await startChat(page, providers, { kind: 'google', key, model: 'gemini-3-flash' })

  await composer(page).getByRole('button', { name: media.imageMode, exact: true }).click()
  await expect(messageBox(page)).toHaveAttribute('placeholder', media.imagePlaceholder)
  await messageBox(page).fill(prompt)
  await composer(page).getByRole('button', { name: media.imageSend, exact: true }).click()

  const answer = answers(page).last()
  await expect(answer).toHaveAttribute('data-status', 'done', { timeout: 30_000 })
  const image = answer.getByRole('img', { name: /^Image created by .*Gemini 2\.5 Flash Image|gemini-2\.5-flash-image/ })
  await expect(image).toBeVisible()
  expect(await image.getAttribute('src')).toMatch(/^blob:/)
  await expect(page.locator('[data-message][data-role="user"]').last()).toContainText(prompt)

  expect(generations).toHaveLength(1)
  const request = generations[0]
  if (!request) throw new Error('no image request')
  expect(request.headers()['x-goog-api-key']).toBe(key)
  const body = request.postDataJSON() as { contents: { parts: { text?: string }[] }[]; generationConfig: unknown }
  expect(body.contents[0]?.parts[0]?.text).toBe(prompt)
  expect(body.generationConfig).toMatchObject({ responseModalities: ['IMAGE'] })

  expect(plaintextHits(await dumpStorage(page), [prompt, key])).toEqual([])
  await accessible(page, 'chat with an image')
})

test('an answer that finishes in the background is announced, without its text', async ({ page, providers, gates }) => {
  admitCustomEndpoint(gates)
  await fakeNotifications(page)
  await startChat(page, providers, { ...CUSTOM, key: 'sk-test-media-notify' })
  await openVoiceSettings(page)
  const toggle = page.getByRole('switch', { name: media.notifyAnswers })
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await expect(toggle).toBeChecked()

  await newChat(page, CUSTOM.model)
  const count = () => page.evaluate(() => (window as unknown as { __notifications: unknown[] }).__notifications.length)
  // In the background: one notification, which names the chat but says nothing of it.
  const secret = canary('answer')
  providers.serve('openai-compatible', openAIText(`The answer is ${secret}.`))
  await page.evaluate(() => {
    ;(window as unknown as { __hidden: boolean }).__hidden = true
  })
  await send(page, 'First')
  await settled(page)
  await expect.poll(count).toBe(1)
  // In front: none.
  await page.evaluate(() => {
    ;(window as unknown as { __hidden: boolean }).__hidden = false
  })
  providers.serve('openai-compatible', openAIText('A second answer.'))
  await send(page, 'Second')
  await settled(page)
  await expect(stopButton(page)).toHaveCount(0)
  // The turn ends just after its answer renders (once the workspace has saved it): give it that moment.
  await page.waitForTimeout(1_500)
  expect(await count()).toBe(1)
  const [shown] = await page.evaluate(
    () => (window as unknown as { __notifications: { title: string; body: string; data: unknown }[] }).__notifications,
  )
  expect(shown?.title).toBe(media.notificationTitle)
  expect(shown?.body).toBe(media.notificationBody)
  expect(JSON.stringify(shown)).not.toContain(secret)
  expect((shown?.data as { conversation?: string } | undefined)?.conversation).toMatch(/^[a-z2-7]{26}$/)
})

test('the browser’s speech service stays off until the user accepts where the voice goes', async ({
  page,
  providers,
  gates,
}) => {
  admitCustomEndpoint(gates)
  await startChat(page, providers, { ...CUSTOM, key: 'sk-test-media-browser' })
  await openVoiceSettings(page)
  await expect(page.getByRole('radio', { name: media.engineLocal })).toBeChecked()
  const browserService = page.getByRole('radio', { name: media.engineBrowser })
  const hasService = await page.evaluate(() => 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
  if (!hasService) {
    // Without a speech service of its own, the browser is not even offered.
    await expect(browserService).toHaveCount(0)
    return
  }
  // Choosing it asks first, so the radio is clicked rather than checked.
  await browserService.click()
  const dialog = page.getByRole('dialog', { name: media.browserConfirmTitle })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(media.browserConfirmBody)).toBeVisible()
  await dialog.getByRole('button', { name: chat.cancel, exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('radio', { name: media.engineLocal })).toBeChecked()
  await expect(browserService).not.toBeChecked()
})

test('a dictation choice planted in localStorage does not send the voice to the browser’s service unasked', async ({
  page,
  context,
  providers,
  gates,
}) => {
  admitCustomEndpoint(gates)
  // Any page of the shared origin can write localStorage: it sets the engine to the browser's service, which sends
  // the audio to the browser maker's servers, without the user ever seeing the warning.
  await context.addInitScript(() => {
    localStorage.setItem('aparte:dictation', 'browser')
    const started: number[] = []
    ;(window as unknown as { recognitionStarts: number[] }).recognitionStarts = started
    const w = window as unknown as Record<string, { prototype: { start(): void } } | undefined>
    for (const name of ['SpeechRecognition', 'webkitSpeechRecognition']) {
      const proto = w[name]?.prototype
      if (proto) proto.start = () => started.push(Date.now())
    }
  })
  await startChat(page, providers, { ...CUSTOM, key: 'sk-test-media-planted' })
  const hasService = await page.evaluate(() => 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window)
  const mic = composer(page).getByRole('button', { name: media.dictate, exact: true })
  if (!hasService) {
    // No speech service here: the planted choice cannot reach one, and the microphone is not offered for it.
    await expect(mic).toHaveCount(0)
    return
  }
  await mic.click()
  // The warning comes first, in this page, before anything listens.
  const dialog = page.getByRole('dialog', { name: media.browserConfirmTitle })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(media.browserConfirmBody)).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { recognitionStarts: number[] }).recognitionStarts)).toEqual(
    [],
  )
  await dialog.getByRole('button', { name: chat.cancel, exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(await page.evaluate(() => (window as unknown as { recognitionStarts: number[] }).recognitionStarts)).toEqual(
    [],
  )
  // Accepted in this page, the next press listens.
  await mic.click()
  await page
    .getByRole('dialog', { name: media.browserConfirmTitle })
    .getByRole('button', { name: media.browserConfirm })
    .click()
  await mic.click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { recognitionStarts: number[] }).recognitionStarts.length))
    .toBe(1)
})
