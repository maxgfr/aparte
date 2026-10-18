import type { FetchLike } from '../core/contracts/ai.ts'
import { type ImportedSkill, SkillError } from '../core/contracts/skills.ts'
import { request } from '../security/net.ts'

/*
 * The skill imports of the Skills screen, on this page's side: GitHub through web/src/security/net.ts with purpose
 * `skills`, and a folder read through the File System Access API (or a directory input where the browser has none).
 * The reading and checking of what comes in is web/src/core/skills/import.ts; nothing here parses or runs a skill.
 *
 * Invariants:
 * - Only plain, unauthenticated GETs reach GitHub; no token, no cookie, no referrer (net.ts).
 * - A folder is walked to the same depth and with the same skips as a skill keeps (hidden entries, dependency
 *   folders), and at most MAX_ENTRIES entries are read, so picking a large tree by mistake stays bounded.
 */

/** The fetch of skill imports: net.ts with purpose `skills`. */
export const skillsFetch: FetchLike = (input, init) => {
  const url = input instanceof Request ? input.url : input
  return request(url, { ...init, purpose: 'skills' })
}

/** Entries of a picked folder read at most. */
const MAX_ENTRIES = 2000
/** Directory levels walked below the picked folder (a skill may sit one level down, then three inside it). */
const MAX_LEVELS = 5
const SKIPPED = new Set(['node_modules', '__pycache__', 'target'])

export interface PickedFile {
  readonly path: string
  readonly data: Uint8Array
}

interface DirectoryHandle {
  readonly kind: 'directory'
  readonly name: string
  values(): AsyncIterable<DirectoryHandle | FileHandle>
}

interface FileHandle {
  readonly kind: 'file'
  readonly name: string
  getFile(): Promise<File>
}

type PickerWindow = { showDirectoryPicker?: (options?: { mode?: 'read' }) => Promise<DirectoryHandle> }

/** Whether this browser can pick a folder through the File System Access API. */
export function canPickDirectory(): boolean {
  return typeof (globalThis as PickerWindow).showDirectoryPicker === 'function'
}

const skipped = (name: string) => name.startsWith('.') || SKIPPED.has(name)

/** Asks the user for a folder and reads it; null when the user cancelled. */
export async function pickDirectory(): Promise<{ name: string; files: PickedFile[] } | null> {
  const picker = (globalThis as PickerWindow).showDirectoryPicker
  if (picker === undefined) return null
  let root: DirectoryHandle
  try {
    root = await picker({ mode: 'read' })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null
    throw error
  }
  const files: PickedFile[] = []
  let entries = 0
  const walk = async (dir: DirectoryHandle, prefix: string, level: number): Promise<void> => {
    for await (const entry of dir.values()) {
      if (++entries > MAX_ENTRIES) throw new SkillError('too-large', 'The folder has too many entries')
      if (skipped(entry.name)) continue
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.kind === 'directory') {
        if (level < MAX_LEVELS) await walk(entry, path, level + 1)
      } else {
        const file = await entry.getFile()
        files.push({ path, data: new Uint8Array(await file.arrayBuffer()) })
      }
    }
  }
  await walk(root, '', 0)
  return { name: root.name, files }
}

/** The files of a directory input (`webkitdirectory`): their relative paths, the picked folder's name first. */
export async function readDirectoryInput(list: FileList): Promise<{ name: string; files: PickedFile[] }> {
  const files: PickedFile[] = []
  let name = ''
  const all = [...list]
  if (all.length > MAX_ENTRIES) throw new SkillError('too-large', 'The folder has too many entries')
  for (const file of all) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    const segments = relative.split('/')
    if (name === '' && segments.length > 1) name = segments[0] ?? ''
    // The picked folder's own name is the first segment; what is under it is the folder's content.
    const inside = segments.length > 1 ? segments.slice(1) : segments
    if (inside.length > MAX_LEVELS + 1 || inside.some(skipped)) continue
    files.push({ path: inside.join('/'), data: new Uint8Array(await file.arrayBuffer()) })
  }
  return { name: name || 'folder', files }
}

/** The number of files an import left out, in all. */
export function skippedCount(imported: readonly ImportedSkill[]): number {
  return imported.reduce((n, s) => n + s.skipped.length, 0)
}
