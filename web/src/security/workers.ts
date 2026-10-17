import { scriptURL } from './tt.ts'

/**
 * The only way the app starts a worker. `url` comes from a Vite `?worker&url` import, so it names a built module
 * under `<base>assets/`; it goes through the `aparte` Trusted Types policy, which refuses anything else. Workers are
 * always module workers: the build emits ES modules (`worker.format: 'es'`) and classic `importScripts` stays unused.
 */
export function createWorker(url: string, options?: WorkerOptions): Worker {
  // The DOM typings predate Trusted Types and only accept `string | URL`; the browser accepts the TrustedScriptURL.
  return new Worker(scriptURL(url) as string, { ...options, type: 'module' })
}
