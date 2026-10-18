/** The worker scripts of the runner frame, bundled by build/sandbox.ts as classic scripts and inlined as text. */
declare module 'virtual:aparte-sandbox-workers' {
  export const jsWorker: string
  export const pyWorker: string
}
