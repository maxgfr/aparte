/*
 * The text of a PDF, page by page, through pdf.js. pdf.js itself is injected (src/app/knowledge.ts loads the pinned
 * package lazily and gives it its worker as a `workerPort` made by src/security/workers.ts), so this module stays
 * pure and is tested with a fake.
 *
 * Invariants:
 * - The document is opened with `isEvalSupported: false` (no code generated from a font, on the builds that still
 *   have that path), without font faces, without worker-side fetches: parsing reads only the bytes it was given.
 * - The PDF's own scripts, links and forms are never run or followed: only `getTextContent` is called.
 * - The caller's bytes are copied before pdf.js transfers them to its worker.
 */
import { ExtractError, type Extracted, type Section } from '../contracts/knowledge.ts'
import { checked, MAX_FILE_BYTES, tidyText } from './extract.ts'

/** The pages a knowledge base reads from one PDF at most. */
export const MAX_PDF_PAGES = 2000

/** The part of pdf.js's API this module calls. */
export interface PdfJsLike {
  getDocument(params: Record<string, unknown>): {
    readonly promise: Promise<PdfDocumentLike>
    destroy(): Promise<void>
  }
}

export interface PdfDocumentLike {
  readonly numPages: number
  getPage(n: number): Promise<PdfPageLike>
}

export interface PdfPageLike {
  getTextContent(): Promise<{ readonly items: readonly unknown[] }>
  cleanup(): unknown
}

/** pdf.js and the worker its documents are parsed in. */
export interface PdfRuntime {
  readonly pdfjs: PdfJsLike
  /** pdf.js's `PDFWorker` over the worker port; passed as the document's `worker`. */
  readonly worker?: unknown
}

/** The options every document is opened with (see the invariants above). */
export function documentParams(data: Uint8Array, worker: unknown): Record<string, unknown> {
  return {
    data: new Uint8Array(data),
    isEvalSupported: false,
    disableFontFace: true,
    useWorkerFetch: false,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
    ...(worker === undefined ? {} : { worker }),
  }
}

/** The text of one page's content items, a line break where pdf.js marks the end of a line. */
export function pageText(items: readonly unknown[]): string {
  let text = ''
  for (const item of items) {
    if (item === null || typeof item !== 'object' || typeof (item as { str?: unknown }).str !== 'string') continue
    const { str, hasEOL } = item as { str: string; hasEOL?: unknown }
    text += str
    if (hasEOL === true) text += '\n'
  }
  return tidyText(text)
}

function pdfError(cause: unknown): ExtractError {
  if (cause instanceof ExtractError) return cause
  const name = cause instanceof Error ? cause.name : ''
  if (name === 'PasswordException') return new ExtractError('encrypted', 'The PDF is password-protected')
  return new ExtractError('corrupt', 'The PDF cannot be read')
}

export async function extractPdf(
  bytes: Uint8Array,
  runtime: () => Promise<PdfRuntime>,
  signal?: AbortSignal,
): Promise<Extracted> {
  if (bytes.length > MAX_FILE_BYTES) throw new ExtractError('too-large', 'The file is too large')
  signal?.throwIfAborted()
  const { pdfjs, worker } = await runtime()
  signal?.throwIfAborted()
  const task = pdfjs.getDocument(documentParams(bytes, worker))
  const stop = () => void task.destroy()
  signal?.addEventListener('abort', stop, { once: true })
  try {
    let doc: PdfDocumentLike
    try {
      doc = await task.promise
    } catch (cause) {
      signal?.throwIfAborted()
      throw pdfError(cause)
    }
    if (doc.numPages > MAX_PDF_PAGES) throw new ExtractError('too-large', `The PDF has ${doc.numPages} pages`)
    const sections: Section[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      signal?.throwIfAborted()
      let text: string
      try {
        const page = await doc.getPage(n)
        try {
          text = pageText((await page.getTextContent()).items)
        } finally {
          page.cleanup()
        }
      } catch (cause) {
        signal?.throwIfAborted()
        throw pdfError(cause)
      }
      if (text !== '') sections.push({ text, page: n })
    }
    return checked({ format: 'pdf', sections })
  } finally {
    signal?.removeEventListener('abort', stop)
    await task.destroy().catch(() => undefined)
  }
}
