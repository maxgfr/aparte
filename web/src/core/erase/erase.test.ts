/*
 * Erasing this device's data (web/src/core/erase/erase.ts) over fake-indexeddb and an in-memory cache storage: what
 * goes, and that nothing of another site of the shared origin does.
 */
import { describe, expect, test } from 'bun:test'
import { type CachesLike, eraseDevice, erasesCache, isAppDatabase } from './erase.ts'

/** Creates the database `name` with one store and one entry, and closes it unless `keepOpen`. */
function createDatabase(name: string, keepOpen = false): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name, 1)
    open.onupgradeneeded = () => open.result.createObjectStore('store')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('store', 'readwrite')
      tx.objectStore('store').put('value', 'key')
      tx.oncomplete = () => {
        if (!keepOpen) db.close()
        resolve(db)
      }
    }
  })
}

async function databaseNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((d) => d.name ?? '').sort()
}

/** A cache storage that only keeps names. */
function memoryCaches(names: readonly string[]): CachesLike & { readonly names: Set<string> } {
  const held = new Set(names)
  return {
    names: held,
    keys: async () => [...held],
    delete: async (name) => held.delete(name),
  }
}

const PRECACHE = 'workbox-precache-v2-https://maxgfr.github.io/aparte/'
/** The name src/sw.ts gives the app precache (Workbox prefix `aparte`). */
const APP_PRECACHE = 'aparte-precache-v2-https://maxgfr.github.io/aparte/'
const SIBLING_PRECACHE = 'workbox-precache-v2-https://maxgfr.github.io/other/'

describe('erasing this device', () => {
  test('deletes the vault, the inbox and any other Aparté database, and no database of another site', async () => {
    const run = crypto.randomUUID()
    const sibling = `other-site-${run}`
    for (const name of ['aparte-v1', 'aparte-inbox-v1', `aparte-later-${run}`, sibling]) await createDatabase(name)
    const erased = await eraseDevice({ indexedDB, caches: null })
    expect(erased.databases).toEqual(['aparte-inbox-v1', `aparte-later-${run}`, 'aparte-v1'])
    const left = await databaseNames()
    expect(left.filter((n) => n.startsWith('aparte-'))).toEqual([])
    expect(left).toContain(sibling)
  })

  test('a page holding the vault open lets go of it, and the deletion completes', async () => {
    const db = await createDatabase('aparte-v1', true)
    let asked = false
    db.onversionchange = () => {
      asked = true
      db.close()
    }
    await eraseDevice({ indexedDB, caches: null })
    expect(asked).toBe(true)
    expect(await databaseNames()).not.toContain('aparte-v1')
  })

  test('deletes the databases it knows even where the browser cannot list them', async () => {
    await createDatabase('aparte-inbox-v1')
    const erased = await eraseDevice({
      indexedDB: { deleteDatabase: (name) => indexedDB.deleteDatabase(name) },
      caches: null,
    })
    expect(erased.databases).toEqual(['aparte-inbox-v1', 'aparte-v1'])
    expect(await databaseNames()).not.toContain('aparte-inbox-v1')
  })

  test('keeps the app precache, and the models and runtimes unless asked, and every cache of another site', async () => {
    const all = [
      APP_PRECACHE,
      PRECACHE,
      SIBLING_PRECACHE,
      'aparte-webllm/model',
      'aparte-webllm/wasm',
      'aparte-transformers',
      'aparte-runtime-v1',
      'aparte-something-else',
      'other-site-cache',
    ]
    const kept = memoryCaches(all)
    expect((await eraseDevice({ indexedDB, caches: kept })).caches).toEqual(['aparte-something-else'])
    expect([...kept.names].sort()).toEqual(all.filter((n) => n !== 'aparte-something-else').sort())

    const dropped = memoryCaches(all)
    expect((await eraseDevice({ indexedDB, caches: dropped }, { models: true })).caches).toEqual([
      'aparte-runtime-v1',
      'aparte-something-else',
      'aparte-transformers',
      'aparte-webllm/model',
      'aparte-webllm/wasm',
    ])
    expect([...dropped.names].sort()).toEqual([APP_PRECACHE, PRECACHE, SIBLING_PRECACHE, 'other-site-cache'].sort())
  })

  test('names: only Aparté’s own databases and caches', () => {
    expect(isAppDatabase('aparte-v1')).toBe(true)
    expect(isAppDatabase('aparte-v2')).toBe(true)
    expect(isAppDatabase('aparte')).toBe(false)
    expect(isAppDatabase('my-aparte-v1')).toBe(false)
    expect(erasesCache('aparte-webllm/config')).toBe(false)
    expect(erasesCache('aparte-webllm/config', { models: true })).toBe(true)
    expect(erasesCache(PRECACHE, { models: true })).toBe(false)
    expect(erasesCache(APP_PRECACHE, { models: true })).toBe(false)
    expect(erasesCache('webllm/model', { models: true })).toBe(false)
  })
})
