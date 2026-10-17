import { scriptURL } from '../../security/tt.ts'
import {
  classifyTrustedTypes,
  cspRequiresTrustedTypes,
  type StorageState,
  type TrustedTypesState,
  type WorkerState,
} from './checks.ts'

/** The one part of the Trusted Types factory read here; declared locally so the check needs no DOM typing update. */
interface TrustedTypesFactory {
  isScriptURL(value: unknown): boolean
}

/**
 * Trusted Types as this page runs them: the factory exists, the app's policy mints a trusted URL for its own
 * service worker script (the one URL it is guaranteed to accept), and the page's CSP meta requires Trusted Types.
 * The service worker adds the same policy as a header; the meta is what every load, controlled or not, carries.
 */
export function trustedTypesState(): TrustedTypesState {
  const factory = (globalThis as { trustedTypes?: TrustedTypesFactory }).trustedTypes
  let policy = false
  if (factory !== undefined) {
    try {
      policy = factory.isScriptURL(scriptURL(new URL(`${import.meta.env.BASE_URL}sw.js`, location.origin)))
    } catch {
      policy = false
    }
  }
  const meta = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy" i]')
  return classifyTrustedTypes({
    api: factory !== undefined,
    policy,
    required: cspRequiresTrustedTypes(meta?.content),
  })
}

export function workerState(): WorkerState {
  if (!('serviceWorker' in navigator)) return 'unsupported'
  return navigator.serviceWorker.controller === null ? 'inactive' : 'active'
}

/** Calls `cb` when another worker takes control of the page (first install, or an update applied elsewhere). */
export function subscribeWorker(cb: () => void): () => void {
  if (!('serviceWorker' in navigator)) return () => {}
  navigator.serviceWorker.addEventListener('controllerchange', cb)
  return () => navigator.serviceWorker.removeEventListener('controllerchange', cb)
}

/** Whether the browser promised not to evict this origin's storage under pressure. */
export async function storageState(): Promise<StorageState> {
  if (typeof navigator.storage?.persisted !== 'function') return 'unsupported'
  try {
    return (await navigator.storage.persisted()) ? 'persisted' : 'best-effort'
  } catch {
    return 'unsupported'
  }
}
