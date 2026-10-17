import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { expect, test } from '@playwright/test'
import { type LanguageModel, streamText } from 'ai'
import { canvasJpeg, decodedPayloads, EXIF_MARKER, withGpsExif } from './exif.ts'
import { CUSTOM_BASE_URL, ProviderMock } from './providers.ts'
import { canonicalMarkup, unsafeMarkup } from './render.ts'
import { anthropicText, openAIChunks, randomByteSplit, randomSplit, recorded, seeded } from './sse.ts'
import { dumpStorage, plaintextHits } from './storage.ts'

// The chat specs trust these fixtures to catch a stray header, a plaintext canary or unsafe markup, so they are
// tested themselves, the way gates.spec.ts tests the gates: each check provokes what the fixture must catch. The
// tests run outside the gates, which would refuse the provider hosts these tests call directly.

const TEXT = 'déjà vu, 東京, 🧳🗺️👩🏽‍💻, **bold**, `code` and $x^2$: text to cut anywhere. '.repeat(6)

/** A `fetch` answering every call with `pieces`, one read each. */
function serving(pieces: readonly Uint8Array[]): typeof fetch {
  return (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const piece of pieces) controller.enqueue(piece)
          controller.close()
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch
}

async function streamed(model: LanguageModel): Promise<string> {
  let text = ''
  for await (const delta of streamText({ model, prompt: 'hi' }).textStream) text += delta
  return text
}

test('the built answers parse with the AI SDK, whole or cut at random', async () => {
  const random = seeded(7)
  const pieces = randomSplit(TEXT, random, 5)
  expect(pieces.join('')).toBe(TEXT)
  const body = new TextEncoder().encode(anthropicText(pieces).body)
  expect(await streamed(createAnthropic({ apiKey: 'k', fetch: serving([body]) })('claude-opus-5-5'))).toBe(TEXT)

  const bytes = new TextEncoder().encode(openAIChunks(randomSplit(TEXT, random, 9)).join(''))
  for (const max of [1, 8, 64]) {
    const provider = createOpenAICompatible({
      name: 'custom',
      baseURL: CUSTOM_BASE_URL,
      fetch: serving(randomByteSplit(bytes, random, max)),
    })
    expect(await streamed(provider.chatModel('llama-3.3-70b-versatile'))).toBe(TEXT)
  }
  expect(recorded('gemini-text.sse').body).toContain('\r\n')
  expect(() => recorded('missing.sse')).toThrow()
})

test('a plaintext canary is found in any encoding and at any base64 alignment', () => {
  const canary = 'canary-check-0123456789'
  for (const prefix of ['', 'a', 'ab', 'abc']) {
    const stored = [{ where: 'w', text: Buffer.from(`${prefix}${canary}zz`).toString('base64') }]
    expect(plaintextHits(stored, [canary])).toEqual([`${canary} in w`])
  }
  const utf16 = [{ where: 'w', text: Buffer.from(canary, 'utf16le').toString('latin1') }]
  expect(plaintextHits(utf16, [canary])).toHaveLength(1)
  expect(plaintextHits([{ where: 'w', text: 'nothing to see' }], [canary])).toEqual([])
})

test('the EXIF segment carries the GPS canary where a camera puts it', () => {
  // SOI, a 6-byte APP0, EOI: the segment goes after APP0.
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xd9])
  const out = withGpsExif(jpeg, 'canary-gps-1')
  expect([...out.subarray(8, 10)]).toEqual([0xff, 0xe1])
  expect(out.indexOf(EXIF_MARKER)).toBe(12)
  const length = out.readUInt16BE(10)
  expect([...out.subarray(10 + length)]).toEqual([0xff, 0xd9])
  const tiff = out.subarray(18, 10 + length)
  expect(tiff.subarray(0, 4).toString('latin1')).toBe('MM\0*')
  const entry = (ifd: number, i: number) => ifd + 2 + i * 12
  const tags = (ifd: number) =>
    Array.from({ length: tiff.readUInt16BE(ifd) }, (_, i) => tiff.readUInt16BE(entry(ifd, i)))
  const ifd0 = tiff.readUInt32BE(4)
  expect(tags(ifd0)).toEqual([0x010e, 0x0112, 0x8825])
  const gps = tiff.readUInt32BE(entry(ifd0, 2) + 8)
  expect(tags(gps)).toEqual([0x0000, 0x0001, 0x0002, 0x0003, 0x0004, 0x0012, 0x001c])
  expect(tiff.readUInt32BE(tiff.readUInt32BE(entry(gps, 2) + 8))).toBe(48)
  const datum = tiff.readUInt32BE(entry(gps, 5) + 8)
  expect(tiff.subarray(datum, datum + 12).toString('latin1')).toBe('canary-gps-1')

  const image = Buffer.alloc(100, 7)
  const found = decodedPayloads({
    a: [{ data: image.toString('base64') }, `data:image/png;base64,${image.toString('base64')}`],
  })
  expect(found.map((b) => b.equals(image))).toEqual([true, true])
})

test('the provider mock records, polices headers, streams and sees a stop', async ({ page, context, baseURL }) => {
  const mock = await ProviderMock.install(context)
  mock.expectKey('anthropic', 'sk-ant-check')
  mock.expectKey('openai-compatible', 'gsk-check')
  await page.goto(baseURL ?? '')
  mock.serve('anthropic', anthropicText(['Hel', 'lo']))
  mock.serve('openai-compatible', { chunks: openAIChunks(['a', 'b', 'c', 'd']), delayMs: 200, hold: true })
  const out = await page.evaluate(async (endpoint) => {
    const headers = {
      'x-api-key': 'sk-ant-check',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    }
    const models = await (await fetch('https://api.anthropic.com/v1/models', { headers })).json()
    const post = (extra: Record<string, string>) =>
      fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { ...headers, ...extra }, body: '{}' })
    const answer = await (await post({})).text()
    // An SDK header the real host's preflight refuses; and no answer is queued for it.
    const refused = (await post({ 'x-stainless-os': 'MacOS' })).status
    const abort = new AbortController()
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer gsk-check', 'content-type': 'application/json' },
      body: '{"stream":true}',
      signal: abort.signal,
    })
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let partial = ''
    while (reader && partial.split('data:').length < 3) {
      const read = await reader.read()
      if (read.done) break
      partial += decoder.decode(read.value)
    }
    abort.abort()
    return { models, answer, refused, partial }
  }, CUSTOM_BASE_URL)
  expect(out.models.data[0].id).toBe('claude-opus-5-5')
  expect(out.answer).toContain('"text":"Hel"')
  expect(out.refused).toBe(500)
  expect(out.partial).toContain('"content":"a"')
  expect(out.partial).not.toContain('"content":"d"')
  await expect.poll(() => mock.served()[0]?.closedByClient, { timeout: 10_000 }).toBe(true)
  expect(mock.generations('anthropic')).toHaveLength(2)
  expect(mock.generations('openai-compatible')).toHaveLength(1)
  const problems = mock.problems()
  expect(problems).toHaveLength(2)
  expect(problems[0]).toMatch(/^Header x-stainless-os sent to anthropic/)
  expect(problems[1]).toMatch(/^Generation asked of anthropic with no answer queued/)
  await mock.close()
})

test('the storage dump reads IndexedDB values, bytes and blobs, and localStorage', async ({
  page,
  baseURL,
  browserName,
}) => {
  await page.goto(baseURL ?? '')
  // WebKit refuses to store a Blob in IndexedDB in an ephemeral (test) context; the string stands in for it there.
  await page.evaluate(async (blobs) => {
    localStorage.setItem('k', 'canary-local-1')
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('fixtures-check', 1)
      open.onupgradeneeded = () => open.result.createObjectStore('s')
      open.onsuccess = () => {
        const tx = open.result.transaction('s', 'readwrite')
        tx.objectStore('s').put({ nested: [new TextEncoder().encode('canary-bytes-2')] }, 'a')
        tx.objectStore('s').put(blobs ? new Blob(['canary-blob-3']) : 'canary-blob-3', 'b')
        tx.oncomplete = () => {
          open.result.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error)
      }
    })
  }, browserName !== 'webkit')
  const stored = await dumpStorage(page)
  expect(plaintextHits(stored, ['canary-local-1', 'canary-bytes-2', 'canary-blob-3', 'canary-absent'])).toEqual([
    'canary-local-1 in localStorage',
    'canary-bytes-2 in indexedDB fixtures-check/s',
    'canary-blob-3 in indexedDB fixtures-check/s',
  ])

  // The photo with its EXIF segment is still a JPEG the browser decodes.
  const photo = withGpsExif(await canvasJpeg(page), 'canary-gps')
  const size = await page.evaluate(
    async (bytes) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' })
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
      return [bitmap.width, bitmap.height]
    },
    [...photo],
  )
  expect(size).toEqual([96, 64])
})

test('the render rules flag what runs, loads or takes input, and pass plain Markdown', async ({ page }) => {
  // A blank page without the app's policies, so the markup is parsed as is and inspected, never run.
  await page.setContent(
    [
      '<div id="unsafe">',
      '<p onclick="x()">a</p><a href="javascript:x()">b</a><img alt="" src="https://evil.test/i.png">',
      '<iframe title="t"></iframe><div style="background:url(https://evil.test/x)">c</div>',
      '<input type="text"><a href="#top" ping="https://evil.test/p">d</a>',
      '<svg><a xlink:href="javascript:y()"><text>e</text></a></svg>',
      '</div>',
      '<div id="safe"><p id="p1">Hi <strong>there</strong> <a href="https://example.org/">a link</a></p>',
      '<input type="checkbox" disabled><a href="#p1">top</a></div>',
    ].join(''),
  )
  const found = (await unsafeMarkup(page.locator('#unsafe'))).join('\n')
  for (const rule of [
    /handler onclick/,
    /href with scheme javascript:/,
    /<img> src that loads/,
    /element <iframe>/,
    /style that loads/,
    /element <input type=text>/,
    /attribute ping/,
    /xlink:href with scheme javascript:/,
  ])
    expect(found).toMatch(rule)
  expect(await unsafeMarkup(page.locator('#safe'))).toEqual([])
  // Ids and the fragment links to them are left out of the comparison; the rest is kept in order.
  expect(await canonicalMarkup(page.locator('#safe'))).toBe(
    '<p>"Hi "<strong>"there"</strong>" "<a href="https://example.org/">"a link"</a></p>' +
      '<input disabled="" type="checkbox"></input><a>"top"</a>',
  )
})
