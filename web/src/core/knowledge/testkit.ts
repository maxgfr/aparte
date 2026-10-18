/*
 * Small real documents for the tests (not shipped: imported only by *.test.ts files and the end-to-end specs): a Word
 * file, a PowerPoint file and a PDF built byte by byte, each as an Office application or a PDF writer lays it out,
 * with the text given.
 */
import { strToU8, zipSync } from 'fflate'

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'

function zip(files: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])), { level: 6 })
}

/** One block of a Word body: a heading (level 1 to 3), a paragraph or a bulleted item. */
export type DocxBlock =
  | { readonly heading: string; readonly level?: number }
  | { readonly p: string }
  | { readonly li: string }

export function makeDocx(blocks: readonly DocxBlock[]): Uint8Array {
  const body = blocks
    .map((b) => {
      if ('heading' in b) {
        return `<w:p><w:pPr><w:pStyle w:val="Heading${b.level ?? 1}"/></w:pPr><w:r><w:t>${escapeXml(b.heading)}</w:t></w:r></w:p>`
      }
      if ('li' in b) {
        return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${escapeXml(b.li)}</w:t></w:r></w:p>`
      }
      // Two runs, to check they are joined.
      const half = Math.floor(b.p.length / 2)
      return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(b.p.slice(0, half))}</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escapeXml(b.p.slice(half))}</w:t></w:r></w:p>`
    })
    .join('')
  const styles = [1, 2, 3]
    .map(
      (n) =>
        `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:pPr><w:outlineLvl w:val="${n - 1}"/></w:pPr></w:style>`,
    )
    .join('')
  return zip({
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `${XML}<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/></Relationships>`,
    'word/styles.xml': `${XML}<w:styles xmlns:w="${W}">${styles}</w:styles>`,
    'word/document.xml': `${XML}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  })
}

/** One slide: its title and its bullet lines, and optional speaker notes. */
export interface PptxSlide {
  readonly title: string
  readonly lines: readonly string[]
  readonly notes?: string
}

function shape(id: number, type: string | null, lines: readonly string[]): string {
  const ph = type === null ? '<p:nvPr/>' : `<p:nvPr><p:ph type="${type}"/></p:nvPr>`
  const paras = lines.map((l) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${escapeXml(l)}</a:t></a:r></a:p>`).join('')
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/>${ph}</p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paras}</p:txBody></p:sp>`
}

export function makePptx(slides: readonly PptxSlide[]): Uint8Array {
  const files: Record<string, string> = {
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  }
  // Slide files are numbered against the presentation order, to check the order comes from the presentation.
  const ids = slides.map((_, i) => slides.length - i)
  files['ppt/presentation.xml'] = `${XML}<p:presentation xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:sldIdLst>${ids
    .map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`)
    .join('')}</p:sldIdLst></p:presentation>`
  files['ppt/_rels/presentation.xml.rels'] = `${XML}<Relationships xmlns="${REL}">${ids
    .map((n, i) => `<Relationship Id="rId${i + 1}" Type="${R}/slide" Target="slides/slide${n}.xml"/>`)
    .join('')}</Relationships>`
  slides.forEach((s, i) => {
    const n = ids[i] as number
    files[`ppt/slides/slide${n}.xml`] =
      `${XML}<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:spTree>${shape(2, 'title', [s.title])}${shape(3, 'body', s.lines)}${shape(4, 'sldNum', [String(i + 1)])}</p:spTree></p:cSld></p:sld>`
    if (s.notes !== undefined) {
      files[`ppt/slides/_rels/slide${n}.xml.rels`] =
        `${XML}<Relationships xmlns="${REL}"><Relationship Id="rId9" Type="${R}/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/></Relationships>`
      files[`ppt/notesSlides/notesSlide${n}.xml`] =
        `${XML}<p:notes xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:spTree>${shape(2, 'body', [s.notes])}</p:spTree></p:cSld></p:notes>`
    }
  })
  return zip(files)
}

/** A PDF string literal: backslash, parentheses escaped. */
const pdfString = (s: string): string => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')

/** A PDF of one page per entry, each line of it set in Helvetica, laid out as a PDF writer would. */
export function makePdf(pages: readonly (readonly string[])[]): Uint8Array {
  const objects: string[] = []
  const add = (body: string): number => {
    objects.push(body)
    return objects.length
  }
  const catalog = add('')
  const pagesObj = add('')
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
  const kids: number[] = []
  for (const lines of pages) {
    const ops = lines.map((l, i) => `BT /F1 12 Tf 72 ${720 - i * 18} Td (${pdfString(l)}) Tj ET`).join('\n')
    const content = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`)
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    )
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}
