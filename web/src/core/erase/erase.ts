/*
 * Erasing everything Aparté keeps on this device, for a user who lost the passphrase and the recovery key (nothing
 * can decrypt the vault then) or who wants the device clean. It deletes Aparté's IndexedDB databases and its own
 * caches; the page then clears its preferences (web/src/app/prefs.ts) and starts over.
 *
 * Invariants:
 * - Only Aparté's own data goes. The origin is shared with other sites (`maxgfr.github.io`), so a database is deleted
 *   only when it is one the app opens or its name starts with `aparte-`, and a cache only when its name starts with
 *   `aparte-`; anything else on the origin is left as it is.
 * - The app precache (Workbox's `workbox-precache-*`, public code checked against the service worker's digests) stays,
 *   so the app still opens offline. Downloaded model files and sandbox runtimes (public, pinned files) stay unless the
 *   caller asks for them to go.
 * - Aparté keeps nothing in the origin private file system, so there is nothing to erase there.
 *
 * Pure over structural interfaces, so it is tested in Bun without a browser.
 */

/** The databases the app opens: the vault (spec/FORMAT.md section 11) and the share inbox (section 16). */
export const APP_DATABASES: readonly string[] = ['aparte-v1', 'aparte-inbox-v1']

/** The prefix of every database and cache name the app creates. */
export const APP_PREFIX = 'aparte-'

/** Caches of downloaded on-device models (WebLLM, transformers.js) and sandbox runtimes (Pyodide, Mermaid). */
const MODEL_CACHE = /^aparte-(?:webllm\/|transformers$|runtime-)/

/** The part of IDBFactory erasing uses. */
export interface DatabasesLike {
  deleteDatabase(name: string): IDBOpenDBRequest
  databases?(): Promise<readonly { readonly name?: string }[]>
}

/** The part of CacheStorage erasing uses. */
export interface CachesLike {
  keys(): Promise<string[]>
  delete(name: string): Promise<boolean>
}

export interface EraseTargets {
  readonly indexedDB: DatabasesLike
  /** null where the Cache API is missing. */
  readonly caches: CachesLike | null
}

export interface EraseOptions {
  /** Also delete the downloaded on-device models and runtimes (default false). */
  readonly models?: boolean
}

/** What went. */
export interface Erased {
  readonly databases: readonly string[]
  readonly caches: readonly string[]
}

/** Whether the database `name` is Aparté's. */
export function isAppDatabase(name: string): boolean {
  return APP_DATABASES.includes(name) || name.startsWith(APP_PREFIX)
}

/** Whether erasing deletes the cache `name`: Aparté's own, and a model or runtime cache only when asked. */
export function erasesCache(name: string, options: EraseOptions = {}): boolean {
  if (!name.startsWith(APP_PREFIX)) return false
  return options.models === true || !MODEL_CACHE.test(name)
}

/**
 * Deletes one database. A page still holding it open is asked to close it (versionchange; the app's connections
 * close on it), and the deletion completes once it has.
 */
function deleteDatabase(factory: DatabasesLike, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error(`The database ${name} could not be deleted`))
  })
}

/** Deletes Aparté's databases and caches; anything else of the origin stays. */
export async function eraseDevice(targets: EraseTargets, options: EraseOptions = {}): Promise<Erased> {
  const names = new Set(APP_DATABASES)
  if (typeof targets.indexedDB.databases === 'function') {
    for (const info of await targets.indexedDB.databases()) {
      if (info.name !== undefined && isAppDatabase(info.name)) names.add(info.name)
    }
  }
  const databases = [...names].sort()
  for (const name of databases) await deleteDatabase(targets.indexedDB, name)

  const caches: string[] = []
  if (targets.caches !== null) {
    for (const name of await targets.caches.keys()) {
      if (!erasesCache(name, options)) continue
      if (await targets.caches.delete(name)) caches.push(name)
    }
  }
  return { databases, caches: caches.sort() }
}
