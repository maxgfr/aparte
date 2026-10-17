import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { answers, content, send, settled, startChat } from './fixtures/chat-ui.ts'
import { CUSTOM_ORIGIN } from './fixtures/providers.ts'
import { canonicalMarkup, unsafeMarkup } from './fixtures/render.ts'
import { anthropicText, openAIChunks, randomByteSplit, randomSplit, seeded } from './fixtures/sse.ts'
import { admitCustomEndpoint, expect, test } from './fixtures/test.ts'
import { accessible } from './gates.ts'

/*
 * The sanitised renderer under hostile and broken input, on every project. Each payload of
 * web/src/ui/render/xss-corpus.json is streamed as an assistant answer: none may run script, load anything, navigate
 * or cause a CSP or Trusted Types violation (the gates of e2e/gates.ts fail the test on the last). A long Markdown
 * answer streamed in pieces cut at random, as text deltas or as raw bytes, must render exactly as when it arrives
 * whole: the seed of each run is reported, and E2E_SEED replays it.
 */

test.use({ netPurposes: ['provider'] })

interface Payload {
  readonly id: string
  readonly format: 'markdown' | 'html'
  readonly threat: string
  readonly payload: string
}

const corpus = JSON.parse(
  readFileSync(fileURLToPath(new URL('../src/ui/render/xss-corpus.json', import.meta.url)), 'utf8'),
) as { hook: string; payloads: Payload[] }

const byThreat = new Map<string, Payload[]>()
for (const p of corpus.payloads) byThreat.set(p.threat, [...(byThreat.get(p.threat) ?? []), p])

const CLAUDE = { kind: 'anthropic', model: 'claude-opus-5-5', key: 'sk-ant-e2e-render' } as const

/** A payload cut in three, so that a tag, an attribute or a URL scheme arrives in pieces as it can from a model. */
function inThirds(text: string): string[] {
  const a = Math.floor(text.length / 3)
  const b = Math.floor((2 * text.length) / 3)
  return [text.slice(0, a), text.slice(a, b), text.slice(b)].filter((s) => s.length > 0)
}

for (const [threat, payloads] of byThreat) {
  test(`corpus "${threat}": ${payloads.length} payloads rendered as answers stay inert`, async ({
    page,
    context,
    providers,
    baseURL,
  }) => {
    test.setTimeout(60_000 + payloads.length * 15_000)
    const app = new URL(baseURL ?? '')
    // A payload that runs reports itself through the hook, in any frame of the page; a dialog counts as running too.
    const ran: string[] = []
    await context.exposeBinding(corpus.hook, (_source, id: unknown) => {
      ran.push(String(id))
    })
    page.on('dialog', (dialog) => {
      ran.push(`dialog: ${dialog.message()}`)
      void dialog.dismiss()
    })
    const requests: string[] = []
    context.on('request', (r) => {
      requests.push(r.url())
    })

    await startChat(page, providers, CLAUDE)
    // The first message of a new chat moves it to the chat's own address (`#/chat/<id>`); after that, nothing may
    // navigate.
    const newChatUrl = page.url()
    let where: string | null = null
    // The app's own files requested so far (the shell, its icons, the service worker) may be requested again, and
    // its lazily loaded chunks (the renderer, KaTeX, languages) may come in: nothing else of its origin may.
    const shellFiles = new Set(
      requests
        .map((u) => new URL(u))
        .filter((u) => u.origin === app.origin)
        .map((u) => u.pathname),
    )
    const expected = (raw: string) => {
      const u = new URL(raw)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return true
      if (u.href === 'https://api.anthropic.com/v1/messages') return true
      return u.origin === app.origin && (u.pathname.startsWith(`${app.pathname}assets/`) || shellFiles.has(u.pathname))
    }

    for (const p of payloads) {
      requests.length = 0
      providers.serve('anthropic', anthropicText(inThirds(p.payload)))
      await send(page, `Show sample ${p.id}.`)
      const answer = await settled(page)
      expect.soft(await unsafeMarkup(content(answer)), `markup kept from ${p.id}`).toEqual([])
      expect
        .soft(
          requests.filter((u) => !expected(u)),
          `requests caused by ${p.id}`,
        )
        .toEqual([])
      if (where === null) {
        const url = page.url()
        expect(url.startsWith(`${newChatUrl}/`), `the chat's own address after ${p.id}`).toBe(true)
        expect(url.slice(newChatUrl.length + 1), `the chat's own address after ${p.id}`).toMatch(/^[a-z2-7]{26}$/)
        where = url
      }
      expect.soft(page.url(), `navigation caused by ${p.id}`).toBe(where)
    }
    // Handlers fire after insertion (an image error, an animation start, a refresh): give them time to.
    await page.waitForTimeout(1_500)
    expect(ran, 'payloads that ran').toEqual([])
    expect(page.url(), 'navigation').toBe(where)
    await expect(answers(page)).toHaveCount(payloads.length)
    // The app still works after the whole group: the composer sends and the answer renders.
    providers.serve('anthropic', anthropicText(['Still **here**.']))
    await send(page, 'Are you still there?')
    await expect(content(await settled(page)).locator('strong')).toHaveText('here')
    await accessible(page, `after the ${threat} corpus`)
  })
}

/** An answer with every construct the renderer handles, and text that a careless cut would break. */
const LONG = `## Plan for the trip to Montréal

Here is a **first draft**, with *some emphasis*, \`inline code\`,
~~a struck idea~~ and a [link](https://example.org/guide "The guide").
Accents and other scripts survive cuts: déjà vu, naïve café, 東京, Ελληνικά, and emoji 🧳🗺️👩🏽‍💻.

### Steps

1. Book the flights
   - compare **three** airlines
   - check the luggage rules
2. Find a place to stay
3. Plan the days:
   1. old town
   2. the mountain

- [x] passport renewed
- [ ] adapter bought

> A quote, with a second line
> and \`code\` inside it.

| Day | Place | Cost (CAD) |
|:----|:-----:|-----------:|
| 1 | Old Montréal | 45.50 |
| 2 | Mont Royal | 0 |
| 3 | Jean-Talon market | 32 |

\`\`\`ts
// Totals for the trip, typed.
const costs: number[] = [45.5, 0, 32]
const total = costs.reduce((sum, c) => sum + c, 0)
console.log(\`total: \${total} < 100 && > 50\`)
\`\`\`

\`\`\`python
def nights(days: int) -> int:
    return max(0, days - 1)  # "fencepost" <not a tag>
\`\`\`

The budget per day is $b = \\frac{T}{n}$ with $n = 3$, and the variance is

$$\\sigma^2 = \\frac{1}{n} \\sum_{i=1}^{n} (x_i - \\bar{x})^2$$

---

Escapes stay text: \\*not emphasis\\*, 5 \\< 6, AT&amp;T, &lt;b&gt;, and a line ending with two spaces
before this one. See <https://example.org/autolink> too.

#### Last words

That is all; *bon voyage* and **à bientôt**!`

/** The constructs a correct render of LONG contains, so that equal renders are not equal by being empty or raw. */
const CONSTRUCTS = [
  '<h2',
  '<h3',
  '<strong',
  '<em',
  '<del',
  '<ol',
  '<ul',
  '<blockquote',
  '<table',
  '<pre',
  '<code',
  '<math',
  '<a ',
]

/** The canonical render of the latest answer, which must be LONG rendered. */
async function referenceRender(page: Page): Promise<string> {
  const reference = await canonicalMarkup(content(await settled(page)))
  for (const construct of CONSTRUCTS) expect(reference, `the whole answer renders ${construct}>`).toContain(construct)
  expect(reference).not.toContain('**first draft**')
  return reference
}

test('a long Markdown answer streamed in random text pieces renders as when it arrives whole', async ({
  page,
  providers,
}, testInfo) => {
  test.setTimeout(240_000)
  const seed = Number(process.env.E2E_SEED ?? Math.floor(Math.random() * 2 ** 31))
  testInfo.annotations.push({ type: 'seed', description: String(seed) })
  const random = seeded(seed)
  await startChat(page, providers, CLAUDE)

  providers.serve('anthropic', anthropicText([LONG]))
  await send(page, 'The plan, whole.')
  const reference = await referenceRender(page)

  // One character at a time, then pieces of growing size, all cut at random.
  for (const [i, max] of [1, 4, 16, 64].entries()) {
    providers.serve('anthropic', anthropicText(randomSplit(LONG, random, max)))
    await send(page, `The plan, in pieces of up to ${max}.`)
    const render = await canonicalMarkup(content(await settled(page)))
    expect(render, `split ${i + 1} (pieces up to ${max}, E2E_SEED=${seed})`).toBe(reference)
  }
})

test('a stream cut at random bytes, through UTF-8 sequences and SSE lines, renders as when it arrives whole', async ({
  page,
  providers,
  gates,
}, testInfo) => {
  test.setTimeout(240_000)
  admitCustomEndpoint(gates)
  const seed = Number(process.env.E2E_SEED ?? Math.floor(Math.random() * 2 ** 31))
  testInfo.annotations.push({ type: 'seed', description: String(seed) })
  const random = seeded(seed)
  await startChat(page, providers, {
    kind: 'openai-compatible',
    model: 'llama-3.3-70b-versatile',
    key: 'gsk_e2e-render',
  })

  providers.serve('openai-compatible', { chunks: [openAIChunks([LONG]).join('')] })
  await send(page, 'The plan, whole.')
  const reference = await referenceRender(page)

  for (const max of [8, 64, 512]) {
    const bytes = new TextEncoder().encode(openAIChunks(randomSplit(LONG, random, 24)).join(''))
    providers.serve('openai-compatible', { chunks: randomByteSplit(bytes, random, max), delayMs: 1 })
    await send(page, `The plan, in bytes of up to ${max}.`)
    const render = await canonicalMarkup(content(await settled(page)))
    expect(render, `bytes up to ${max} from ${CUSTOM_ORIGIN} (E2E_SEED=${seed})`).toBe(reference)
  }
})
