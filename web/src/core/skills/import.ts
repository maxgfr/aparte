/*
 * Skill imports: from a public GitHub repository (its API for the tree, raw.githubusercontent.com for the files),
 * from a zip archive, or from a folder the user picked. Each finds the skill directories of its source
 * (bundle.ts `findSkillRoots`), keeps their files within the limits and reads their `SKILL.md` as the CLI would.
 *
 * Invariants:
 * - Network access is the `download` the caller passes: web/src/security/net.ts with purpose `skills`. Every request is a
 *   plain GET without credentials or custom headers (no CORS preflight), unauthenticated: public repositories only.
 * - A GitHub import reads one commit: the one the ref pointed to when the import started, recorded in the source, so
 *   every file of a skill comes from the same tree.
 * - Sizes are checked before anything is downloaded or inflated (the tree's sizes, the archive's headers), and the zip
 *   reader refuses an entry that inflates beyond its declared size.
 * - One unreadable `SKILL.md` does not stop the others: it is reported in `problems`. An import that finds no skill,
 *   or none it can read, is a SkillError.
 * - An abort of the caller's signal rejects with its AbortError; every other failure is a SkillError.
 */

import type { FetchLike } from '../contracts/ai.ts'
import type { Bytes } from '../contracts/crypto.ts'
import { ExtractError } from '../contracts/knowledge.ts'
import {
  type GitHubSource,
  type ImportedSkill,
  type ImportResult,
  SkillError,
  type SkillFile,
  type SkillSource,
} from '../contracts/skills.ts'
import { ZipReader } from '../knowledge/zip.ts'
import { bundleOf, findSkillRoots, SKILL_MD, type SourceEntry, safeSkillPath } from './bundle.ts'
import { parseSkillMd } from './parse.ts'

const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO = /^[A-Za-z0-9._-]{1,100}$/
const REF = /^[A-Za-z0-9._/-]{1,250}$/

function malformed(input: string): SkillError {
  return new SkillError(
    'malformed',
    `${JSON.stringify(input)} names no GitHub repository: use owner/repo, owner/repo/path or a github.com address`,
  )
}

function checked(input: string, owner: string, repo: string, ref: string | null, path: string): GitHubSource {
  const name = repo.endsWith('.git') ? repo.slice(0, -4) : repo
  if (!OWNER.test(owner) || !REPO.test(name) || name === '.' || name === '..') throw malformed(input)
  if (ref !== null && (!REF.test(ref) || ref.includes('..') || ref.startsWith('/') || ref.endsWith('/')))
    throw malformed(input)
  const clean = path === '' ? '' : safeSkillPath(path)
  if (clean === null) throw malformed(input)
  return { owner, repo: name, ref, path: clean }
}

/**
 * Where to import from: `owner/repo`, `owner/repo/sub/dir`, `owner/repo@ref`, `owner/repo@ref/sub/dir`, or a
 * github.com address (`/tree/<ref>/<path>`, or `/blob/<ref>/<path>` of a file: its directory).
 */
export function parseGitHubSource(input: string): GitHubSource {
  let text = input.trim()
  const web = /^(?:https?:\/\/)?(?:www\.)?github\.com\//i.exec(text)
  if (web !== null) {
    text = text.slice(web[0].length).replace(/[?#].*$/, '')
    const segments = text.split('/').filter((s) => s !== '')
    const [owner = '', repo = '', kind, ref, ...rest] = segments.map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        throw malformed(input)
      }
    })
    if (kind === undefined) return checked(input, owner, repo, null, '')
    if ((kind !== 'tree' && kind !== 'blob') || ref === undefined) throw malformed(input)
    const path = kind === 'blob' ? rest.slice(0, -1) : rest
    return checked(input, owner, repo, ref, path.join('/'))
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) throw malformed(input)
  text = text.replace(/\/+$/, '')
  const at = text.indexOf('@')
  if (at >= 0) {
    const [owner = '', repo = ''] = text.slice(0, at).split('/')
    if (text.slice(0, at).split('/').length !== 2) throw malformed(input)
    const after = text.slice(at + 1)
    const slash = after.indexOf('/')
    const ref = slash < 0 ? after : after.slice(0, slash)
    return checked(input, owner, repo, ref, slash < 0 ? '' : after.slice(slash + 1))
  }
  const [owner = '', repo = '', ...rest] = text.split('/')
  return checked(input, owner, repo, null, rest.join('/'))
}

/** The name a skill at `root` defaults to: its directory's, or `fallback` for the source's own root. */
function dirNameOf(root: string, fallback: string): string {
  return root === '' ? fallback : (root.split('/').at(-1) ?? fallback)
}

const lenient = new TextDecoder('utf-8')

const byPath = (a: SkillFile, b: SkillFile) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/** The skill of `files` (relative to its directory), or the reason it cannot be read. */
function skillOf(
  files: SkillFile[],
  skipped: readonly string[],
  source: SkillSource,
  dirName: string,
): ImportedSkill | string {
  const md = files.find((f) => f.path === SKILL_MD)
  const where = source.path === '' ? SKILL_MD : `${source.path}/${SKILL_MD}`
  if (md === undefined) return `${where}: ${skipped.find((s) => s.startsWith(`${SKILL_MD}:`)) ?? 'not read'}`
  try {
    return { parsed: parseSkillMd(lenient.decode(md.data), dirName), source, files: files.sort(byPath), skipped }
  } catch (error) {
    if (error instanceof SkillError) return `${where}: ${error.message}`
    throw error
  }
}

function result(found: (ImportedSkill | string)[], where: string): ImportResult {
  const skills = found.filter((f): f is ImportedSkill => typeof f !== 'string')
  const problems = found.filter((f): f is string => typeof f === 'string')
  if (found.length === 0) throw new SkillError('not-found', `No SKILL.md in ${where}`)
  if (skills.length === 0) {
    throw new SkillError('invalid', problems.length === 1 ? (problems[0] as string) : problems.join('\n'))
  }
  return { skills, problems }
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError')
}

async function get(download: FetchLike, url: string, signal: AbortSignal | undefined): Promise<Response> {
  let response: Response
  try {
    response = await download(url, signal === undefined ? { method: 'GET' } : { method: 'GET', signal })
  } catch (error) {
    if (isAbort(error, signal)) throw error
    throw new SkillError(
      'network',
      `GitHub could not be reached (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (response.ok) return response
  const where = url.replace(/\?.*$/, '')
  if (response.status === 404) throw new SkillError('not-found', `Not found on GitHub: ${where}`)
  if (response.status === 429 || (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')) {
    throw new SkillError('rate-limited', 'GitHub’s limit for requests without an account is reached; try again later')
  }
  throw new SkillError('network', `GitHub answered ${response.status} for ${where}`)
}

async function getJson(
  download: FetchLike,
  url: string,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const response = await get(download, url, signal)
  try {
    const value: unknown = await response.json()
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch (error) {
    if (isAbort(error, signal)) throw error
  }
  throw new SkillError('network', `GitHub sent an unexpected answer for ${url.replace(/\?.*$/, '')}`)
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/')

/** Runs `fn` over `items`, `limit` at a time, keeping their order. */
async function pooled<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

interface TreeEntry extends SourceEntry {
  readonly type: string
}

/** The skills of a public GitHub repository at `source` (its root or one of its directories). */
export async function importFromGitHub(
  source: GitHubSource,
  download: FetchLike,
  signal?: AbortSignal,
): Promise<ImportResult> {
  const repo = `${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`
  let ref = source.ref
  if (ref === null) {
    const info = await getJson(download, `${API}/repos/${repo}`, signal)
    if (typeof info.default_branch !== 'string' || info.default_branch === '') {
      throw new SkillError('network', 'GitHub did not name the default branch')
    }
    ref = info.default_branch
  }
  const commit = await getJson(download, `${API}/repos/${repo}/commits/${encodeURIComponent(ref)}`, signal)
  const sha = commit.sha
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new SkillError('network', 'GitHub sent no commit')
  const tree = await getJson(download, `${API}/repos/${repo}/git/trees/${sha}?recursive=1`, signal)
  if (tree.truncated === true) {
    throw new SkillError('too-large', 'The repository is too large to list at once: import the skill’s own directory')
  }
  if (!Array.isArray(tree.tree)) throw new SkillError('network', 'GitHub sent no file list')
  const prefix = source.path
  const entries: TreeEntry[] = []
  for (const raw of tree.tree as unknown[]) {
    const e = raw as { path?: unknown; type?: unknown; size?: unknown } | null
    if (e === null || typeof e !== 'object' || e.type !== 'blob' || typeof e.path !== 'string') continue
    if (prefix !== '' && e.path !== prefix && !e.path.startsWith(`${prefix}/`)) continue
    const size = typeof e.size === 'number' && Number.isSafeInteger(e.size) && e.size >= 0 ? e.size : 0
    entries.push({ path: e.path, size, type: e.type })
  }
  const where = `${source.owner}/${source.repo}${prefix === '' ? '' : `/${prefix}`}`
  const found: (ImportedSkill | string)[] = []
  for (const root of findSkillRoots(entries.map((e) => e.path))) {
    const { kept, skipped } = bundleOf(entries, root)
    const files = await pooled(kept, 4, async ({ entry, path }): Promise<SkillFile> => {
      const response = await get(download, `${RAW}/${repo}/${sha}/${encodePath(entry.path)}`, signal)
      return { path, data: new Uint8Array(await response.arrayBuffer()) as Bytes }
    })
    const skillSource: SkillSource = {
      kind: 'github',
      repo: `${source.owner}/${source.repo}`,
      path: root,
      ref,
      commit: sha,
    }
    found.push(skillOf(files, skipped, skillSource, dirNameOf(root, source.repo)))
  }
  return result(found, where)
}

/** The name of an archive or folder without its extension: the name of a skill at its root. */
function stem(name: string): string {
  const base = name.split(/[\\/]/).at(-1) ?? name
  return base.replace(/\.zip$/i, '')
}

/** The skills of in-memory files (a picked folder, an archive's entries). */
function fromEntries(
  entries: readonly (SourceEntry & { readonly read: () => Uint8Array })[],
  kind: 'zip' | 'folder',
  name: string,
): ImportResult {
  const found: (ImportedSkill | string)[] = []
  for (const root of findSkillRoots(entries.map((e) => e.path))) {
    const { kept, skipped } = bundleOf(entries, root)
    const files = kept.map(({ entry, path }): SkillFile => ({ path, data: new Uint8Array(entry.read()) as Bytes }))
    found.push(skillOf(files, skipped, { kind, name, path: root }, dirNameOf(root, stem(name))))
  }
  return result(found, name)
}

/** The skills of a zip archive named `name`. */
export function importFromZip(bytes: Uint8Array, name: string): ImportResult {
  try {
    const zip = new ZipReader(bytes)
    const entries = zip
      .names()
      .filter((n) => !n.endsWith('/'))
      .map((n) => ({ path: n, size: zip.size(n) ?? 0, read: () => zip.read(n) ?? new Uint8Array() }))
    return fromEntries(entries, 'zip', name)
  } catch (error) {
    if (error instanceof ExtractError) {
      throw new SkillError(error.kind === 'too-large' ? 'too-large' : 'malformed', error.message)
    }
    throw error
  }
}

/** The skills of a folder the user picked: its files, paths relative to it (or starting with its own name). */
export function importFromFiles(
  files: readonly { readonly path: string; readonly data: Uint8Array }[],
  name: string,
): ImportResult {
  // A browser names the files of a picked folder after it (`webkitRelativePath`): that first segment is the folder.
  const prefix = `${name}/`
  const strip = files.length > 0 && files.every((f) => f.path.replaceAll('\\', '/').startsWith(prefix))
  return fromEntries(
    files.map((f) => ({
      path: strip ? f.path.replaceAll('\\', '/').slice(prefix.length) : f.path,
      size: f.data.length,
      read: () => f.data,
    })),
    'folder',
    name,
  )
}
