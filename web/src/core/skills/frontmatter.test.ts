/*
 * The frontmatter subset, against the cases of crates/aparte-skills/src/frontmatter.rs (ported one to one: same
 * inputs, same expectations), then the edges a browser import meets: CRLF, a byte order mark, the `...` terminator,
 * every chomping indicator, flow lists with quotes and parentheses, a flow mapping kept as text.
 */
import { describe, expect, test } from 'bun:test'
import { SkillError, type YamlValue } from '../contracts/skills.ts'
import { parseFrontmatter, splitFrontmatter, yamlBool, yamlGet, yamlString } from './frontmatter.ts'

const m = (...entries: [string, YamlValue][]): YamlValue => ({ kind: 'map', entries })

function yamlLine(src: string): number {
  try {
    parseFrontmatter(src)
  } catch (error) {
    expect(error).toBeInstanceOf(SkillError)
    expect((error as SkillError).code).toBe('yaml')
    const match = /^frontmatter line (\d+): /.exec((error as Error).message)
    if (match === null) throw new Error(`unexpected message ${(error as Error).message}`)
    return Number(match[1])
  }
  throw new Error('expected an error')
}

describe('the Rust cases', () => {
  test('a document splits into frontmatter and body', () => {
    expect(splitFrontmatter('---\nname: x\n---\n# Title\n')).toEqual({ frontmatter: 'name: x\n', body: '# Title\n' })
    expect(splitFrontmatter('# no frontmatter\n')).toBeNull()
    expect(splitFrontmatter('---\nname: x\n')).toBeNull()
    expect(splitFrontmatter('\u{feff}---\r\nname: x\r\n---\r\nbody')).not.toBeNull()
  })

  test('scalars, quotes and comments', () => {
    const v = parseFrontmatter(
      'name: ultrasearch # the name\ndescription: "Say \\"hi\\": now"\nquote: \'it\'\'s\'\nempty:\nflag: true\nurl: https://x.y/z#frag\n',
    )
    expect(yamlGet(v, 'name')).toBe('ultrasearch')
    expect(yamlGet(v, 'description')).toBe('Say "hi": now')
    expect(yamlGet(v, 'quote')).toBe("it's")
    expect(yamlGet(v, 'empty')).toBeNull()
    expect(yamlBool(yamlGet(v, 'flag'))).toBe(true)
    expect(yamlGet(v, 'url')).toBe('https://x.y/z#frag')
  })

  test('block scalars fold or keep lines', () => {
    const v = parseFrontmatter('a: >-\n  one\n  two\n\n  three\nb: |\n  line 1\n  line 2\nc: x\n')
    expect(yamlGet(v, 'a')).toBe('one two\nthree')
    expect(yamlGet(v, 'b')).toBe('line 1\nline 2\n')
    expect(yamlGet(v, 'c')).toBe('x')
  })

  test('nested maps and lists', () => {
    const v = parseFrontmatter(
      'metadata:\n  version: 1.41.1\n  opencode/autoinvoke: \'true\'\nallowed-tools:\n  - Bash(git:*)\n  - Read\nflow: [a, "b, c", Bash(x, y)]\nitems:\n- k: v\n  j: w\n',
    )
    const meta = yamlGet(v, 'metadata')
    expect(yamlGet(meta, 'version')).toBe('1.41.1')
    expect(yamlBool(yamlGet(meta, 'opencode/autoinvoke'))).toBe(true)
    expect(yamlGet(v, 'allowed-tools')).toEqual(['Bash(git:*)', 'Read'])
    expect(yamlGet(v, 'flow')).toEqual(['a', 'b, c', 'Bash(x, y)'])
    expect(yamlGet(v, 'items')).toEqual([m(['k', 'v'], ['j', 'w'])])
  })

  test('plain scalars continue on indented lines', () => {
    const v = parseFrontmatter('description: Research a topic\n  and write a report.\nname: x\n')
    expect(yamlGet(v, 'description')).toBe('Research a topic and write a report.')
  })

  test('broken YAML is an error with a line', () => {
    expect(yamlLine('name: x\n   bad: indent\n')).toBe(2)
    expect(() => parseFrontmatter('description: "open\n')).toThrow(SkillError)
    expect(() => parseFrontmatter('- a\n')).toThrow(SkillError)
  })
})

describe('edges', () => {
  test('CRLF line ends and a byte order mark', () => {
    const split = splitFrontmatter('\u{feff}---\r\nname: x\r\ndescription: |\r\n  one\r\n  two\r\n---\r\nbody\r\n')
    expect(split).toEqual({ frontmatter: 'name: x\r\ndescription: |\r\n  one\r\n  two\r\n', body: 'body\r\n' })
    const v = parseFrontmatter(split?.frontmatter ?? '')
    expect(yamlGet(v, 'name')).toBe('x')
    expect(yamlGet(v, 'description')).toBe('one\ntwo\n')
  })

  test('the frontmatter may end with `...`, and the first line must be `---`', () => {
    expect(splitFrontmatter('---\na: b\n...\nrest')).toEqual({ frontmatter: 'a: b\n', body: 'rest' })
    expect(splitFrontmatter('---\na: b\n---')).toEqual({ frontmatter: 'a: b\n', body: '' })
    expect(splitFrontmatter('--- \na: b\n---\n')).toEqual({ frontmatter: 'a: b\n', body: '' })
    expect(splitFrontmatter('----\na: b\n---\n')).toBeNull()
    expect(splitFrontmatter('---')).toBeNull()
    expect(splitFrontmatter('\n---\na: b\n---\n')).toBeNull()
  })

  test('chomping: strip, clip and keep', () => {
    expect(yamlGet(parseFrontmatter('a: |-\n  x\n\n\nb: 1\n'), 'a')).toBe('x')
    expect(yamlGet(parseFrontmatter('a: |\n  x\n\n\nb: 1\n'), 'a')).toBe('x\n')
    expect(yamlGet(parseFrontmatter('a: |+\n  x\n\n\nb: 1\n'), 'a')).toBe('x\n\n\n')
    expect(yamlGet(parseFrontmatter('a: >\n  x\n  y\n    deeper\n  z\n'), 'a')).toBe('x y\n  deeper z\n')
    expect(yamlGet(parseFrontmatter('a: |2\n    two more\n  base\n'), 'a')).toBe('  two more\nbase\n')
    expect(yamlGet(parseFrontmatter('a: |\nb: 1\n'), 'a')).toBe('')
    expect(yamlGet(parseFrontmatter('a: | # note\n  x\n'), 'a')).toBe('x\n')
  })

  test('flow lists keep quotes, parentheses and nesting together', () => {
    const v = parseFrontmatter("t: ['a, b', \"c\\td\", (x, y), [n, m], '', ~, null]\nu: []\n")
    expect(yamlGet(v, 't')).toEqual(['a, b', 'c\td', '(x, y)', '[n, m]', '', null, null])
    expect(yamlGet(v, 'u')).toEqual([])
    expect(yamlLine('t: [a, b\n')).toBe(1)
  })

  test('a flow mapping is kept as its text', () => {
    expect(yamlGet(parseFrontmatter('m: {a: 1, b: 2}\n'), 'm')).toBe('{a: 1, b: 2}')
  })

  test('quoted scalars may span lines; escapes are read', () => {
    const v = parseFrontmatter('a: "one\n  two"\nb: \'x\n  y\'\nc: "\\u00e9\\/\\0"\n')
    expect(yamlGet(v, 'a')).toBe('one two')
    expect(yamlGet(v, 'b')).toBe('x y')
    expect(yamlGet(v, 'c')).toBe('é/\0')
    expect(yamlLine('a: "\\q"\n')).toBe(1)
    expect(yamlLine('ok: 1\na: "\\uZZZZ"\n')).toBe(2)
  })

  test('quoted keys, repeated keys and lists at the key level', () => {
    const v = parseFrontmatter('"a b": 1\nx: first\ny:\n- one\n- two\nx: last\n')
    expect(yamlGet(v, 'a b')).toBe('1')
    expect(yamlGet(v, 'x')).toBe('last')
    expect(yamlGet(v, 'y')).toEqual(['one', 'two'])
    // The repeated key keeps its last value at its last position.
    expect((v as Extract<YamlValue, { kind: 'map' }>).entries.map(([k]) => k)).toEqual(['a b', 'y', 'x'])
  })

  test('nested lists and empty items', () => {
    const v = parseFrontmatter('l:\n  -\n    - a\n    - b\n  -\n  - c\n')
    expect(yamlGet(v, 'l')).toEqual([['a', 'b'], null, 'c'])
  })

  test('an empty frontmatter is an empty mapping; comments and blank lines are skipped', () => {
    expect(parseFrontmatter('')).toEqual(m())
    expect(parseFrontmatter('# only a comment\n\n')).toEqual(m())
    expect(yamlGet(parseFrontmatter('# c\n\nname: x # c\n'), 'name')).toBe('x')
  })

  test('errors name the line', () => {
    expect(yamlLine('a: 1\n- b\n')).toBe(2)
    expect(yamlLine('a: 1\nnot a pair\n')).toBe(2)
    expect(yamlLine('a: x\n  b: y\n')).toBe(2)
  })

  test('helpers', () => {
    expect(yamlBool('YES')).toBe(true)
    expect(yamlBool(' off ')).toBe(false)
    expect(yamlBool('maybe')).toBeUndefined()
    expect(yamlBool(['true'])).toBeUndefined()
    expect(yamlString(null)).toBeUndefined()
    expect(yamlGet('x', 'a')).toBeUndefined()
  })
})
