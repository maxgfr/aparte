/*
 * pdf.js's own worker, where documents are parsed (web/src/core/knowledge/pdfText.ts). The page hands it to pdf.js as a
 * `workerPort` (web/src/app/knowledge.ts), so pdf.js never creates a worker itself. It starts with no network
 * (noNetwork.ts): a document is parsed from the bytes it was given, and its fonts, links and scripts reach nothing.
 * Started on first use, never precached.
 */
import './noNetwork.ts'
import 'pdfjs-dist/build/pdf.worker.mjs'
