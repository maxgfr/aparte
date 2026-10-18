/*
 * The first module the document workers evaluate (knowledge.worker.ts, pdf.worker.ts): they parse bytes handed to
 * them and need no network at all, so every fetch is refused and the other network APIs are removed before any
 * parser is imported (web/src/security/workerNet.ts).
 */
import { confineFetch } from '../security/workerNet.ts'

confineFetch(() => null)
