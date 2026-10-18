/*
 * A local folder as a sync store, through the File System Access API (ported from the cursus provider): the object
 * `d/x/s/y/0000000/0000000001-abcdefgh` is the file `0000000001-abcdefgh` in the sub-folder `d/x/s/y/0000000`, written
 * with createWritable then close. A folder kept in a synced drive (iCloud, Dropbox, Syncthing) carries the store to
 * other computers. Names the browser or the OS leave there (`.DS_Store`, `.crswap`, a conflict copy `x 2`) are not
 * aparte/1 names, so the engine ignores them.
 *
 * The directory handle is not kept across reloads: a handle cannot be encrypted, and the device stores nothing
 * readable, so the user picks the folder again after a reload.
 */

import type { Bytes } from '../../contracts/crypto.ts'
import { type RemoteEntry, RemoteError, type RemoteStore } from '../../contracts/sync.ts'

/** The part of the File System Access API the store needs; a FileSystemDirectoryHandle fits it. */
export interface FsFile {
  readonly size: number
  arrayBuffer(): Promise<ArrayBuffer>
}
export interface FsWritable {
  write(data: Uint8Array<ArrayBuffer>): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}
export interface FsFileHandle {
  readonly kind: 'file'
  readonly name: string
  getFile(): Promise<FsFile>
  createWritable(): Promise<FsWritable>
}
export interface FsDirHandle {
  readonly kind: 'directory'
  readonly name: string
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsDirHandle>
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFileHandle>
  removeEntry(name: string): Promise<void>
  values(): AsyncIterable<FsDirHandle | FsFileHandle>
  /** Chromium only; absent elsewhere (then access is assumed granted). */
  queryPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>
}

const ignored = (name: string): boolean => name.startsWith('.') || name.endsWith('.crswap')

function parts(name: string): string[] {
  const out = name.split('/')
  for (const p of out)
    if (p === '' || p === '.' || p === '..' || ignored(p)) throw new RangeError(`Not storable in a folder: ${name}`)
  return out
}

/** DOMException names as store errors; NotFound and TypeMismatch mean "absent" and are handled by the callers. */
function fsError(e: unknown, what: string): RemoteError {
  if (e instanceof RemoteError) return e
  const name = e instanceof Error ? e.name : ''
  const message = `${what}: ${e instanceof Error ? e.message : String(e)}`
  if (name === 'NotAllowedError' || name === 'SecurityError') return new RemoteError('permission', message)
  if (name === 'QuotaExceededError') return new RemoteError('quota', message)
  return new RemoteError('network', message, { cause: e })
}

const absent = (e: unknown): boolean =>
  e instanceof Error && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')

export interface FolderStore extends RemoteStore {
  /** Asks again for access; must run inside a user gesture. True when granted. */
  requestPermission(): Promise<boolean>
}

export function folderStore(root: FsDirHandle, label: string = root.name): FolderStore {
  const granted = async (): Promise<void> => {
    const p = root.queryPermission ? await root.queryPermission({ mode: 'readwrite' }) : 'granted'
    if (p !== 'granted') throw new RemoteError('permission', `No access to the folder ${root.name} (${p})`)
  }

  const dir = async (path: string[], create: boolean): Promise<FsDirHandle | null> => {
    let d = root
    for (const p of path) {
      try {
        d = await d.getDirectoryHandle(p, { create })
      } catch (e) {
        if (!create && absent(e)) return null
        throw e
      }
    }
    return d
  }

  const walk = async (d: FsDirHandle, base: string, prefix: string, out: RemoteEntry[]): Promise<void> => {
    for await (const h of d.values()) {
      if (ignored(h.name)) continue
      const name = base + h.name
      if (h.kind === 'file') {
        if (name.startsWith(prefix)) out.push({ name, size: (await h.getFile()).size })
      } else {
        const sub = `${name}/`
        if (sub.startsWith(prefix) || prefix.startsWith(sub)) await walk(h, sub, prefix, out)
      }
    }
  }

  return {
    id: `folder:${label}`,
    kind: 'folder',
    keepsHistory: false,
    async requestPermission() {
      if (!root.requestPermission) return true
      return (await root.requestPermission({ mode: 'readwrite' })) === 'granted'
    },
    async list(prefix = '') {
      const out: RemoteEntry[] = []
      try {
        await granted()
        await walk(root, '', prefix, out)
      } catch (e) {
        throw fsError(e, `list ${prefix}`)
      }
      return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    },
    async get(entry) {
      const path = parts(entry.name)
      const file = path.pop() as string
      try {
        await granted()
        const d = await dir(path, false)
        if (!d) return null
        const f = await (await d.getFileHandle(file)).getFile()
        return new Uint8Array(await f.arrayBuffer()) as Bytes
      } catch (e) {
        if (absent(e)) return null
        throw fsError(e, `read ${entry.name}`)
      }
    },
    async put(name, bytes) {
      const path = parts(name)
      const file = path.pop() as string
      try {
        await granted()
        const d = (await dir(path, true)) as FsDirHandle
        const w = await (await d.getFileHandle(file, { create: true })).createWritable()
        try {
          await w.write(new Uint8Array(bytes))
        } catch (e) {
          await w.abort()
          throw e
        }
        await w.close()
      } catch (e) {
        throw fsError(e, `write ${name}`)
      }
    },
    async flush() {},
    async delete(name) {
      const path = parts(name)
      const file = path.pop() as string
      try {
        await granted()
        const d = await dir(path, false)
        if (d) await d.removeEntry(file)
      } catch (e) {
        if (!absent(e)) throw fsError(e, `delete ${name}`)
      }
    },
  }
}

/** An in-memory directory handle, for tests (and for any host without the File System Access API). */
export function memoryDir(name = 'root', permission: { state: PermissionState } = { state: 'granted' }): FsDirHandle {
  const dirs = new Map<string, FsDirHandle>()
  const files = new Map<string, Uint8Array>()
  const notFound = () => Object.assign(new Error('not found'), { name: 'NotFoundError' })
  const self: FsDirHandle = {
    kind: 'directory',
    name,
    async getDirectoryHandle(child, options) {
      let d = dirs.get(child)
      if (!d) {
        if (!options?.create) throw notFound()
        d = memoryDir(child, permission)
        dirs.set(child, d)
      }
      return d
    },
    async getFileHandle(child, options) {
      if (!files.has(child)) {
        if (!options?.create) throw notFound()
        files.set(child, new Uint8Array())
      }
      return {
        kind: 'file',
        name: child,
        async getFile() {
          const bytes = files.get(child) ?? new Uint8Array()
          return { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer }
        },
        async createWritable() {
          const chunks: Uint8Array[] = []
          return {
            async write(data) {
              chunks.push(new Uint8Array(data))
            },
            async close() {
              const total = chunks.reduce((n, c) => n + c.length, 0)
              const out = new Uint8Array(total)
              let at = 0
              for (const c of chunks) {
                out.set(c, at)
                at += c.length
              }
              files.set(child, out)
            },
            async abort() {},
          }
        },
      }
    },
    async removeEntry(child) {
      if (!files.delete(child) && !dirs.delete(child)) throw notFound()
    },
    async *values() {
      for (const d of dirs.values()) yield d
      for (const child of files.keys()) yield await self.getFileHandle(child)
    },
    async queryPermission() {
      return permission.state
    },
    async requestPermission() {
      permission.state = 'granted'
      return 'granted'
    },
  }
  return self
}
