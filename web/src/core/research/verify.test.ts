import { describe, expect, test } from 'bun:test'
import type { ResearchSource, SnippetSource } from '../contracts/research.ts'
import { citationsOf, normalizeText, verifyReport } from './verify.ts'

const SOURCES: ResearchSource[] = [
  {
    id: 'S1',
    url: 'https://en.wikipedia.org/wiki/Token_bucket',
    title: 'Token bucket',
    status: 'ok',
    text: 'The token bucket algorithm allows bursts up to the bucket size. A token is added every 1/r seconds; the bucket holds at most b tokens. Stripe served 10,000 requests per second in 2017.',
  },
  {
    id: 'S2',
    url: 'https://stripe.com/blog/rate-limiters',
    title: 'Scaling your API',
    status: 'ok',
    text: 'Exceeding the limit returns HTTP 429 “Too Many Requests” — the client should back off. About 25 % of traffic was shed.',
  },
  { id: 'S3', url: 'https://walled.example/', title: 'Walled', status: 'wall', text: '' },
  { id: 'S4', url: 'https://unused.example/', title: 'Unused', status: 'ok', text: 'Nothing cited here.' },
]
const SNIPPETS: SnippetSource[] = [{ url: 'https://search-only.example/a', title: 'Hit', snippet: 'only a hit' }]

const verify = (report: string) => verifyReport(report, SOURCES, SNIPPETS)

describe('citationsOf', () => {
  test('single, chained and listed ids, in order, repeats kept', () => {
    expect(citationsOf('A [S1]. B [S2][S4]. C [S1, S3; S2]. D [s5] [S]')).toEqual(['S1', 'S2', 'S4', 'S1', 'S3', 'S2'])
  })
})

describe('verifyReport', () => {
  test('a faithful report passes: citations read, quotes found, figures present', () => {
    const v = verify(`# Rate limiting

**Summary.** A token bucket allows bursts up to the bucket size [S1]. Exceeding the limit returns HTTP 429 [S2].

- Stripe served 10 000 requests per second in 2017 [S1].
- The server answers "Too Many Requests" and the client should back off [S2].
- About 25% of traffic was shed [S2].

> "the bucket holds at most b tokens" [S1]

Most gateways default to token buckets. [M]

> [model-hint] Sliding windows are common, though no source here confirms it.
`)
    expect(v.ok).toBe(true)
    expect(v.citations).toEqual([
      { id: 'S1', status: 'fetched', count: 3, url: SOURCES[0]?.url },
      { id: 'S2', status: 'fetched', count: 3, url: SOURCES[1]?.url },
    ])
    // "Too Many Requests" is three words: too short to check; the blockquote's quotation is found.
    expect(v.quotes.map((q) => q.found)).toEqual([true])
    expect(v.numerals).toEqual([])
    expect(v.uncited).toEqual([])
    expect(v.hints).toBe(2)
    expect(v.unused).toEqual(['S4'])
  })

  test('a dangling id, a walled source, an unread link and a misquote each fail', () => {
    const v = verify(`Bursts are allowed [S1]. Walls say things [S3]. Something else entirely [S9].

See [the blog](https://stripe.com/blog/rate-limiters/) and [a hit](https://search-only.example/a) and <https://nowhere.example/x>.

The article says "the bucket never holds more than ten tokens" [S1].`)
    expect(v.ok).toBe(false)
    expect(v.citations.map((c) => [c.id, c.status])).toEqual([
      ['S1', 'fetched'],
      ['S3', 'wall'],
      ['S9', 'unknown'],
    ])
    expect(v.links).toEqual([
      { url: 'https://stripe.com/blog/rate-limiters/', status: 'fetched' },
      { url: 'https://search-only.example/a', status: 'snippet' },
      { url: 'https://nowhere.example/x', status: 'unknown' },
    ])
    expect(v.quotes).toEqual([{ text: 'the bucket never holds more than ten tokens', ids: ['S1'], found: false }])
  })

  test('a report without any citation fails; uncited claims and absent figures are reported', () => {
    const v = verify(`Rate limiting is a technique that protects services from overload.

| Algorithm | Behaviour |
|---|---|
| Token bucket allows short bursts above the average rate | cited [S1] |
| Fixed windows reset on every boundary of the clock | uncited row |
`)
    expect(verify('No claim cites anything at all here, ever.').ok).toBe(false)
    expect(v.uncited).toEqual([
      'Rate limiting is a technique that protects services from overload.',
      'Fixed windows reset on every boundary of the clock uncited row',
    ])
    const n = verify('Stripe served 12,500 requests per second in 2019 [S1].')
    expect(n.numerals).toEqual([
      { claim: 'Stripe served 12,500 requests per second in 2019 [S1].', ids: ['S1'], missing: ['12500', '2019'] },
    ])
    // A figure is fine in a unit that cites a source holding it, whatever the grouping or the percent sign.
    expect(verify('Stripe served 10000 requests per second [S1] and shed 25 percent [S2].').numerals).toEqual([])
  })

  test('code, comments, headings and the sources appendix are not claims; citations there still count', () => {
    const v = verify(`## A heading that makes a claim with no citation at all

\`\`\`text
"code that quotes a thing never said" [S9] https://code.example/
\`\`\`

Inline \`[S9]\` code is ignored, the claim is cited [S2]. <!-- [S9] in a comment https://comment.example -->

## Sources

- [S1] Token bucket — https://en.wikipedia.org/wiki/Token_bucket
- [S2] Scaling your API — https://stripe.com/blog/rate-limiters
`)
    expect(v.ok).toBe(true)
    expect(v.citations.map((c) => c.id)).toEqual(['S2', 'S1'])
    expect(v.uncited).toEqual([])
    expect(v.links.map((l) => l.status)).toEqual(['fetched', 'fetched'])
  })

  test('quotes match through typography and ellipses; a quote citing no read source cannot be checked', () => {
    const v = verify(`The blog writes “returns HTTP 429 "Too Many Requests" - the client should back off” [S2].

It also says «the token bucket algorithm … bucket size» [S1].

Walls write "four words or more here" [S3].

Short "two words" quotes are not checked [S1].`)
    expect(v.quotes.map((q) => [q.text, q.found])).toEqual([
      ['returns HTTP 429 "Too Many Requests" - the client should back off', true],
      ['the token bucket algorithm … bucket size', true],
      ['four words or more here', null],
    ])
    expect(normalizeText('“A” — B…')).toBe('"a" - b...')
  })

  test('a setext heading and list continuations are read as Markdown is', () => {
    const v = verify(`A heading with many words but no citation
===

- first item that spans
  two lines with a citation [S1]
- second item cited [S2]`)
    expect(v.uncited).toEqual([])
    expect(v.ok).toBe(true)
  })
})
