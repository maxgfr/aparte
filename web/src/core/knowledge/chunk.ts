/*
 * Passages of a document: each section (a page, a slide, the text under a heading) is cut into chunks of about
 * CHUNK_CHARS characters at paragraph, then sentence, then word boundaries, each chunk starting with the end of the
 * one before it (CHUNK_OVERLAP) so a sentence cut in two is still found whole. A chunk never spans two sections, so
 * it keeps its page and heading.
 */
import type { Chunk, Section } from '../contracts/knowledge.ts'

/** The size a chunk aims at: a few paragraphs, well inside what an embedding model reads (256 to 512 tokens). */
export const CHUNK_CHARS = 1000
/** How much of the end of a chunk the next one repeats. */
export const CHUNK_OVERLAP = 150
/** The most chunks one document may have. */
export const MAX_CHUNKS = 20_000

export interface ChunkOptions {
  readonly size?: number
  readonly overlap?: number
}

/** Sentences of a paragraph, each keeping its final punctuation and the space after it. */
function sentences(paragraph: string): string[] {
  const out = paragraph.match(/[^.!?。！？\n]+(?:[.!?。！？]+["'”’)\]]*\s*|\n|$)/gu) ?? [paragraph]
  return out.filter((s) => s.trim() !== '')
}

/** Splits text that has no boundary of its own into pieces of at most `size` characters, at spaces when it can. */
function hardSplit(text: string, size: number): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > size) {
    let cut = rest.lastIndexOf(' ', size)
    if (cut < size / 2) cut = size
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.trim() !== '') out.push(rest)
  return out
}

/** The pieces a section is assembled from, none longer than `size`. */
function units(text: string, size: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split(/\n{2,}/)) {
    if (paragraph.trim() === '') continue
    if (paragraph.length <= size) {
      out.push(`${paragraph}\n\n`)
      continue
    }
    for (const sentence of sentences(paragraph)) {
      if (sentence.length <= size) out.push(sentence)
      else out.push(...hardSplit(sentence, size))
    }
    out.push('\n\n')
  }
  return out
}

/** The end of a chunk the next one starts with: at most `overlap` characters, from a word start. */
function tail(text: string, overlap: number): string {
  if (overlap <= 0 || text.length <= overlap) return ''
  const from = text.length - overlap
  const space = text.indexOf(' ', from)
  return space < 0 ? '' : text.slice(space + 1)
}

export function chunkSections(sections: readonly Section[], options: ChunkOptions = {}): Chunk[] {
  const size = Math.max(100, options.size ?? CHUNK_CHARS)
  const overlap = Math.min(Math.max(0, options.overlap ?? CHUNK_OVERLAP), Math.floor(size / 2))
  const chunks: Chunk[] = []
  for (const section of sections) {
    const meta = {
      ...(section.page === undefined ? {} : { page: section.page }),
      ...(section.heading === undefined ? {} : { heading: section.heading }),
    }
    let current = ''
    let fresh = ''
    const emit = () => {
      const text = current.replace(/\s+\n/g, '\n').trim()
      if (fresh.trim() !== '' && text !== '') chunks.push({ text, ...meta })
      current = tail(text, overlap)
      if (current !== '') current += ' '
      fresh = ''
    }
    for (const unit of units(section.text, size)) {
      if (fresh !== '' && current.length + unit.length > size) emit()
      current += unit
      if (unit.trim() !== '') fresh += unit
    }
    emit()
    if (chunks.length > MAX_CHUNKS) return chunks.slice(0, MAX_CHUNKS)
  }
  return chunks
}
