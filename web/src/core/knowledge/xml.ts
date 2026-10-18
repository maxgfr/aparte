/*
 * A minimal XML reader for the parts of Office files: elements, attributes, text and CDATA. No DTD, no external or
 * custom entities, no namespaces beyond prefix stripping. Iterative, so the nesting depth is bounded by a limit and
 * never by the call stack; the node count is bounded too.
 */
import { ExtractError } from '../contracts/knowledge.ts'

export interface XmlElement {
  readonly name: string
  readonly attrs: Readonly<Record<string, string>>
  readonly children: XmlNode[]
}
export type XmlNode = XmlElement | string

export interface XmlLimits {
  readonly maxDepth: number
  readonly maxNodes: number
}

export const DEFAULT_XML_LIMITS: XmlLimits = { maxDepth: 256, maxNodes: 2_000_000 }

const ENTITY = /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g
const NAMED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** Predefined and numeric character references only; anything else stays literal (never expanded). */
export function decodeXmlText(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(ENTITY, (_m, ref: string) => {
    if (ref.startsWith('#')) {
      const cp = ref[1] === 'x' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10)
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�'
    }
    return NAMED[ref] ?? ''
  })
}

const isSpace = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d

/** Parses an XML document into a tree. ExtractError `corrupt` for malformed input, `unsafe` for a DTD. */
export function parseXml(text: string, limits: XmlLimits = DEFAULT_XML_LIMITS): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [] }
  const stack: XmlElement[] = [root]
  let nodes = 0
  const count = (): void => {
    if (++nodes > limits.maxNodes) throw new ExtractError('too-large', 'An XML part has too many nodes')
  }
  const top = (): XmlElement => stack[stack.length - 1] ?? root
  const pushText = (t: string): void => {
    if (t === '' || stack.length === 1) return
    count()
    top().children.push(t)
  }
  const corrupt = (why: string): ExtractError => new ExtractError('corrupt', `Malformed XML: ${why}`)
  const len = text.length
  let i = 0
  while (i < len) {
    const lt = text.indexOf('<', i)
    if (lt < 0) {
      pushText(decodeXmlText(text.slice(i)))
      break
    }
    if (lt > i) pushText(decodeXmlText(text.slice(i, lt)))
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4)
      if (end < 0) throw corrupt('unterminated comment')
      i = end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9)
      if (end < 0) throw corrupt('unterminated CDATA')
      pushText(text.slice(lt + 9, end))
      i = end + 3
      continue
    }
    if (text.startsWith('<!', lt)) throw new ExtractError('unsafe', 'XML document type declarations are not read')
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2)
      if (end < 0) throw corrupt('unterminated processing instruction')
      i = end + 2
      continue
    }
    if (text.startsWith('</', lt)) {
      const end = text.indexOf('>', lt + 2)
      if (end < 0) throw corrupt('unterminated end tag')
      const name = text.slice(lt + 2, end).trim()
      const open = stack.pop()
      if (!open || open === root || open.name !== name) throw corrupt(`unexpected </${name}>`)
      i = end + 1
      continue
    }
    let j = lt + 1
    while (j < len && !isSpace(text.charCodeAt(j)) && text[j] !== '>' && text[j] !== '/') j++
    const name = text.slice(lt + 1, j)
    if (name === '') throw corrupt('empty tag name')
    // No prototype: an attribute named `__proto__` is just an attribute.
    const attrs: Record<string, string> = Object.create(null)
    let selfClosing = false
    for (;;) {
      while (j < len && isSpace(text.charCodeAt(j))) j++
      if (j >= len) throw corrupt(`unterminated <${name}>`)
      if (text[j] === '>') {
        j++
        break
      }
      if (text.startsWith('/>', j)) {
        selfClosing = true
        j += 2
        break
      }
      const eq = text.indexOf('=', j)
      if (eq < 0) throw corrupt(`attribute without a value in <${name}>`)
      const attrName = text.slice(j, eq).trim()
      let q = eq + 1
      while (q < len && isSpace(text.charCodeAt(q))) q++
      const quote = text[q]
      if (quote !== '"' && quote !== "'") throw corrupt(`unquoted attribute in <${name}>`)
      const close = text.indexOf(quote, q + 1)
      if (close < 0 || attrName === '') throw corrupt(`unterminated attribute in <${name}>`)
      attrs[attrName] = decodeXmlText(text.slice(q + 1, close))
      j = close + 1
    }
    count()
    const el: XmlElement = { name, attrs, children: [] }
    if (stack.length === 1 && root.children.length > 0) throw corrupt('several root elements')
    top().children.push(el)
    if (!selfClosing) {
      if (stack.length > limits.maxDepth) throw new ExtractError('too-large', 'An XML part is nested too deeply')
      stack.push(el)
    }
    i = j
  }
  if (stack.length > 1) throw corrupt(`unclosed <${top().name}>`)
  const doc = root.children[0]
  if (doc === undefined || typeof doc === 'string') throw corrupt('no root element')
  return doc
}

/** A name without its namespace prefix: `a:t` is `t`. */
export function localName(name: string): string {
  const i = name.indexOf(':')
  return i < 0 ? name : name.slice(i + 1)
}

export function isElement(n: XmlNode | undefined): n is XmlElement {
  return typeof n === 'object'
}

/** The first direct child element with this local name. */
export function childOf(el: XmlElement | undefined, local: string): XmlElement | undefined {
  if (!el) return undefined
  for (const c of el.children) if (isElement(c) && localName(c.name) === local) return c
  return undefined
}

/** Descendant elements with this local name, in document order. */
export function descendants(el: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = []
  const stack: XmlElement[] = [el]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (!cur) break
    for (let k = cur.children.length - 1; k >= 0; k--) {
      const c = cur.children[k]
      if (isElement(c)) stack.push(c)
    }
    if (cur !== el && localName(cur.name) === local) out.push(cur)
  }
  return out
}

/** An attribute by exact name, else by local name (`val` finds `w:val`). */
export function attr(el: XmlElement | undefined, name: string): string | undefined {
  if (!el) return undefined
  const exact = el.attrs[name]
  if (exact !== undefined) return exact
  for (const [k, v] of Object.entries(el.attrs)) if (k.includes(':') && localName(k) === name) return v
  return undefined
}
