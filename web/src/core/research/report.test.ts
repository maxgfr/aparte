import { describe, expect, test } from 'bun:test'
import type { ReportLabels, ResearchTurn } from '../contracts/research.ts'
import { reportHtml, reportMarkdown } from './report.ts'
import { verifyReport } from './verify.ts'

const corpus = (await Bun.file(new URL('../../ui/render/xss-corpus.json', import.meta.url)).json()) as {
  payloads: { id: string; payload: string }[]
}

const LABELS: ReportLabels = {
  lang: 'en',
  exported: 'Exported on 18 October 2026 · Claude Opus 5.5',
  sources: 'Sources',
  verification: 'Verification',
  passed: 'Citations verified',
  failed: 'Citations failed',
  cited: 'Citations',
  unknownCitation: 'Not a source that was read',
  unreadLink: 'Link to a page that was not read',
  quoteMissing: 'Quotation not found in its source',
  numeralMissing: 'Figure not in its sources',
  uncited: 'Claim without a citation',
  hints: 'Model knowledge, flagged',
  wall: 'Source was a wall page',
  notRead: 'Not read',
}

const turn = (report: string): ResearchTurn => ({
  question: 'How do rate limiters work?',
  queries: ['token bucket'],
  snippets: [],
  report,
  sources: [
    {
      id: 'S1',
      url: 'https://en.wikipedia.org/wiki/Token_bucket',
      title: 'Token bucket',
      status: 'ok',
      text: 'Bursts.',
    },
    { id: 'S2', url: 'javascript:alert(1)', title: '<img src=x onerror=alert(1)>', status: 'ok', text: 'Evil.' },
  ],
})

describe('the exported report', () => {
  test('Markdown: the report, the cited sources, then the verification', () => {
    const t = turn('Token buckets allow bursts [S1]. Something [S7].')
    const md = reportMarkdown(t, verifyReport(t.report, t.sources, t.snippets), LABELS, 'Rate limiting')
    expect(md).toBe(`# Rate limiting

_Exported on 18 October 2026 · Claude Opus 5.5_

Token buckets allow bursts [S1]. Something [S7].

## Sources

- [S1] Token bucket — <https://en.wikipedia.org/wiki/Token_bucket>

## Verification

**Citations failed**

- Citations: 2
- Not a source that was read: S7
`)
  })

  test('HTML: citations link to the source list, marked with their check; a self-contained page', () => {
    const t = turn('Token buckets allow bursts [S1, S7]. `[S1] in code` and [a link [S1]](https://example.org/).')
    const html = reportHtml(t, verifyReport(t.report, t.sources, t.snippets), LABELS, 'Rate <limiting>')
    expect(html).toContain(
      '<a href="#S1" class="cite cite-fetched">[S1]</a><a href="#S7" class="cite cite-unknown">[S7]</a>',
    )
    expect(html).toContain('<code>[S1] in code</code>')
    expect(html).toContain(
      '<li id="S1"><span class="sid">[S1]</span><a href="https://en.wikipedia.org/wiki/Token_bucket"',
    )
    expect(html).toContain('<title>Rate &#60;limiting&#62;</title>')
    expect(html).toContain('<meta http-equiv="Content-Security-Policy" content="default-src \'none\';')
    expect(html).toContain('class="verdict fail"')
  })

  test('nothing of an adversarial report or source can run, load or navigate', () => {
    const t = turn([...corpus.payloads.map((p) => p.payload), 'Cited [S2].'].join('\n\n'))
    const html = reportHtml(t, verifyReport(t.report, t.sources, t.snippets), LABELS, 'x')
    const tags = [...html.matchAll(/<[a-z][^>]*>/gi)].map((m) => m[0])
    expect(
      tags.filter((tag) =>
        /^<(script|iframe|object|embed|img|svg|form|link|base|meta http-equiv="refresh")/i.test(tag),
      ),
    ).toEqual([])
    expect(tags.filter((tag) => /\son[a-z]+\s*=/i.test(tag))).toEqual([])
    expect(
      tags.filter((tag) =>
        /\b(href|src|action|formaction|xlink:href)\s*=\s*["']?\s*(javascript|data|vbscript):/i.test(tag),
      ),
    ).toEqual([])
    // The evil source is listed by its escaped title, not as a link.
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('&#60;img src=x onerror=alert(1)&#62;')
  })
})
