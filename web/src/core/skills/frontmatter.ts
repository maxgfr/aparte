/*
 * The YAML frontmatter of a `SKILL.md`: the block between a first line `---` and the next `---` (or `...`). A port,
 * rule for rule, of crates/aparte-skills/src/frontmatter.rs, so a skill reads the same in the browser as in the CLI.
 *
 * Skills use a small part of YAML, and this module reads exactly that part instead of pulling in a YAML library:
 * mappings by indentation, plain, single-quoted and double-quoted scalars, literal (`|`) and folded (`>`) block scalars
 * with their chomping indicators, block lists (`- item`), flow lists (`[a, b]`) and comments. Anchors, tags,
 * multi-document streams and flow mappings are not read (a flow mapping is kept as its raw text).
 *
 * Invariants:
 * - Scalars stay strings; `yamlBool` reads booleans. Nothing is evaluated, no tag is honoured.
 * - A frontmatter that is not of the subset is a SkillError of code `yaml`, with the 1-based line it stopped at.
 * - Every input that the Rust reader accepts gives the same value here, and every one it refuses is refused here too
 *   (the unit tests port the crate's cases one to one).
 */

import { SkillError, type YamlValue } from '../contracts/skills.ts'

type YamlMap = Extract<YamlValue, { readonly kind: 'map' }>

/** Splits a document into its frontmatter (without the `---` lines) and its body; null without a frontmatter. */
export function splitFrontmatter(doc: string): { readonly frontmatter: string; readonly body: string } | null {
  const text = doc.startsWith('\u{feff}') ? doc.slice(1) : doc
  const firstEnd = text.indexOf('\n')
  if (firstEnd < 0 || text.slice(0, firstEnd).trimEnd() !== '---') return null
  const rest = text.slice(firstEnd + 1)
  let at = 0
  while (at < rest.length) {
    const nl = rest.indexOf('\n', at)
    const end = nl < 0 ? rest.length : nl + 1
    const t = rest.slice(at, end).trimEnd()
    if (t === '---' || t === '...') return { frontmatter: rest.slice(0, at), body: rest.slice(end) }
    at = end
  }
  return null
}

/** A key of a mapping (its first entry of that key), or undefined. */
export function yamlGet(v: YamlValue | undefined, key: string): YamlValue | undefined {
  if (v === null || v === undefined || typeof v === 'string' || Array.isArray(v)) return undefined
  return (v as YamlMap).entries.find(([k]) => k === key)?.[1]
}

/** The scalar, if this is one. */
export function yamlString(v: YamlValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined
}

/** `true`/`false` (and the YAML 1.1 spellings `yes`/`no`, `on`/`off`), case-insensitively. */
export function yamlBool(v: YamlValue | undefined): boolean | undefined {
  const s = yamlString(v)
  if (s === undefined) return undefined
  const t = s.trim().toLowerCase()
  if (t === 'true' || t === 'yes' || t === 'on') return true
  if (t === 'false' || t === 'no' || t === 'off') return false
  return undefined
}

const map = (entries: (readonly [string, YamlValue])[]): YamlMap => ({ kind: 'map', entries })

function yamlError(line: number, message: string): SkillError {
  return new SkillError('yaml', `frontmatter line ${line}: ${message}`)
}

/** The lines of `src` as Rust's `str::lines` gives them: split at `\n` or `\r\n`, no final empty line. */
function linesOf(src: string): string[] {
  const out = src.split('\n')
  if (out.at(-1) === '') out.pop()
  const last = out.length - 1
  return out.map((l, i) => ((i < last || src.endsWith('\n')) && l.endsWith('\r') ? l.slice(0, -1) : l))
}

const leadingSpaces = (s: string): number => s.length - s.replace(/^ +/, '').length

const isListItem = (text: string): boolean => text.startsWith('- ') || text === '-'

function isBlank(s: string): boolean {
  const t = s.trimStart()
  return t === '' || t.startsWith('#')
}

interface Line {
  readonly no: number
  readonly indent: number
  readonly text: string
}

/** Parses a frontmatter into a mapping. */
export function parseFrontmatter(src: string): YamlValue {
  const p = new Parser(linesOf(src))
  p.skipBlank()
  if (p.pos >= p.raw.length) return map([])
  const value = p.map(p.line(p.pos).indent)
  p.skipBlank()
  if (p.pos < p.raw.length) throw yamlError(p.line(p.pos).no, 'unexpected indentation')
  return value
}

class Parser {
  pos = 0
  constructor(readonly raw: readonly string[]) {}

  line(i: number): Line {
    const s = this.raw[i] ?? ''
    const indent = leadingSpaces(s)
    return { no: i + 1, indent, text: s.slice(indent).trimEnd() }
  }

  skipBlank(): void {
    while (this.pos < this.raw.length && isBlank(this.raw[this.pos] ?? '')) this.pos++
  }

  /** The indentation of the next content line, if any. */
  peekIndent(): number | null {
    this.skipBlank()
    return this.pos < this.raw.length ? this.line(this.pos).indent : null
  }

  map(indent: number): YamlMap {
    const out: (readonly [string, YamlValue])[] = []
    for (let ind = this.peekIndent(); ind !== null; ind = this.peekIndent()) {
      if (ind < indent) break
      const l = this.line(this.pos)
      if (ind > indent) throw yamlError(l.no, 'unexpected indentation')
      if (isListItem(l.text)) throw yamlError(l.no, 'a list item where a key was expected')
      const kv = splitKey(l.text)
      if (kv === null) throw yamlError(l.no, 'expected `key: value`')
      const [key, rest] = kv
      this.pos++
      const value = this.valueAfterKey(indent, rest, l.no)
      const at = out.findIndex(([k]) => k === key)
      if (at >= 0) out.splice(at, 1)
      out.push([key, value])
    }
    return map(out)
  }

  valueAfterKey(indent: number, raw: string, no: number): YamlValue {
    const rest = stripComment(raw).trim()
    if (rest.startsWith('|') || rest.startsWith('>')) {
      return this.blockScalar(indent, rest.startsWith('>'), rest.slice(1))
    }
    if (rest === '') {
      const ind = this.peekIndent()
      if (ind !== null && ind > indent) {
        return isListItem(this.line(this.pos).text) ? this.list(ind) : this.map(ind)
      }
      // A list may sit at the key's own indentation.
      if (ind !== null && ind === indent && isListItem(this.line(this.pos).text)) return this.list(ind)
      return null
    }
    return this.inline(indent, rest, no)
  }

  inline(indent: number, rest: string, no: number): YamlValue {
    if (rest.startsWith('[')) {
      const list = flowList(rest)
      if (list === null) throw yamlError(no, 'an unclosed flow list')
      return list
    }
    if (rest.startsWith('{')) return rest
    if (rest.startsWith('"') || rest.startsWith("'")) return this.quoted(rest, no)
    // A plain scalar may continue on more-indented lines, folded with spaces.
    let s = rest
    for (let ind = this.peekIndent(); ind !== null; ind = this.peekIndent()) {
      const l = this.line(this.pos)
      if (ind <= indent) break
      if (splitKey(l.text) !== null) throw yamlError(l.no, 'unexpected indentation')
      s += ` ${stripComment(l.text).trim()}`
      this.pos++
    }
    return plain(s)
  }

  /** A quoted scalar starting in `first`, possibly spanning lines. */
  quoted(first: string, no: number): string {
    const q = first[0] === "'" ? "'" : '"'
    let text = first.slice(1)
    for (;;) {
      const end = closingQuote(text, q)
      if (end !== null) {
        const inner = text.slice(0, end)
        if (q === "'") return inner.replaceAll("''", "'")
        const out = unescapeDouble(inner)
        if (typeof out !== 'string') throw yamlError(no, out.error)
        return out
      }
      if (this.pos >= this.raw.length) throw yamlError(no, 'an unclosed quoted string')
      const next = (this.raw[this.pos] ?? '').trim()
      this.pos++
      text += ` ${next}`
    }
  }

  blockScalar(indent: number, folded: boolean, rawHeader: string): string {
    const header = rawHeader.trim()
    const chomp = header.includes('-') ? '-' : header.includes('+') ? '+' : ' '
    const digit = /[0-9]/.exec(header)?.[0]
    let blockIndent: number | null = digit === undefined ? null : indent + Number(digit)
    const lines: string[] = []
    while (this.pos < this.raw.length) {
      const s = this.raw[this.pos] ?? ''
      if (s.trim() === '') {
        lines.push('')
        this.pos++
        continue
      }
      const ind = leadingSpaces(s)
      blockIndent ??= ind
      const bi = blockIndent
      if (ind < bi || ind <= indent) break
      lines.push(s.slice(bi).trimEnd())
      this.pos++
    }
    // Trailing blank lines belong to chomping.
    let trailing = 0
    while (trailing < lines.length && lines[lines.length - 1 - trailing] === '') trailing++
    const content = lines.slice(0, lines.length - trailing)
    let out = ''
    if (folded) {
      let prevBlank = false
      content.forEach((l, i) => {
        const moreIndented = l.startsWith(' ')
        if (i > 0) {
          if (l === '') out += '\n'
          else if (prevBlank || moreIndented) {
            if (!prevBlank) out += '\n'
          } else out += ' '
        }
        out += l
        prevBlank = l === ''
      })
    } else {
      out = content.join('\n')
    }
    if (chomp === '+') out += '\n'.repeat(1 + trailing)
    else if (chomp === ' ' && content.length > 0) out += '\n'
    return out
  }

  list(indent: number): YamlValue[] {
    const out: YamlValue[] = []
    for (let ind = this.peekIndent(); ind !== null; ind = this.peekIndent()) {
      const l = this.line(this.pos)
      if (ind !== indent || !isListItem(l.text)) break
      this.pos++
      const item = l.text.slice(1).trimStart()
      const itemIndent = indent + (l.text.length - item.length)
      if (item === '') {
        const i = this.peekIndent()
        if (i !== null && i > indent) {
          out.push(this.line(this.pos).text.startsWith('- ') ? this.list(i) : this.map(i))
        } else out.push(null)
        continue
      }
      const kv = splitKey(item)
      if (kv !== null) {
        // `- key: value` starts a mapping whose other keys are indented like `key`.
        const first = this.valueAfterKey(itemIndent, kv[1], l.no)
        const entries: (readonly [string, YamlValue])[] = [[kv[0], first]]
        if (this.peekIndent() === itemIndent) entries.push(...this.map(itemIndent).entries)
        out.push(map(entries))
      } else {
        out.push(this.inline(indent, stripComment(item).trim(), l.no))
      }
    }
    return out
  }
}

/** `key: rest` (the key plain or quoted), or null. */
function splitKey(text: string): readonly [string, string] | null {
  if (text.startsWith('#')) return null
  const q = text[0]
  if (q === '"' || q === "'") {
    const close = closingQuote(text.slice(1), q)
    if (close === null) return null
    const end = close + 1
    const after = text.slice(end + 1)
    if (!after.startsWith(':')) return null
    const rest = after.slice(1)
    if (!(rest === '' || rest.startsWith(' '))) return null
    return [text.slice(1, end), rest]
  }
  let search = 0
  for (let at = text.indexOf(':', search); at >= 0; at = text.indexOf(':', search)) {
    const after = text.slice(at + 1)
    if (after === '' || after.startsWith(' ') || after.startsWith('\t')) {
      const key = text.slice(0, at).trim()
      if (key === '' || (key.length === 1 && (key === '-' || key === '[' || key === '{'))) return null
      return [key, after]
    }
    search = at + 1
  }
  return null
}

/** The index of the closing quote in `s` (which starts after the opening one), or null. */
function closingQuote(s: string, q: string): number | null {
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (q === '"' && c === '\\') {
      i += 2
      continue
    }
    if (c === q) {
      if (q === "'" && s[i + 1] === "'") {
        i += 2
        continue
      }
      return i
    }
    i++
  }
  return null
}

const ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '0': '\0',
  '"': '"',
  '\\': '\\',
  '/': '/',
  ' ': ' ',
}

function unescapeDouble(s: string): string | { readonly error: string } {
  let out = ''
  const chars = [...s]
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string
    if (c !== '\\') {
      out += c
      continue
    }
    const next = chars[++i]
    if (next === undefined) return { error: 'a trailing backslash' }
    if (next === 'u') {
      const hex = chars.slice(i + 1, i + 5).join('')
      i += Math.min(4, chars.length - i - 1)
      // Rust's from_str_radix takes an optional leading '+'.
      const cp = /^\+?[0-9a-fA-F]+$/.test(hex) ? Number.parseInt(hex, 16) : Number.NaN
      if (Number.isNaN(cp) || (cp >= 0xd800 && cp <= 0xdfff)) return { error: `bad escape \\u${hex}` }
      out += String.fromCodePoint(cp)
      continue
    }
    const known = ESCAPES[next]
    if (known === undefined) return { error: `unknown escape \\${next}` }
    out += known
  }
  return out
}

/** Removes a ` # comment` from a plain value (a `#` inside quotes is kept). */
function stripComment(s: string): string {
  let quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    const prev = i === 0 ? null : s[i - 1]
    if (quote === null && (c === '"' || c === "'")) {
      if (prev === null || prev === ' ' || prev === '[' || prev === ',') quote = c
    } else if (quote !== null && c === quote) {
      quote = null
    } else if (quote === null && c === '#' && (prev === null || prev === ' ' || prev === '\t')) {
      return s.slice(0, i)
    }
  }
  return s
}

function plain(s: string): YamlValue {
  const t = s.trim()
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null
  return t
}

function flowList(s: string): YamlValue[] | null {
  const t = s.trim()
  if (!t.startsWith('[') || !t.endsWith(']') || t.length < 2) return null
  const inner = t.slice(1, -1)
  const items: YamlValue[] = []
  let cur = ''
  let quote: string | null = null
  let depth = 0
  const push = () => {
    const item = cur.trim()
    if (item !== '') {
      const q = item[0]
      if (q === '"' || q === "'") {
        const body = item.slice(1, Math.max(item.length - 1, 1))
        if (q === '"') {
          const out = unescapeDouble(body)
          items.push(typeof out === 'string' ? out : body)
        } else items.push(body.replaceAll("''", "'"))
      } else items.push(plain(item))
    }
    cur = ''
  }
  for (const c of inner) {
    if (quote !== null) {
      if (c === quote) quote = null
      cur += c
    } else if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (c === '(' || c === '[' || c === '{') {
      depth++
      cur += c
    } else if (c === ')' || c === ']' || c === '}') {
      depth = Math.max(0, depth - 1)
      cur += c
    } else if (c === ',' && depth === 0) {
      push()
    } else cur += c
  }
  push()
  return items
}
