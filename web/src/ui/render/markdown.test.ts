import { describe, expect, test } from 'bun:test'
import { fenceLanguage, type Split, splitBlocks, splitIncremental } from './markdown.ts'
import { safeLinkUrl } from './purify.ts'

const SAMPLE = [
  '# Title',
  '',
  'A paragraph with `code`, **bold** and $x^2$ maths, and a [link](https://example.com).',
  '',
  '- one',
  '- two',
  '',
  '- three after a blank',
  '',
  '```ts',
  'const a = 1',
  '```',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  '$$',
  'e^{i\\pi} + 1 = 0',
  '$$',
  '',
  'Setext heading',
  '===',
  '',
  '> quote',
  'lazy line',
  '',
  '![tracker](https://evil.example/pixel.png)',
].join('\n')

describe('blocks', () => {
  test('splits top-level blocks and builds code and tables apart', () => {
    const kinds = splitBlocks(SAMPLE).map((b) => b.kind)
    expect(kinds).toContain('code')
    expect(kinds).toContain('table')
    const code = splitBlocks(SAMPLE).find((b) => b.kind === 'code')
    expect(code).toMatchObject({ lang: 'ts', text: 'const a = 1', open: false })
  })

  test('a fence still streaming is open; a closed one is not', () => {
    expect(splitBlocks('```py\nprint(1)\n')[0]).toMatchObject({ kind: 'code', open: true })
    expect(splitBlocks('```py\nprint(1)\n```\n')[0]).toMatchObject({ kind: 'code', open: false })
    expect(splitBlocks('~~~~\nx\n~~~~')[0]).toMatchObject({ kind: 'code', open: false })
    expect(splitBlocks('    indented\n')[0]).toMatchObject({ kind: 'code', open: false })
  })

  test('streaming a text char by char gives the same blocks as splitting it whole', () => {
    let split: Split | null = null
    for (let i = 1; i <= SAMPLE.length; i++) {
      const prefix = SAMPLE.slice(0, i)
      split = splitIncremental(split, prefix)
      expect(split.blocks.map((b) => b.raw)).toEqual(splitBlocks(prefix).map((b) => b.raw))
    }
  })

  test('earlier blocks keep their identity while the last one grows', () => {
    const a = splitIncremental(null, 'First paragraph.\n\nSecond')
    const b = splitIncremental(a, 'First paragraph.\n\nSecond grows')
    expect(b.blocks[0]).toBe(a.blocks[0] as (typeof b.blocks)[number])
    expect(b.blocks[1]?.raw).toBe('Second grows')
    // A rewritten text (an edit, a different message) is split from scratch.
    const c = splitIncremental(b, 'Other')
    expect(c.blocks.map((x) => x.raw)).toEqual(['Other'])
  })

  test('fence languages are a bare lowercase name or nothing', () => {
    expect(fenceLanguage('TypeScript title="x"')).toBe('typescript')
    expect(fenceLanguage('c++')).toBe('c++')
    expect(fenceLanguage('<script>')).toBe('')
    expect(fenceLanguage(undefined)).toBe('')
  })
})

describe('links', () => {
  test('only absolute http, https and mailto addresses are kept', () => {
    expect(safeLinkUrl('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c')
    expect(safeLinkUrl(' HTTP://Example.com ')).toBe('http://example.com/')
    expect(safeLinkUrl('mailto:someone@example.com')).toBe('mailto:someone@example.com')
    expect(safeLinkUrl('javascript:alert(1)')).toBeNull()
    expect(safeLinkUrl('data:text/html,<b>')).toBeNull()
    expect(safeLinkUrl('/relative')).toBeNull()
    expect(safeLinkUrl('#top')).toBeNull()
    expect(safeLinkUrl('https://user:pass@example.com')).toBeNull()
    expect(safeLinkUrl(null)).toBeNull()
  })
})
