import { describe, expect, test } from 'bun:test'
import { MAX_SPOKEN_CHARS, speakableText } from './speech.ts'

describe('speakable text', () => {
  test('keeps the words and drops the markup', () => {
    const md = [
      '# A title',
      '',
      'Some **bold**, _italic_ and `code` with a [link](https://example.org) and ![a cat](cat.png).',
      '',
      '- one',
      '2. two',
      '> quoted',
      '',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      '```js',
      'const secret = 1',
      '```',
      '',
      'The end <b>now</b>.',
    ].join('\n')
    const out = speakableText(md)
    expect(out).toContain('A title')
    expect(out).toContain('Some bold, italic and code with a link and .')
    expect(out).toContain('one')
    expect(out).toContain('two')
    expect(out).toContain('quoted')
    expect(out).not.toContain('const secret')
    expect(out).not.toContain('https://example.org')
    expect(out).not.toContain('#')
    expect(out).not.toContain('**')
    expect(out).not.toContain('|')
    expect(out).toContain('The end now .')
  })

  test('an unterminated fence drops the rest, and long text is cut', () => {
    expect(speakableText('Before\n```\ncode to the end')).toBe('Before')
    expect(speakableText('a'.repeat(MAX_SPOKEN_CHARS + 10)).length).toBe(MAX_SPOKEN_CHARS)
  })
})
