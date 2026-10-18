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

/**
 * The only way a sandbox frame (web/src/sandbox/frame/) starts the worker its untrusted code runs in. Inside the frame
 * (an opaque origin, its own meta CSP with `worker-src blob:` and `connect-src 'none'`) a worker can only come from a
 * `blob:` URL the frame made, and inherits the frame's policy; the app itself never calls this. A classic worker, so
 * its bootstrap can load the runtime and the code with `importScripts`.
 */
export function createBlobWorker(url: string): Worker {
  if (!url.startsWith('blob:')) throw new TypeError(`Blocked sandbox worker URL (not blob:): ${url.slice(0, 64)}`)
  return new Worker(url)
}
