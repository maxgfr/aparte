import type { Page } from '@playwright/test'

/*
 * The plaintext canary: everything the app keeps on the device (IndexedDB, localStorage, sessionStorage,
 * CacheStorage, the origin private file system), read back as the bytes a thief of the disk would get, then searched
 * for strings that must only ever be stored encrypted (a message, an answer, an API key, a photo's GPS tag).
 */

/** One place on the device and what it holds, as Latin-1 text (one character per byte, so binary survives). */
export interface Stored {
  readonly where: string
  readonly text: string
}

/** Reads everything the page's origin stores. Runs in the page; nothing is written or deleted. */
export async function dumpStorage(page: Page): Promise<Stored[]> {
  return page.evaluate(async () => {
    const latin1 = (bytes: Uint8Array) => {
      let s = ''
      for (let i = 0; i < bytes.length; i += 0x8000)
        s += String.fromCharCode(...bytes.subarray(i, Math.min(bytes.length, i + 0x8000)))
      return s
    }
    /** Every string and byte run inside a structured-clone value, keys included. */
    const flatten = async (value: unknown, out: string[], seen: Set<unknown>): Promise<void> => {
      if (value === null || value === undefined) return
      if (typeof value === 'string') {
        out.push(value)
        return
      }
      if (typeof value !== 'object') {
        out.push(String(value))
        return
      }
      if (seen.has(value)) return
      seen.add(value)
      if (value instanceof ArrayBuffer) out.push(latin1(new Uint8Array(value)))
      else if (ArrayBuffer.isView(value))
        out.push(latin1(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)))
      else if (value instanceof Blob) out.push(latin1(new Uint8Array(await value.arrayBuffer())))
      else if (value instanceof Map)
        for (const [k, v] of value) {
          await flatten(k, out, seen)
          await flatten(v, out, seen)
        }
      else if (value instanceof Set) for (const v of value) await flatten(v, out, seen)
      else
        for (const [k, v] of Object.entries(value)) {
          out.push(k)
          await flatten(v, out, seen)
        }
    }
    const request = <T>(r: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        r.onsuccess = () => resolve(r.result)
        r.onerror = () => reject(r.error)
      })

    const found: { where: string; text: string }[] = []
    const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : []
    for (const info of databases) {
      if (!info.name) continue
      const db = await request(indexedDB.open(info.name))
      try {
        for (const storeName of [...db.objectStoreNames]) {
          const store = db.transaction(storeName, 'readonly').objectStore(storeName)
          const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())])
          const out: string[] = []
          await flatten(keys, out, new Set())
          await flatten(values, out, new Set())
          found.push({ where: `indexedDB ${info.name}/${storeName}`, text: out.join('\n') })
        }
      } finally {
        db.close()
      }
    }
    for (const [name, area] of [
      ['localStorage', localStorage],
      ['sessionStorage', sessionStorage],
    ] as const) {
      const out: string[] = []
      for (let i = 0; i < area.length; i++) {
        const key = area.key(i)
        if (key === null) continue
        out.push(key, area.getItem(key) ?? '')
      }
      found.push({ where: name, text: out.join('\n') })
    }
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      const out: string[] = []
      for (const req of await cache.keys()) {
        const res = await cache.match(req)
        out.push(req.url, res ? latin1(new Uint8Array(await res.arrayBuffer())) : '')
      }
      found.push({ where: `CacheStorage ${name}`, text: out.join('\n') })
    }
    try {
      const walk = async (dir: FileSystemDirectoryHandle, path: string): Promise<void> => {
        for await (const [name, handle] of (
          dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }
        ).entries()) {
          if (handle.kind === 'directory') await walk(handle as FileSystemDirectoryHandle, `${path}/${name}`)
          else {
            const file = await (handle as FileSystemFileHandle).getFile()
            found.push({
              where: `OPFS ${path}/${name}`,
              text: `${name}\n${latin1(new Uint8Array(await file.arrayBuffer()))}`,
            })
          }
        }
      }
      await walk(await navigator.storage.getDirectory(), '')
    } catch {
      // No origin private file system in this engine or this context: nothing is stored there.
    }
    return found
  })
}

/** Base64 of `s` at the three byte alignments, minus the edge characters that depend on the neighbours. */
function base64Forms(s: string): string[] {
  const bytes = new TextEncoder().encode(s)
  const forms: string[] = []
  for (let pad = 0; pad < 3; pad++) {
    const padded = new Uint8Array(pad + bytes.length)
    padded.set(bytes, pad)
    const b64 = Buffer.from(padded).toString('base64')
    // Character i encodes bits 6i to 6i + 5: it depends on the canary alone when those bits lie in its bytes.
    const start = Math.ceil((4 * pad) / 3)
    const end = Math.floor((4 * (pad + bytes.length) - 3) / 3) + 1
    forms.push(b64.slice(start, end))
  }
  return forms.filter((f) => f.length >= 8)
}

/** Every encoding of `canary` a plaintext store could hold it in: UTF-8, UTF-16 (either byte order) and base64. */
function encodings(canary: string): string[] {
  const utf8 = Buffer.from(canary, 'utf8').toString('latin1')
  const utf16le = Buffer.from(canary, 'utf16le').toString('latin1')
  const utf16be = Buffer.from(canary, 'utf16le').swap16().toString('latin1')
  return [canary, utf8, utf16le, utf16be, ...base64Forms(canary)]
}

/** Where each canary was found in plaintext: `["<canary> in <where>", ...]`, empty when none was. */
export function plaintextHits(stored: readonly Stored[], canaries: readonly string[]): string[] {
  const hits: string[] = []
  for (const canary of canaries)
    for (const place of stored)
      if (encodings(canary).some((form) => place.text.includes(form))) hits.push(`${canary} in ${place.where}`)
  return hits
}
