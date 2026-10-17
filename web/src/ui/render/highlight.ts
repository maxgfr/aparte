import { common, createLowlight } from 'lowlight'

/*
 * Syntax highlighting for code blocks, loaded on first use (its grammars are a chunk of their own). lowlight returns a
 * syntax tree, not HTML: Sanitized.tsx turns it into elements, so highlighted code never goes through an HTML sink.
 */

/** The seven syntax roles of DESIGN.md (`--syntax-*`), which every highlight.js scope maps onto. */
export type SyntaxRole = 'keyword' | 'string' | 'number' | 'comment' | 'function' | 'type' | 'punctuation'

export type CodeNode =
  | { readonly type: 'text'; readonly value: string }
  | {
      readonly type: 'span'
      /** Unique within one tree, for React keys. */
      readonly key: number
      readonly role: SyntaxRole | null
      readonly children: readonly CodeNode[]
    }

const ROLES: Readonly<Record<string, SyntaxRole>> = {
  keyword: 'keyword',
  'selector-tag': 'keyword',
  doctag: 'keyword',
  literal: 'number',
  number: 'number',
  string: 'string',
  regexp: 'string',
  symbol: 'string',
  'attr-value': 'string',
  char: 'string',
  addition: 'string',
  comment: 'comment',
  quote: 'comment',
  deletion: 'comment',
  title: 'function',
  section: 'function',
  'selector-id': 'function',
  type: 'type',
  built_in: 'type',
  class: 'type',
  tag: 'type',
  name: 'type',
  attr: 'type',
  attribute: 'type',
  variable: 'type',
  'template-variable': 'type',
  'selector-class': 'type',
  punctuation: 'punctuation',
  operator: 'punctuation',
  meta: 'punctuation',
}

const lowlight = createLowlight(common)

interface HastText {
  readonly type: 'text'
  readonly value: string
}
interface HastElement {
  readonly type: 'element'
  readonly properties?: { readonly className?: unknown }
  readonly children: readonly HastChild[]
}
type HastChild = HastText | HastElement | { readonly type: string }

function roleOf(className: unknown): SyntaxRole | null {
  if (!Array.isArray(className)) return null
  for (const c of className) {
    if (typeof c !== 'string' || !c.startsWith('hljs-')) continue
    const role = ROLES[c.slice(5)]
    if (role !== undefined) return role
  }
  return null
}

function convert(children: readonly HastChild[], counter: { n: number }): CodeNode[] {
  const out: CodeNode[] = []
  for (const child of children) {
    if (child.type === 'text') out.push({ type: 'text', value: (child as HastText).value })
    else if (child.type === 'element') {
      const el = child as HastElement
      const key = counter.n++
      out.push({ type: 'span', key, role: roleOf(el.properties?.className), children: convert(el.children, counter) })
    }
  }
  return out
}

/** Code longer than this is shown plain: highlighting it would hold the main thread too long. */
const MAX_HIGHLIGHT = 100_000

/** The highlighted tree of `code` in `language`, or null for a language this build does not know. */
export function highlight(language: string, code: string): readonly CodeNode[] | null {
  if (language === '' || code.length > MAX_HIGHLIGHT || !lowlight.registered(language)) return null
  try {
    return convert(lowlight.highlight(language, code).children as readonly HastChild[], { n: 0 })
  } catch {
    return null
  }
}
