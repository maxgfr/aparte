/*
 * A skill's files as one blob (contracts/skills.ts `SkillBundle`), and the rules that decide which files of a source
 * make up a skill: where its `SKILL.md` roots are, which paths are kept (crates/aparte-skills/src/tool.rs `files`:
 * no hidden file or folder, no dependency folder, three directory levels at most) and what the limits leave out.
 *
 * Invariants:
 * - A path is relative, `/` separated, without `.`, `..`, NUL or a leading slash; anything else is refused before it
 *   can name a file outside the skill.
 * - The bundle is a pure function of the files: sorted by path, text kept as text when it is valid UTF-8 without NUL
 *   (a byte order mark included), any other file as standard base64. Decoding gives back the same bytes.
 * - A bundle that does not decode exactly to this shape is refused (`malformed`), never partly read.
 * - The limits (SKILL_LIMITS) are applied in path order with `SKILL.md` first, so the instructions are always kept.
 */

import { type Bytes, InvalidInputError } from '../contracts/crypto.ts'
import { MAX_SKILL_DEPTH, SKILL_LIMITS, type SkillBundle, SkillError, type SkillFile } from '../contracts/skills.ts'
import { base64urlDecode, base64urlEncode } from '../crypto/bytes.ts'

/** The instructions file of a skill. */
export const SKILL_MD = 'SKILL.md'

/** Folders a skill's listing never descends into (crates/aparte-skills `files`). */
const EXCLUDED: ReadonlySet<string> = new Set(['node_modules', '__pycache__', 'target'])

/** A relative path made safe: `\` as `/`, a leading `./` removed; null when it is absolute, empty or climbs out. */
export function safeSkillPath(raw: string): string | null {
  let p = raw.replaceAll('\\', '/')
  while (p.startsWith('./')) p = p.slice(2)
  if (p === '' || p.startsWith('/') || p.includes('\0') || /^[A-Za-z]:/.test(p)) return null
  const segments = p.split('/')
  if (segments.at(-1) === '') segments.pop()
  if (segments.length === 0 || segments.some((s) => s === '' || s === '.' || s === '..')) return null
  return segments.join('/')
}

const hiddenOrExcluded = (segment: string): boolean => segment.startsWith('.') || EXCLUDED.has(segment)

/** Whether a file of a skill (path relative to its directory) is part of it. */
export function keptPath(rel: string): boolean {
  const segments = rel.split('/')
  if (segments.some(hiddenOrExcluded)) return false
  return segments.length - 1 <= MAX_SKILL_DEPTH
}

/** The directory of a path (`''` for a file at the top). */
export function dirOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}

/**
 * The skill directories among `paths` (file paths of a source): every directory holding a `SKILL.md`, outside hidden
 * and dependency folders, `''` for the source's own root. A `SKILL.md` below another skill's directory is a file of
 * that skill, not a skill of its own. Sorted.
 */
export function findSkillRoots(paths: readonly string[]): string[] {
  const candidates = new Set<string>()
  for (const raw of paths) {
    const path = safeSkillPath(raw)
    if (path === null || (path !== SKILL_MD && !path.endsWith(`/${SKILL_MD}`))) continue
    const dir = dirOf(path)
    if (dir !== '' && dir.split('/').some(hiddenOrExcluded)) continue
    candidates.add(dir)
  }
  const under = (dir: string, root: string) => root === '' || dir.startsWith(`${root}/`)
  return [...candidates].filter((d) => ![...candidates].some((r) => r !== d && under(d, r))).sort()
}

/** One file of a source as an importer sees it: its path in the source and its size, known before reading it. */
export interface SourceEntry {
  readonly path: string
  readonly size: number
}

const mib = (n: number) => `${Math.round(n / (1024 * 1024))} MiB`

/**
 * The files of the skill at `root` among `entries`: their path relative to the root, the kept ones in path order
 * (`SKILL.md` first), and a line for each file the limits left out. Hidden files and dependency folders are not part
 * of a skill and are left out silently; deeper files and files over a limit are reported.
 */
export function bundleOf<T extends SourceEntry>(
  entries: readonly T[],
  root: string,
): { readonly kept: readonly { readonly entry: T; readonly path: string }[]; readonly skipped: readonly string[] } {
  const inside: { entry: T; path: string }[] = []
  for (const entry of entries) {
    const path = safeSkillPath(entry.path)
    if (path === null) continue
    if (root !== '' && !path.startsWith(`${root}/`)) continue
    const rel = root === '' ? path : path.slice(root.length + 1)
    inside.push({ entry, path: rel })
  }
  inside.sort((a, b) =>
    a.path === SKILL_MD ? -1 : b.path === SKILL_MD ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )
  const kept: { entry: T; path: string }[] = []
  const skipped: string[] = []
  let total = 0
  const seen = new Set<string>()
  for (const item of inside) {
    if (seen.has(item.path)) continue
    seen.add(item.path)
    const segments = item.path.split('/')
    if (segments.some(hiddenOrExcluded)) continue
    if (!keptPath(item.path)) {
      skipped.push(`${item.path}: deeper than ${MAX_SKILL_DEPTH} folder levels`)
    } else if (item.entry.size > SKILL_LIMITS.maxFileBytes) {
      skipped.push(`${item.path}: larger than ${mib(SKILL_LIMITS.maxFileBytes)}`)
    } else if (kept.length >= SKILL_LIMITS.maxFiles) {
      skipped.push(`${item.path}: over the ${SKILL_LIMITS.maxFiles} files a skill may hold`)
    } else if (total + item.entry.size > SKILL_LIMITS.maxTotalBytes) {
      skipped.push(`${item.path}: over the ${mib(SKILL_LIMITS.maxTotalBytes)} a skill may hold`)
    } else {
      total += item.entry.size
      kept.push(item)
    }
  }
  return { kept, skipped }
}

// The bundle blob

const textDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const textEncoder = new TextEncoder()

/** The text of a file, or null when it is not valid UTF-8 or holds a NUL. */
export function asText(data: Uint8Array): string | null {
  if (data.includes(0)) return null
  try {
    return textDecoder.decode(data)
  } catch {
    return null
  }
}

function toBase64(bytes: Uint8Array): string {
  const url = base64urlEncode(bytes).replaceAll('-', '+').replaceAll('_', '/')
  return url + '='.repeat((4 - (url.length % 4)) % 4)
}

function fromBase64(text: string): Bytes {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) throw new InvalidInputError('Invalid base64')
  return base64urlDecode(text.replace(/=+$/, '').replaceAll('+', '-').replaceAll('/', '_'))
}

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/** The bundle blob of a skill's files. */
export function encodeBundle(files: readonly SkillFile[]): Uint8Array {
  const out: SkillBundle['files'][number][] = []
  const seen = new Set<string>()
  for (const file of [...files].sort(byPath)) {
    const path = safeSkillPath(file.path)
    if (path === null || path !== file.path)
      throw new SkillError('malformed', `Unsafe path ${JSON.stringify(file.path)}`)
    if (seen.has(path)) throw new SkillError('malformed', `Two files named ${path}`)
    seen.add(path)
    const text = asText(file.data)
    out.push(text === null ? { path, base64: toBase64(file.data) } : { path, text })
  }
  const bundle: SkillBundle = { v: 1, files: out }
  return textEncoder.encode(JSON.stringify(bundle))
}

/** A skill's files from its bundle blob. SkillError `malformed` for anything but a well-formed bundle. */
export function decodeBundle(bytes: Uint8Array): SkillFile[] {
  const bad = (why: string) => new SkillError('malformed', `Not a skill bundle: ${why}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(textDecoder.decode(bytes))
  } catch {
    throw bad('not JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad('not an object')
  const b = parsed as { v?: unknown; files?: unknown }
  if (b.v !== 1) throw bad('unknown version')
  if (!Array.isArray(b.files)) throw bad('no file list')
  const out: SkillFile[] = []
  const seen = new Set<string>()
  for (const item of b.files as unknown[]) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw bad('a file is not an object')
    const f = item as Record<string, unknown>
    const keys = Object.keys(f).sort()
    if (typeof f.path !== 'string' || safeSkillPath(f.path) !== f.path) throw bad('an unsafe path')
    if (seen.has(f.path)) throw bad(`two files named ${f.path}`)
    seen.add(f.path)
    if (keys.length === 2 && keys[0] === 'path' && keys[1] === 'text' && typeof f.text === 'string') {
      out.push({ path: f.path, data: textEncoder.encode(f.text) })
    } else if (keys.length === 2 && keys[0] === 'base64' && keys[1] === 'path' && typeof f.base64 === 'string') {
      try {
        out.push({ path: f.path, data: fromBase64(f.base64) })
      } catch {
        throw bad(`invalid base64 in ${f.path}`)
      }
    } else throw bad(`${f.path} has neither text nor base64`)
  }
  return out.sort(byPath)
}
