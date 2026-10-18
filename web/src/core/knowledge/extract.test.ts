import { describe, expect, test } from 'bun:test'
import { strToU8, zipSync } from 'fflate'
import { ExtractError } from '../contracts/knowledge.ts'
import {
  checked,
  DOCX_TYPE,
  decodeText,
  detectFormat,
  extractHtml,
  extractText,
  markdownSections,
  PPTX_TYPE,
} from './extract.ts'
import { documentParams, extractPdf, type PdfRuntime, pageText } from './pdfText.ts'
import { makeDocx, makePdf, makePptx } from './testkit.ts'
import { parseXml } from './xml.ts'
import { ZipReader } from './zip.ts'

const kindOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return e instanceof ExtractError ? e.kind : `not an ExtractError: ${String(e)}`
  }
  return 'no error'
}

describe('format detection', () => {
  test('from the bytes first, then the media type and the name', () => {
    const docx = makeDocx([{ p: 'x' }])
    const pptx = makePptx([{ title: 'T', lines: ['x'] }])
    expect(detectFormat(makePdf([['x']]), '', 'renamed.txt')).toBe('pdf')
    expect(detectFormat(docx, '', 'no-extension')).toBe('docx')
    expect(detectFormat(pptx, 'application/octet-stream', 'deck')).toBe('pptx')
    expect(detectFormat(docx, DOCX_TYPE, 'a.docx')).toBe('docx')
    expect(detectFormat(pptx, PPTX_TYPE, 'a.pptx')).toBe('pptx')
    expect(detectFormat(strToU8('# Title'), '', 'notes.md')).toBe('markdown')
    expect(detectFormat(strToU8('<p>x</p>'), 'text/html', 'page')).toBe('html')
    expect(detectFormat(strToU8('plain'), 'text/plain', 'a')).toBe('text')
    expect(detectFormat(strToU8('plain words'), '', 'README')).toBe('text')
  })

  test('binary files and other archives are not supported', () => {
    expect(detectFormat(new Uint8Array([0, 1, 2, 3, 0, 0, 7]), '', 'blob.bin')).toBeNull()
    expect(detectFormat(zipSync({ 'a.txt': strToU8('x') }), 'application/zip', 'a.zip')).toBeNull()
    expect(detectFormat(strToU8('x'), 'image/png', 'a.png')).toBeNull()
  })
})

describe('Word', () => {
  test('headings start sections, runs join, list items keep a bullet', () => {
    const bytes = makeDocx([
      { p: 'Preface paragraph before any heading.' },
      { heading: 'Budget' },
      { p: 'The heron project costs 4.2 million.' },
      { li: 'First item' },
      { li: 'Second item' },
      { heading: 'Timeline', level: 2 },
      { p: 'It ends in 2027.' },
    ])
    const { format, sections } = extractText(bytes, 'docx')
    expect(format).toBe('docx')
    expect(sections).toEqual([
      { text: 'Preface paragraph before any heading.' },
      { text: 'The heron project costs 4.2 million.\n- First item\n- Second item', heading: 'Budget' },
      { text: 'It ends in 2027.', heading: 'Timeline' },
    ])
  })

  test('a password-protected or damaged archive is refused', () => {
    const bytes = makeDocx([{ p: 'secret text' }])
    const encrypted = new Uint8Array(bytes)
    // Set the "encrypted" flag on every entry of the central directory.
    for (let i = 0; i < encrypted.length - 4; i++) {
      if (encrypted[i] === 0x50 && encrypted[i + 1] === 0x4b && encrypted[i + 2] === 0x01 && encrypted[i + 3] === 0x02)
        encrypted[i + 8] = (encrypted[i + 8] as number) | 1
    }
    expect(kindOf(() => extractText(encrypted, 'docx'))).toBe('encrypted')
    expect(kindOf(() => extractText(bytes.subarray(0, bytes.length - 30), 'docx'))).toBe('corrupt')
  })

  test('a part that inflates beyond its declared size is refused while it is read', () => {
    const big = 'a'.repeat(100_000)
    const bytes = zipSync({ 'word/document.xml': strToU8(big) }, { level: 9 })
    const lying = new Uint8Array(bytes)
    // Shrink the uncompressed size the central directory declares.
    for (let i = 0; i < lying.length - 4; i++) {
      if (lying[i] === 0x50 && lying[i + 1] === 0x4b && lying[i + 2] === 0x01 && lying[i + 3] === 0x02) {
        lying[i + 24] = 10
        lying[i + 25] = 0
        lying[i + 26] = 0
        lying[i + 27] = 0
      }
    }
    expect(kindOf(() => new ZipReader(lying).read('word/document.xml'))).toBe('too-large')
  })

  test('a document type declaration is never processed', () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>'
    expect(kindOf(() => parseXml(xml))).toBe('unsafe')
  })
})

describe('PowerPoint', () => {
  test('slides in presentation order, titles as headings, notes kept, slide numbers left out', () => {
    const bytes = makePptx([
      { title: 'Heron', lines: ['A bird', 'Lives near water'] },
      { title: 'Budget', lines: ['4.2 million'], notes: 'Say it slowly.' },
    ])
    expect(extractText(bytes, 'pptx').sections).toEqual([
      { text: 'A bird\nLives near water', page: 1, heading: 'Heron' },
      { text: '4.2 million\n\nSay it slowly.', page: 2, heading: 'Budget' },
    ])
  })
})

describe('text formats', () => {
  test('Markdown is cut at its headings, not inside code fences', () => {
    const md = 'Intro line\n\n# One\nBody one\n\n```\n# not a heading\n```\n\n## Two ##\nBody two\n'
    expect(markdownSections(md)).toEqual([
      { text: 'Intro line' },
      { text: 'Body one\n\n```\n# not a heading\n```', heading: 'One' },
      { text: 'Body two', heading: 'Two' },
    ])
  })

  test('HTML is read as text: scripts and styles dropped, headings kept as sections', () => {
    const html =
      '<html><head><title>x</title><style>p{}</style></head><body><h1>Herons</h1><p>Grey &amp; tall.</p><script>alert(1)</script><h2>Food</h2><p>Fish</p></body></html>'
    expect(extractHtml(html)).toEqual([
      { text: 'Grey & tall.', heading: 'Herons' },
      { text: 'Fish', heading: 'Food' },
    ])
  })

  test('UTF-8 with a BOM, UTF-16 and Windows-1252 decode', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x63, 0x61, 0x66, 0xc3, 0xa9]))).toBe('café')
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0xe9, 0x00]))).toBe('hé')
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe('café')
  })

  test('a document with no text is refused', () => {
    expect(kindOf(() => extractText(strToU8('   \n\n  '), 'text'))).toBe('empty')
    expect(kindOf(() => checked({ format: 'text', sections: [{ text: ' ' }] }))).toBe('empty')
  })
})

describe('PDF', () => {
  test('page text joins items and keeps the line ends pdf.js marks', () => {
    expect(
      pageText([{ str: 'Hello', hasEOL: false }, { str: ' world', hasEOL: true }, { str: 'Next' }, { x: 1 }]),
    ).toBe('Hello world\nNext')
  })

  test('documents are opened without eval, font faces or worker fetches, from a copy of the bytes', () => {
    const data = new Uint8Array([1, 2, 3])
    const params = documentParams(data, 'the-worker')
    expect(params).toMatchObject({
      isEvalSupported: false,
      disableFontFace: true,
      useWorkerFetch: false,
      worker: 'the-worker',
    })
    expect(params.data).not.toBe(data)
    expect(params.data).toEqual(data)
  })

  test('the pinned pdf.js reads the text of each page', async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const bytes = makePdf([['Project Heron', 'costs 4.2 million'], [], ['Ends in 2027']])
    const runtime = async (): Promise<PdfRuntime> => ({ pdfjs: pdfjs as never })
    const out = await extractPdf(bytes, runtime)
    expect(out).toEqual({
      format: 'pdf',
      sections: [
        { text: 'Project Heron\ncosts 4.2 million', page: 1 },
        { text: 'Ends in 2027', page: 3 },
      ],
    })
    const scanned = makePdf([[], []])
    await expect(extractPdf(scanned, runtime)).rejects.toMatchObject({ kind: 'empty' })
    await expect(extractPdf(strToU8('%PDF-1.4 garbage'), runtime)).rejects.toMatchObject({ kind: 'corrupt' })
  })

  test('a password-protected PDF and an abort are told apart', async () => {
    const locked = new Error('No password given')
    locked.name = 'PasswordException'
    const runtime = async (): Promise<PdfRuntime> => ({
      pdfjs: {
        getDocument: () => ({ promise: Promise.reject(locked), destroy: async () => undefined }),
      },
    })
    await expect(extractPdf(makePdf([['x']]), runtime)).rejects.toMatchObject({ kind: 'encrypted' })
    const controller = new AbortController()
    controller.abort()
    await expect(extractPdf(makePdf([['x']]), runtime, controller.signal)).rejects.toThrow()
  })
})
