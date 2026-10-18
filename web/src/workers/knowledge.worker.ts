/*
 * The knowledge worker: reads the text of DOCX, PPTX, HTML, Markdown and plain-text files off the main thread
 * (web/src/core/knowledge/extract.ts, protocol in web/src/core/knowledge/worker.ts). It has no network of its own and
 * needs none: everything it reads arrives in the message (noNetwork.ts).
 */
import './noNetwork.ts'
import { type ExtractScopeLike, serveExtractor } from '../core/knowledge/worker.ts'

serveExtractor(globalThis as unknown as ExtractScopeLike)
