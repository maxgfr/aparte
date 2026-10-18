import katex from 'katex'
import { Marked, type Token, type TokenizerAndRendererExtension, type Tokens } from 'marked'
import { sanitize } from './purify.ts'

/*
 * Untrusted Markdown (model answers, reasoning) to blocks, ported from cursus `content/markdown.ts`: GFM through
 * marked, `$…$` and `$$…$$` maths through KaTeX in MathML output (no font, no stylesheet, nothing fetched), raw HTML
 * shown as text but for a few bare inline tags (`rawHtml`), and nodes only through purify.ts.
 *
 * A message is cut into its top-level blocks, rendered one by one: a block whose source did not change keeps its
 * rendering, so while an answer streams only its last block is parsed and sanitised again (`splitIncremental`).
 * Fenced code blocks and tables are not rendered as HTML at all: Sanitized.tsx builds them as elements.
 */

interface MathToken extends Tokens.Generic {
  type: 'mathBlock' | 'mathInline'
  text: string
}

function renderMath(tex: string, displayMode: boolean): string {
  return katex.renderToString(tex, {
    displayMode,
    output: 'mathml',
    throwOnError: false,
    trust: false,
    strict: 'ignore',
  })
}

const mathBlock: TokenizerAndRendererExtension = {
  name: 'mathBlock',
  level: 'block',
  start: (src) => src.match(/^ {0,3}\$\$/m)?.index,
  tokenizer(src): MathToken | undefined {
    const m = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/.exec(src)
    if (!m || m[1] === undefined) return undefined
    return { type: 'mathBlock', raw: m[0], text: m[1].trim() }
  },
  renderer: (token) => `<div class="math-block">${renderMath(String(token.text), true)}</div>\n`,
}

const mathInline: TokenizerAndRendererExtension = {
  name: 'mathInline',
  level: 'inline',
  start: (src) => {
    const i = src.indexOf('$')
    return i < 0 ? undefined : i
  },
  tokenizer(src): MathToken | undefined {
    const m = /^\$(?!\$)((?:\\.|[^\\$\n])+?)\$(?!\d)/.exec(src)
    if (!m || m[1] === undefined || m[1].trim() === '') return undefined
    return { type: 'mathInline', raw: m[0], text: m[1] }
  },
  renderer: (token) => renderMath(String(token.text), false),
}

/** HTML-escapes text for marked's output. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

/** The inline tags kept from raw HTML, bare (no attribute): typography Markdown has no syntax for. */
const KEPT_TAG = /^<(\/?)(sup|sub|br|kbd|mark|ins|del|s|u|small)\s*\/?>$/i

/**
 * Raw HTML from an answer as marked's output: one bare tag of KEPT_TAG is kept (models write `XIX<sup>e</sup>` or
 * `H<sub>2</sub>O`); anything else (a block, a tag with attributes, a comment) is shown as the text it is, never
 * parsed: an inline handler would only ever be refused by the CSP (and reported on every render).
 */
export function rawHtml(text: string): string {
  const m = KEPT_TAG.exec(text)
  if (m === null) return escapeHtml(text)
  const name = (m[2] ?? '').toLowerCase()
  if (name === 'br') return m[1] === '' ? '<br>' : ''
  return `<${m[1]}${name}>`
}

const marked = new Marked({ gfm: true, breaks: false, async: false })
marked.use({
  extensions: [mathBlock, mathInline],
  renderer: { html: ({ text }) => rawHtml(text) },
})

/** A top-level block of a message. `raw` is its exact source: equal sources render equally. */
export type Block =
  | {
      readonly kind: 'code'
      readonly raw: string
      readonly lang: string
      readonly text: string
      readonly open: boolean
    }
  | { readonly kind: 'table'; readonly raw: string; readonly token: Token }
  | { readonly kind: 'html'; readonly raw: string; readonly token: Token }

/** Line endings as marked reads them, so the blocks' sources add up to the text. */
export function normalize(source: string): string {
  return source.replace(/\r\n?/g, '\n')
}

/** The language name of a fence info string (` ```ts title=x ` → `ts`), lowercase, or ''. */
export function fenceLanguage(lang: string | undefined): string {
  const first = (lang ?? '').trim().split(/\s+/)[0] ?? ''
  return /^[\w+#.-]{1,32}$/.test(first) ? first.toLowerCase() : ''
}

function toBlock(token: Token): Block | null {
  if (token.type === 'space' || token.type === 'def') return null
  if (token.type === 'code') {
    const code = token as Tokens.Code
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(code.raw)?.[1]
    const lines = code.raw.trimEnd().split('\n')
    const last = lines[lines.length - 1] ?? ''
    // A fence still open (the answer is streaming it) has no closing line yet.
    const open =
      fence !== undefined && (lines.length < 2 || !new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(last))
    return { kind: 'code', raw: code.raw, lang: fenceLanguage(code.lang), text: code.text, open }
  }
  if (token.type === 'table') return { kind: 'table', raw: token.raw, token }
  return { kind: 'html', raw: token.raw, token }
}

/** Every top-level block of `source`. */
export function splitBlocks(source: string): Block[] {
  const out: Block[] = []
  for (const token of marked.lexer(normalize(source))) {
    const block = toBlock(token)
    if (block !== null) out.push(block)
  }
  return out
}

/** A split kept between renders of a growing text. */
export interface Split {
  readonly source: string
  readonly blocks: readonly Block[]
  /** Offset in `source` where the last block's tokens start. */
  readonly tailStart: number
  /** Whether the tokens' sources add up to `source`, so `tailStart` is exact. */
  readonly exact: boolean
}

function fullSplit(source: string): Split {
  const blocks: Block[] = []
  let at = 0
  let tailStart = 0
  for (const token of marked.lexer(source)) {
    const block = toBlock(token)
    if (block !== null) {
      blocks.push(block)
      tailStart = at
    }
    at += token.raw.length
  }
  return { source, blocks, tailStart, exact: at === source.length }
}

/**
 * The blocks of `nextSource`, re-lexing only from the start of the previous split's last block when the text only
 * grew: the earlier blocks are kept as they are (the same objects), since text appended at the end can only change
 * the block it is appended to. Anything else is a full split.
 */
export function splitIncremental(previous: Split | null, nextSource: string): Split {
  const source = normalize(nextSource)
  if (previous === null || !previous.exact || !source.startsWith(previous.source)) return fullSplit(source)
  if (source === previous.source) return previous
  const tail = fullSplit(source.slice(previous.tailStart))
  if (!tail.exact) return fullSplit(source)
  return {
    source,
    blocks: [...previous.blocks.slice(0, -1), ...tail.blocks],
    tailStart: previous.tailStart + tail.tailStart,
    exact: true,
  }
}

/** Sanitised renderings by block source; bounded so a long session does not keep every block ever shown. */
const cache = new Map<string, DocumentFragment>()
const CACHE_MAX = 400

/** The block as sanitised nodes: a fresh copy each call, ready to insert. */
export function renderBlock(block: Extract<Block, { kind: 'html' | 'table' }>): DocumentFragment {
  const hit = cache.get(block.raw)
  if (hit !== undefined) return hit.cloneNode(true) as DocumentFragment
  const fragment = sanitize(marked.parser([block.token]))
  cache.set(block.raw, fragment)
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  return fragment.cloneNode(true) as DocumentFragment
}

/** Drops every cached rendering (on lock: they are decrypted content). */
export function clearRenderCache(): void {
  cache.clear()
}
