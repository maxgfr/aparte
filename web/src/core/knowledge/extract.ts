/*
 * The text of the documents a knowledge base takes, but PDF (core/knowledge/pdfText.ts, which needs pdf.js): Word
 * (DOCX), PowerPoint (PPTX), HTML, Markdown and plain text. Pure: fflate and the bounded readers of xml.ts and zip.ts,
 * no DOM, so it runs in the knowledge worker (src/workers/knowledge.worker.ts) and under bun test alike.
 *
 * Invariants:
 * - Nothing in a file is ever run or followed: no macro, no external relationship, no DTD, no remote image. HTML is
 *   read as text with a regular-expression pass and never parsed into a document.
 * - Every size is bounded (zip.ts, xml.ts, MAX_TEXT_CHARS); a file over a bound is refused, never truncated silently.
 * - A file with no text is an ExtractError `empty`, a file of no supported format `unsupported`.
 */
import { type DocumentFormat, ExtractError, type Extracted, type Section } from '../contracts/knowledge.ts'
import { htmlText } from '../tools/builtins.ts'
import { attr, childOf, descendants, isElement, localName, parseXml, type XmlElement } from './xml.ts'
import { isZip, ZipReader } from './zip.ts'

/** The largest file a knowledge base takes. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024
/** The most text one document may hold once extracted. */
export const MAX_TEXT_CHARS = 5_000_000

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const PPTX_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

/** The media type a document is stored under, per format. */
export const MEDIA_TYPES: Readonly<Record<DocumentFormat, string>> = {
  pdf: 'application/pdf',
  docx: DOCX_TYPE,
  pptx: PPTX_TYPE,
  html: 'text/html',
  markdown: 'text/markdown',
  text: 'text/plain',
}

/** What the file input accepts. */
export const ACCEPT = '.pdf,.docx,.pptx,.html,.htm,.md,.markdown,.txt,.csv,.json,text/*,application/pdf'

const EXTENSIONS: Readonly<Record<string, DocumentFormat>> = {
  pdf: 'pdf',
  docx: 'docx',
  pptx: 'pptx',
  html: 'html',
  htm: 'html',
  xhtml: 'html',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  text: 'text',
  csv: 'text',
  tsv: 'text',
  json: 'text',
  log: 'text',
}

/** The format of a file, from its bytes first, then its media type and name; null when none is supported. */
export function detectFormat(bytes: Uint8Array, mediaType: string, name: string): DocumentFormat | null {
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d) {
    return 'pdf'
  }
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  const type = mediaType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (isZip(bytes)) {
    if (type === DOCX_TYPE || ext === 'docx') return 'docx'
    if (type === PPTX_TYPE || ext === 'pptx') return 'pptx'
    try {
      const zip = new ZipReader(bytes)
      if (zip.has('word/document.xml')) return 'docx'
      if (zip.has('ppt/presentation.xml')) return 'pptx'
    } catch {
      return null
    }
    return null
  }
  const byExt = EXTENSIONS[ext]
  if (byExt !== undefined && byExt !== 'pdf' && byExt !== 'docx' && byExt !== 'pptx') return byExt
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html'
  if (type === 'text/markdown' || type === 'text/x-markdown') return 'markdown'
  if (type.startsWith('text/') || type === 'application/json') return 'text'
  if (type === '' || type === 'application/octet-stream') return looksLikeText(bytes) ? 'text' : null
  return null
}

/** Whether the start of a file reads as text: no NUL, few control characters. */
function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096)
  let control = 0
  for (let i = 0; i < n; i++) {
    const b = bytes[i] as number
    if (b === 0) return false
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) control++
  }
  return control <= n / 50
}

/** Text from bytes: UTF-8 (with or without a BOM), UTF-16 with a BOM, else Windows-1252. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

/** Collapses runs of spaces, trims lines and keeps at most one blank line in a row. */
export function tidyText(s: string): string {
  return (
    s
      .replace(/\r\n?/g, '\n')
      // Control characters other than tab and newline say nothing a model can read.
      .replace(/[^\P{Cc}\t\n]/gu, '')
      .split('\n')
      .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

/** Markdown cut at its ATX headings; text before the first heading is a section of its own. */
export function markdownSections(text: string): Section[] {
  const out: Section[] = []
  let heading: string | undefined
  let lines: string[] = []
  let fence = false
  const flush = () => {
    const body = tidyText(lines.join('\n'))
    if (body !== '') out.push(heading === undefined ? { text: body } : { text: body, heading })
    lines = []
  }
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const h = fence ? null : /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) {
      flush()
      heading = (h[2] ?? '').trim()
      continue
    }
    lines.push(line)
  }
  flush()
  return out
}

// Office files

interface Relationship {
  readonly type: string
  readonly target: string
  readonly external: boolean
}

/** Resolves a relationship target against the folder of the part that declares it. */
function resolvePart(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = fromPart.split('/').slice(0, -1)
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.' && seg !== '') parts.push(seg)
  }
  return parts.join('/')
}

/** The relationships of a part by id (`ppt/slides/slide1.xml` reads `ppt/slides/_rels/slide1.xml.rels`). */
function readRels(zip: ZipReader, part: string): Map<string, Relationship> {
  const out = new Map<string, Relationship>()
  const i = part.lastIndexOf('/')
  const xml = zip.text(`${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`)
  if (xml === null) return out
  for (const rel of descendants(parseXml(xml), 'Relationship')) {
    const id = attr(rel, 'Id')
    const target = attr(rel, 'Target')
    if (id === undefined || target === undefined) continue
    const external = attr(rel, 'TargetMode') === 'External'
    out.set(id, { type: attr(rel, 'Type') ?? '', target: external ? target : resolvePart(part, target), external })
  }
  return out
}

/** The main part `_rels/.rels` declares, else the conventional path. */
function mainPart(zip: ZipReader, fallback: string): string {
  for (const rel of readRels(zip, '').values()) {
    if (rel.type.endsWith('/officeDocument') && !rel.external) return rel.target
  }
  return fallback
}

/** Elements whose subtree never holds body text: properties, deletions, field codes, drawings' fallbacks. */
const SKIP = new Set(['pPr', 'rPr', 'del', 'moveFrom', 'instrText', 'Fallback', 'tabs'])

/** The text of a Word paragraph: its runs, tabs and breaks, in order. */
function wordText(p: XmlElement): string {
  let out = ''
  const stack: XmlElement[] = [p]
  while (stack.length > 0) {
    const cur = stack.pop() as XmlElement
    const n = localName(cur.name)
    if (cur !== p) {
      if (SKIP.has(n) || n === 'p') continue
      if (n === 't') {
        for (const c of cur.children) if (typeof c === 'string') out += c
        continue
      }
      if (n === 'tab') out += '\t'
      else if (n === 'br' || n === 'cr') out += '\n'
      else if (n === 'noBreakHyphen') out += '-'
    }
    for (let k = cur.children.length - 1; k >= 0; k--) {
      const c = cur.children[k]
      if (isElement(c)) stack.push(c)
    }
  }
  return out
}

/** Heading levels of a document's paragraph styles, by style id (`heading N`, `title`, or an outline level). */
function wordHeadings(zip: ZipReader): Map<string, number> {
  const out = new Map<string, number>()
  const xml = zip.text('word/styles.xml')
  if (xml === null) return out
  for (const s of descendants(parseXml(xml), 'style')) {
    const id = attr(s, 'styleId')
    if (id === undefined) continue
    const name = (attr(childOf(s, 'name'), 'val') ?? '').toLowerCase()
    const outline = attr(childOf(childOf(s, 'pPr'), 'outlineLvl'), 'val')
    const named = /^heading ([1-9])$/.exec(name)
    if (named) out.set(id, Number(named[1]))
    else if (name === 'title') out.set(id, 1)
    else if (outline !== undefined && /^[0-8]$/.test(outline)) out.set(id, Number(outline) + 1)
  }
  return out
}

/** Paragraphs of a Word body in order, tables included, drawings' fallback copies left out. */
function wordParagraphs(body: XmlElement): XmlElement[] {
  const out: XmlElement[] = []
  const stack: XmlElement[] = [body]
  while (stack.length > 0) {
    const cur = stack.pop() as XmlElement
    const n = localName(cur.name)
    if (cur !== body && (SKIP.has(n) || n === 'sectPr')) continue
    if (n === 'p') {
      out.push(cur)
      continue
    }
    for (let k = cur.children.length - 1; k >= 0; k--) {
      const c = cur.children[k]
      if (isElement(c)) stack.push(c)
    }
  }
  return out
}

export function extractDocx(bytes: Uint8Array): Section[] {
  const zip = new ZipReader(bytes)
  const xml = zip.text(mainPart(zip, 'word/document.xml'))
  if (xml === null) throw new ExtractError('corrupt', 'The document has no body')
  const body = childOf(parseXml(xml), 'body')
  if (!body) throw new ExtractError('corrupt', 'The document has no body')
  const headings = wordHeadings(zip)
  const sections: Section[] = []
  let heading: string | undefined
  let lines: string[] = []
  const flush = () => {
    const text = tidyText(lines.join('\n'))
    if (text !== '') sections.push(heading === undefined ? { text } : { text, heading })
    lines = []
  }
  for (const p of wordParagraphs(body)) {
    const pPr = childOf(p, 'pPr')
    const text = wordText(p).trim()
    if (text === '') continue
    const style = attr(childOf(pPr, 'pStyle'), 'val') ?? ''
    const outline = attr(childOf(pPr, 'outlineLvl'), 'val')
    if (headings.has(style) || (outline !== undefined && /^[0-8]$/.test(outline))) {
      flush()
      heading = text.replace(/\s+/g, ' ')
      continue
    }
    lines.push(childOf(pPr, 'numPr') ? `- ${text}` : text)
  }
  flush()
  return sections
}

const TITLE_TYPES = new Set(['title', 'ctrTitle'])
/** Placeholders repeated on every slide that say nothing about it. */
const CHROME_TYPES = new Set(['sldNum', 'dt', 'ftr', 'hdr'])

/** The paragraphs of a DrawingML text body, one line each. */
function drawingLines(el: XmlElement): string[] {
  return descendants(el, 'p')
    .map((p) => {
      let line = ''
      for (const n of descendants(p, 't')) for (const c of n.children) if (typeof c === 'string') line += c
      return line.replace(/\s+/g, ' ').trim()
    })
    .filter((l) => l !== '')
}

/** A slide's title and text, chrome placeholders (slide number, date, footer) left out. */
function slideText(xml: string): { title: string; lines: string[] } {
  const root = parseXml(xml)
  let title = ''
  const lines: string[] = []
  for (const sp of descendants(root, 'sp')) {
    const ph = descendants(sp, 'ph')[0]
    const type = attr(ph, 'type') ?? ''
    if (CHROME_TYPES.has(type)) continue
    const body = childOf(sp, 'txBody')
    if (!body) continue
    const text = drawingLines(body)
    if (TITLE_TYPES.has(type) && title === '') title = text.join(' ')
    else lines.push(...text)
  }
  for (const frame of descendants(root, 'graphicFrame')) {
    for (const row of descendants(frame, 'tr')) {
      const cells = descendants(row, 'tc').map((tc) => drawingLines(tc).join(' '))
      if (cells.some((c) => c !== '')) lines.push(cells.join(' | '))
    }
  }
  return { title, lines }
}

/** The slides of a presentation in their order: the presentation's list, else the slide files by number. */
function slideParts(zip: ZipReader, presentation: string): string[] {
  const xml = zip.text(presentation)
  const rels = readRels(zip, presentation)
  const ordered: string[] = []
  if (xml !== null) {
    for (const s of descendants(parseXml(xml), 'sldId')) {
      const rid = Object.entries(s.attrs).find(([k]) => k.includes(':') && localName(k) === 'id')?.[1]
      const rel = rid === undefined ? undefined : rels.get(rid)
      if (rel && !rel.external && zip.has(rel.target)) ordered.push(rel.target)
    }
  }
  if (ordered.length > 0) return ordered
  return zip
    .names()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/i.exec(a)?.[1]) - Number(/(\d+)\.xml$/i.exec(b)?.[1]))
}

export function extractPptx(bytes: Uint8Array): Section[] {
  const zip = new ZipReader(bytes)
  const presentation = mainPart(zip, 'ppt/presentation.xml')
  const sections: Section[] = []
  slideParts(zip, presentation).forEach((part, i) => {
    const xml = zip.text(part)
    if (xml === null) return
    const { title, lines } = slideText(xml)
    for (const rel of readRels(zip, part).values()) {
      if (rel.external || !rel.type.endsWith('/notesSlide')) continue
      const notes = zip.text(rel.target)
      if (notes === null) continue
      const text = slideText(notes).lines.filter((l) => !/^\d+$/.test(l))
      if (text.length > 0) lines.push('', ...text)
    }
    const text = tidyText(lines.join('\n'))
    if (text === '' && title === '') return
    sections.push({ text: text === '' ? title : text, page: i + 1, ...(title === '' ? {} : { heading: title }) })
  })
  return sections
}

/** HTML as Markdown-like text: headings kept as `#` lines, everything else as its readable text. */
export function extractHtml(html: string): Section[] {
  const marked = html
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, level: string) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<\/h[1-6]\s*>/gi, '\n\n')
  return markdownSections(htmlText(marked))
}

/** The text of a document of any format but PDF, in sections. */
export function extractText(bytes: Uint8Array, format: Exclude<DocumentFormat, 'pdf'>): Extracted {
  if (bytes.length > MAX_FILE_BYTES) throw new ExtractError('too-large', 'The file is too large')
  let sections: Section[]
  switch (format) {
    case 'docx':
      sections = extractDocx(bytes)
      break
    case 'pptx':
      sections = extractPptx(bytes)
      break
    case 'html':
      sections = extractHtml(decodeText(bytes))
      break
    case 'markdown':
      sections = markdownSections(decodeText(bytes))
      break
    case 'text': {
      const text = tidyText(decodeText(bytes))
      sections = text === '' ? [] : [{ text }]
      break
    }
  }
  return checked({ format, sections })
}

/** Refuses a document with no text or too much of it. */
export function checked(extracted: Extracted): Extracted {
  const sections = extracted.sections.filter((s) => s.text.trim() !== '')
  if (sections.length === 0) throw new ExtractError('empty', 'The document has no text')
  let total = 0
  for (const s of sections) total += s.text.length
  if (total > MAX_TEXT_CHARS) throw new ExtractError('too-large', 'The document holds too much text')
  return { format: extracted.format, sections }
}
