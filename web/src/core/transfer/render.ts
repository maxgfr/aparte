/*
 * One conversation's active branch as a document to read elsewhere: Markdown, or a single self-contained HTML file.
 *
 * Invariants:
 * - Only what the thread shows is written: the active branch, deleted messages and tool messages left out, the text
 *   features added to a user message (`injected` text parts, contracts/extras.ts) left out, reasoning shown folded in
 *   HTML and left out of Markdown.
 * - The HTML file runs nothing and loads nothing: a Content-Security-Policy of `default-src 'none'` (inline styles and
 *   `data:` images only), no script, raw HTML of the messages shown as text, links only to http, https and mailto
 *   addresses, and photos embedded as `data:` URIs. Every string written into it is escaped.
 * - Words of the interface come from the caller (`labels`), already translated.
 */

import { Marked, type Tokens } from 'marked'
import type { BlobPort, Conversation, Message, ModelRef, Part } from '../contracts/workspace.ts'
import { base64urlEncode } from '../crypto/bytes.ts'
import { resolveRef } from './aparte.ts'

export interface ExportLabels {
  /** The title of an untitled conversation. */
  readonly untitled: string
  readonly you: string
  readonly system: string
  readonly reasoning: string
  /** Stands for a photo in Markdown, and for one this device does not hold in HTML. */
  readonly image: string
  readonly tool: string
  readonly sources: string
  /** A line under the title, already formatted (the date included). */
  readonly exported: string
  /** The BCP-47 tag of the labels' language. */
  readonly lang: string
}

export interface RenderDeps {
  readonly blobs: BlobPort
  /** The name to show for the model of an answer. */
  readonly modelName: (ref: ModelRef | null) => string
  readonly labels: ExportLabels
}

/** HTML-escapes text, attributes included. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

const SAFE_LINK = /^(?:https?:|mailto:)/i
const IMAGE_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

const marked = new Marked({ gfm: true, breaks: false, async: false })
marked.use({
  renderer: {
    // Markup in a message is shown as the text it is.
    html: ({ text }: Tokens.HTML | Tokens.Tag) => escapeHtml(text),
    link(token: Tokens.Link) {
      const inner = this.parser.parseInline(token.tokens)
      if (!SAFE_LINK.test(token.href)) return inner
      return `<a href="${escapeHtml(token.href)}" rel="noopener noreferrer">${inner}</a>`
    },
    // A remote image would be a request from the reader's browser: the alternative text stands in for it.
    image: (token: Tokens.Image) => escapeHtml(token.text === '' ? '' : `[${token.text}]`),
  },
})

/** The text of a branch's message as the thread shows it: its own text parts, not the injected ones. */
export function visibleText(parts: readonly Part[]): string {
  const out: string[] = []
  for (const p of parts) {
    if (p.type !== 'text' || (p as { injected?: unknown }).injected !== undefined) continue
    if (p.text.trim() !== '') out.push(p.text)
  }
  return out.join('\n\n')
}

function reasoningText(parts: readonly Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: 'reasoning' }> => p.type === 'reasoning' && p.text.trim() !== '')
    .map((p) => p.text)
    .join('\n\n')
}

/** The messages a branch shows, with their `ref` parts resolved. */
async function shown(path: readonly Message[], blobs: BlobPort): Promise<Message[]> {
  const out: Message[] = []
  for (const m of path) {
    if (m.deletedAt !== undefined || m.role === 'tool') continue
    const parts: Part[] = []
    for (const p of m.parts) parts.push(await resolveRef(p, blobs))
    out.push({ ...m, parts })
  }
  return out
}

function speaker(m: Message, deps: RenderDeps): string {
  if (m.role === 'user') return deps.labels.you
  if (m.role === 'system') return deps.labels.system
  return deps.modelName(m.model)
}

type Source = Extract<Part, { type: 'source' }>

/** The conversation's branch ending at `path`'s last message, as Markdown. */
export async function toMarkdown(conversation: Conversation, path: readonly Message[], deps: RenderDeps) {
  const { labels } = deps
  const lines: string[] = [`# ${conversation.title || labels.untitled}`, '', `_${labels.exported}_`, '']
  for (const m of await shown(path, deps.blobs)) {
    const body: string[] = []
    for (const p of m.parts) {
      if (p.type === 'image') body.push(`[${labels.image}${p.name ? `: ${p.name}` : ''}]`)
      else if (p.type === 'file') body.push(`[${p.name}]`)
    }
    const text = visibleText(m.parts)
    if (text !== '') body.push(text)
    for (const p of m.parts) if (p.type === 'tool-call') body.push(`_${labels.tool}: ${p.name}_`)
    const sources = m.parts.filter((p): p is Source => p.type === 'source' && typeof p.url === 'string')
    if (sources.length > 0) {
      body.push(`${labels.sources}:\n${sources.map((s) => `- [${s.title ?? s.url}](<${s.url}>)`).join('\n')}`)
    }
    if (body.length === 0) continue
    lines.push(`## ${speaker(m, deps)}`, '', body.join('\n\n'), '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** Standard base64 from bytes (a `data:` URI needs it). */
function base64(bytes: Uint8Array): string {
  const url = base64urlEncode(bytes).replace(/-/g, '+').replace(/_/g, '/')
  return url + '='.repeat((4 - (url.length % 4)) % 4)
}

/** DESIGN.md's palette, light and dark, for a document read on its own. */
const STYLE = `
:root{color-scheme:light dark;--bg:#f6f4ef;--surface:#fffdf9;--ink:#1b1a17;--ink-2:#57534b;--ink-3:#6b665d;--line:#e6e1d7;--accent:#1d6b5a;--bubble:#ebe6dc;--code:#f3f0e9}
@media (prefers-color-scheme:dark){:root{--bg:#121110;--surface:#1d1c1a;--ink:#efeae1;--ink-2:#cfc8bb;--ink-3:#a39c90;--line:#2e2b28;--accent:#7fcab4;--bubble:#2a2724;--code:#1a1917}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:1.0625rem/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,Roboto,sans-serif}
main{max-width:46rem;margin:0 auto;padding:2rem 1rem 4rem}
h1{font:600 2.125rem/1.15 ui-serif,'New York','Iowan Old Style',Georgia,serif;letter-spacing:-0.015em;margin:0 0 .25rem}
.meta{color:var(--ink-3);font-size:.8125rem;margin:0 0 2rem}
.who{color:var(--ink-3);font-size:.8125rem;font-weight:600;margin:0 0 .25rem}
section{margin:0 0 1.75rem}
.user .body{background:var(--bubble);border-radius:18px 18px 6px 18px;padding:.625rem 1rem;margin-left:15%}
.user .who{text-align:right}
.system .body{color:var(--ink-2);font-size:.9375rem;border-left:2px solid var(--line);padding-left:.75rem}
.plain{white-space:pre-wrap;margin:0}
a{color:var(--accent)}
pre{background:var(--code);border:1px solid var(--line);border-radius:12px;padding:.75rem 1rem;overflow-x:auto}
code{font:.875rem ui-monospace,'SF Mono',Menlo,Consolas,monospace}
table{border-collapse:collapse}th,td{border:1px solid var(--line);padding:.25rem .5rem}
img{max-width:100%;height:auto;border-radius:12px;display:block;margin:0 0 .5rem}
details{color:var(--ink-2);font-size:.9375rem;margin:0 0 .5rem}
.note{color:var(--ink-3);font-size:.9375rem}
`

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"

/** The conversation's branch as one HTML file that needs nothing else to be read. */
export async function toHtml(conversation: Conversation, path: readonly Message[], deps: RenderDeps) {
  const { labels } = deps
  const title = conversation.title || labels.untitled
  const sections: string[] = []
  for (const m of await shown(path, deps.blobs)) {
    const body: string[] = []
    for (const p of m.parts) {
      if (p.type === 'image') {
        const bytes = IMAGE_TYPES.has(p.mediaType) ? await deps.blobs.get(p.blob) : null
        const alt = escapeHtml(p.name ?? labels.image)
        body.push(
          bytes === null
            ? `<p class="note">[${alt}]</p>`
            : `<img src="data:${p.mediaType};base64,${base64(bytes)}" alt="${alt}" width="${Math.round(p.width)}" height="${Math.round(p.height)}">`,
        )
      } else if (p.type === 'file') body.push(`<p class="note">[${escapeHtml(p.name)}]</p>`)
    }
    const reasoning = reasoningText(m.parts)
    if (reasoning !== '') {
      body.push(
        `<details><summary>${escapeHtml(labels.reasoning)}</summary><p class="plain">${escapeHtml(reasoning)}</p></details>`,
      )
    }
    const text = visibleText(m.parts)
    if (text !== '') {
      // The user's own words are shown as typed; answers are Markdown.
      body.push(
        m.role === 'assistant'
          ? (marked.parse(text, { async: false }) as string)
          : `<p class="plain">${escapeHtml(text)}</p>`,
      )
    }
    for (const p of m.parts) {
      if (p.type === 'tool-call') body.push(`<p class="note">${escapeHtml(`${labels.tool}: ${p.name}`)}</p>`)
    }
    const sources = m.parts.filter(
      (p): p is Source => p.type === 'source' && typeof p.url === 'string' && SAFE_LINK.test(p.url),
    )
    if (sources.length > 0) {
      const items = sources
        .map(
          (s) =>
            `<li><a href="${escapeHtml(s.url ?? '')}" rel="noopener noreferrer">${escapeHtml(s.title ?? s.url ?? '')}</a></li>`,
        )
        .join('')
      body.push(`<p class="note">${escapeHtml(labels.sources)}</p><ul>${items}</ul>`)
    }
    if (body.length === 0) continue
    sections.push(
      `<section class="${m.role}"><p class="who">${escapeHtml(speaker(m, deps))}</p><div class="body">${body.join('\n')}</div></section>`,
    )
  }
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(labels.lang)}">`,
    '<head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    '<main>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p class="meta">${escapeHtml(labels.exported)}</p>`,
    ...sections,
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}
