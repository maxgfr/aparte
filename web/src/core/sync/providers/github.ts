/*
 * A GitHub repository as a sync store, through the REST API (Git Data API), ported from the cursus provider.
 *
 * Every object is a file `<root>/<name>` (root `aparte` by default) whose content is the standard base64 of the
 * object's bytes (spec/FORMAT.md section 10.5): Git trees take inline content as UTF-8 text only, and inline content
 * lets one tree request carry many objects. `put` only stages an object; `flush` writes everything staged as ONE
 * commit (one or a few trees, one commit, one fast-forward of the branch), rebuilt on top of a head another device
 * moved. Every content-creating request goes through the pacer (at most 60 a minute, evenly spaced, and 450 an hour),
 * and a 403 or 429 rate-limit answer pauses all writes for the Retry-After the server gave.
 *
 * Commits always carry the same message and author, so the history reveals when objects were written but not who
 * wrote them or what they are. Requests go through the `http` function the app gives (web/src/security/net.ts).
 */

import type { Bytes } from '../../contracts/crypto.ts'
import {
  type RemoteEntry,
  RemoteError,
  type RemoteStore,
  type StoreInfo,
  type WritePace,
} from '../../contracts/sync.ts'
import { createPacer, type Pacer } from './pacer.ts'

export const GITHUB_API = 'https://api.github.com'
export const GITHUB_API_VERSION = '2022-11-28'
export const DEFAULT_ROOT = 'aparte'
/** Inline content sent in one tree request at most; a larger batch is split into several trees. */
export const MAX_TREE_BYTES = 4 * 1024 * 1024
/** Staged content above which `put` writes at once. */
export const MAX_BATCH_BYTES = 16 * 1024 * 1024
/** Written by the first commit of an empty repository; never listed as an object. */
export const README = 'README.md'
export const README_TEXT =
  'This folder holds an Aparté vault: encrypted objects in the aparte/1 format.\n\n' +
  'Do not edit, move or delete these files: the devices that sync here would no longer read them.\n'
/** The one commit message and author every write uses. */
export const COMMIT_MESSAGE = 'aparte: objects'
export const COMMIT_AUTHOR = { name: 'aparte', email: 'aparte@users.noreply.github.com' }
/** GitHub recommends repositories below 1 GB; past this the status screen warns. */
export const SIZE_WARNING_BYTES = 1024 ** 3

/** The fetch the store uses; the app passes net.ts `request` with purpose `sync`. */
export type Http = (url: string, init: RequestInit) => Promise<Response>

export interface GitHubTarget {
  readonly owner: string
  readonly repo: string
  /** Empty: the repository's default branch. */
  readonly branch?: string
  /** Folder of the repository holding the store; `aparte` when empty. */
  readonly root?: string
  readonly apiBase?: string
}

export interface GitHubOptions extends GitHubTarget {
  /** Fine-grained personal access token: this repository only, Contents read and write. */
  readonly token: string
  readonly http: Http
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly pacer?: Pacer
  readonly maxTreeBytes?: number
  readonly maxBatchBytes?: number
  /** Rebuilds on top of a branch another device moved, at most this many times per flush. */
  readonly maxRefRetries?: number
}

export interface GitHubStore extends RemoteStore {
  readonly pacer: Pacer
  /** Objects staged and not written yet. */
  readonly staged: number
}

const enc = new TextEncoder()

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(text: string): Bytes {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const rootOf = (root?: string): string => {
  const trimmed = (root ?? '').trim().replace(/^\/+|\/+$/g, '')
  return trimmed === '' ? DEFAULT_ROOT : trimmed
}

/** Same owner, repository, branch and folder, same destination on every device. Owner and repo ignore case. */
export function githubStoreId(t: GitHubTarget): string {
  const api = (t.apiBase ?? GITHUB_API).replace(/\/+$/, '')
  return `github:${api}/${t.owner.trim().toLowerCase()}/${t.repo.trim().toLowerCase()}#${(t.branch ?? '').trim()}/${rootOf(t.root)}`
}

const encPath = (p: string): string => p.split('/').map(encodeURIComponent).join('/')

/** Wait asked by GitHub: `retry-after` (seconds), or `x-ratelimit-reset` once `x-ratelimit-remaining` is 0. */
function rateLimitWait(h: Headers, now: number): number | undefined {
  const after = Number(h.get('retry-after') ?? Number.NaN)
  if (Number.isFinite(after)) return Math.max(0, after * 1000)
  if (h.get('x-ratelimit-remaining') === '0') {
    const reset = Number(h.get('x-ratelimit-reset') ?? Number.NaN)
    if (Number.isFinite(reset)) return Math.max(0, reset * 1000 - now)
  }
  return undefined
}

/** A failed answer as a RemoteError: 401 auth, 403/429 rate limit, 404 not found, 413 quota, 5xx network. */
export async function githubError(res: Response, what: string, now: number): Promise<RemoteError> {
  const text = await res.text().catch(() => '')
  let message = text
  try {
    message = String((JSON.parse(text) as { message?: string }).message ?? text)
  } catch {
    // Not JSON: the text is the message.
  }
  const detail = `GitHub ${what}: HTTP ${res.status}${message ? ` ${message.slice(0, 200)}` : ''}`
  const wait = rateLimitWait(res.headers, now)
  if (res.status === 401) return new RemoteError('auth', detail)
  if (res.status === 429 || (res.status === 403 && (wait !== undefined || /rate limit/i.test(message)))) {
    return new RemoteError('rate-limited', detail, { retryAfterMs: wait ?? 60_000 })
  }
  if (res.status === 404) return new RemoteError('not-found', detail)
  if (res.status === 413) return new RemoteError('quota', detail)
  if (res.status >= 500) return new RemoteError('network', detail)
  return new RemoteError('permission', detail)
}

/** `github-authentication-token-expiration: 2026-11-01 12:00:00 UTC`, as Unix ms. */
export function tokenExpiry(h: Headers): number | undefined {
  const raw = h.get('github-authentication-token-expiration')
  if (!raw) return undefined
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?: ?(UTC|[+-]\d{4}))?$/.exec(raw.trim())
  if (!m) return undefined
  const zone = m[3] === undefined || m[3] === 'UTC' ? 'Z' : `${m[3].slice(0, 3)}:${m[3].slice(3)}`
  const t = Date.parse(`${m[1]}T${m[2]}${zone}`)
  return Number.isNaN(t) ? undefined : t
}

interface Client {
  call(
    method: string,
    path: string,
    options?: { body?: unknown; accept?: string; fresh?: boolean; write?: boolean },
  ): Promise<Response>
  fail(res: Response, what: string): Promise<RemoteError>
  /** The token expiry the last answer reported. */
  expiry(): number | undefined
}

function client(o: GitHubOptions, pacer: Pacer | null): Client {
  const now = o.now ?? (() => Date.now())
  const api = (o.apiBase ?? GITHUB_API).replace(/\/+$/, '')
  const repoUrl = `${api}/repos/${encodeURIComponent(o.owner.trim())}/${encodeURIComponent(o.repo.trim())}`
  let expiresAt: number | undefined
  return {
    async call(method, path, co = {}) {
      const url = path.startsWith('/') ? `${api}${path}` : path ? `${repoUrl}/${path}` : repoUrl
      const headers: Record<string, string> = {
        Authorization: `Bearer ${o.token}`,
        Accept: co.accept ?? 'application/vnd.github+json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      }
      if (co.body !== undefined) headers['Content-Type'] = 'application/json'
      if (co.write && pacer) await pacer.slot()
      let res: Response
      try {
        res = await o.http(url, {
          method,
          headers,
          ...(co.body !== undefined ? { body: JSON.stringify(co.body) } : {}),
          // A branch head must never come from the HTTP cache (GitHub allows 60 s); objects by sha never change.
          ...(co.fresh ? { cache: 'no-store' as RequestCache } : {}),
        })
      } catch (cause) {
        throw new RemoteError('network', `GitHub ${method} ${path || 'repository'}: no answer`, { cause })
      }
      expiresAt = tokenExpiry(res.headers) ?? expiresAt
      if ((res.status === 403 || res.status === 429) && pacer) {
        const wait = rateLimitWait(res.headers, now())
        if (wait !== undefined) pacer.pause(wait)
      }
      return res
    },
    fail: (res, what) => githubError(res, what, now()),
    expiry: () => expiresAt,
  }
}

interface TreeItem {
  readonly path: string
  readonly type: string
  readonly sha: string
  readonly size?: number
}
interface TreeAnswer {
  readonly sha: string
  readonly tree: TreeItem[]
  readonly truncated?: boolean
}
interface Head {
  readonly commit: string
  readonly tree: string
  /** name (without the root) -> blob sha */
  readonly entries: Map<string, string>
}
type HeadState = Head | { readonly commit: null; readonly reason: 'empty' | 'missing' }
/** A staged object (its base64 text) or a staged deletion (null). */
type Staged = string | null

export function githubStore(o: GitHubOptions): GitHubStore {
  const root = rootOf(o.root)
  const now = o.now ?? (() => Date.now())
  const pacer =
    o.pacer ?? createPacer({ now, sleep: o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))) })
  const c = client(o, pacer)
  const maxTreeBytes = o.maxTreeBytes ?? MAX_TREE_BYTES
  const maxBatchBytes = o.maxBatchBytes ?? MAX_BATCH_BYTES
  const maxRefRetries = o.maxRefRetries ?? 5
  const repoName = `${o.owner}/${o.repo}`

  let branchName: string | null = o.branch?.trim() || null
  let cache: Head | null = null
  const staged = new Map<string, Staged>()
  let stagedBytes = 0
  let running: Promise<void> | null = null

  const stage = (name: string, value: Staged | undefined): void => {
    const prev = staged.get(name)
    if (typeof prev === 'string') stagedBytes -= prev.length
    if (value === undefined) staged.delete(name)
    else {
      staged.set(name, value)
      if (typeof value === 'string') stagedBytes += value.length
    }
  }

  async function json<T>(res: Response, what: string): Promise<T> {
    if (!res.ok) throw await c.fail(res, what)
    return (await res.json()) as T
  }

  interface RepoAnswer {
    readonly default_branch: string
    readonly private?: boolean
    readonly size?: number
    readonly archived?: boolean
    readonly permissions?: { readonly push?: boolean }
  }

  async function repoInfo(): Promise<RepoAnswer> {
    const res = await c.call('GET', '', { fresh: true })
    if (res.status === 404) {
      throw new RemoteError('not-found', `GitHub repository ${repoName} not found, or the token cannot see it`)
    }
    return json(res, 'repository')
  }

  async function branch(): Promise<string> {
    branchName ??= (await repoInfo()).default_branch
    return branchName
  }

  const getTree = (sha: string, recursive: boolean): Promise<TreeAnswer> =>
    c.call('GET', `git/trees/${sha}${recursive ? '?recursive=1' : ''}`).then((res) => json(res, 'tree'))

  /** Every blob under a tree: one recursive call, or a walk of its subtrees when GitHub truncates the answer. */
  async function walk(sha: string, base: string, out: Map<string, string>): Promise<void> {
    const deep = await getTree(sha, true)
    if (!deep.truncated) {
      for (const e of deep.tree) if (e.type === 'blob') out.set(base + e.path, e.sha)
      return
    }
    for (const e of (await getTree(sha, false)).tree) {
      if (e.type === 'blob') out.set(base + e.path, e.sha)
      else if (e.type === 'tree') await walk(e.sha, `${base}${e.path}/`, out)
    }
  }

  async function readHead(commit: string): Promise<Head> {
    const top = await getTree(commit, true)
    const entries = new Map<string, string>()
    const strip = `${root}/`
    if (!top.truncated) {
      for (const e of top.tree) {
        if (e.type === 'blob' && e.path.startsWith(strip)) entries.set(e.path.slice(strip.length), e.sha)
      }
    } else {
      let sha: string | null = top.sha
      for (const part of root.split('/')) {
        const t: TreeAnswer = await getTree(sha, false)
        sha = t.tree.find((e) => e.type === 'tree' && e.path === part)?.sha ?? null
        if (sha === null) break
      }
      if (sha !== null) await walk(sha, '', entries)
    }
    entries.delete(README)
    return { commit, tree: top.sha, entries }
  }

  /** Head of the branch; its tree is read again only when the head moved. */
  async function loadState(): Promise<HeadState> {
    const b = await branch()
    const res = await c.call('GET', `git/ref/heads/${encPath(b)}`, { fresh: true })
    if (res.status === 409) return { commit: null, reason: 'empty' }
    if (res.status === 404) {
      await repoInfo()
      return { commit: null, reason: 'missing' }
    }
    const ref = await json<{ object: { sha: string } }>(res, 'branch')
    if (cache?.commit !== ref.object.sha) cache = await readHead(ref.object.sha)
    return cache
  }

  /** First commit of an empty repository, through the Contents API (the Git Data API refuses empty ones). */
  async function bootstrap(b: string): Promise<void> {
    const res = await c.call('PUT', `contents/${encPath(`${root}/${README}`)}`, {
      body: {
        message: COMMIT_MESSAGE,
        content: toBase64(enc.encode(README_TEXT)),
        branch: b,
        author: COMMIT_AUTHOR,
        committer: COMMIT_AUTHOR,
      },
      write: true,
    })
    // 409/422: another device made it first.
    if (!res.ok && res.status !== 409 && res.status !== 422) throw await c.fail(res, 'first commit')
  }

  /** A configured branch that does not exist yet starts from the default branch. */
  async function createBranch(b: string): Promise<void> {
    const main = (await repoInfo()).default_branch
    const res = await c.call('GET', `git/ref/heads/${encPath(main)}`, { fresh: true })
    if (res.status === 409) return bootstrap(b)
    const ref = await json<{ object: { sha: string } }>(res, 'default branch')
    const made = await c.call('POST', 'git/refs', {
      body: { ref: `refs/heads/${b}`, sha: ref.object.sha },
      write: true,
    })
    if (!made.ok && made.status !== 422) throw await c.fail(made, 'create branch')
  }

  async function postTree(base: string, items: unknown[]): Promise<string> {
    const res = await c.call('POST', 'git/trees', { body: { base_tree: base, tree: items }, write: true })
    return (await json<{ sha: string }>(res, 'write tree')).sha
  }

  /** Writes a batch as one commit on top of the branch; rebuilds on a head another device moved. */
  async function commitBatch(batch: [string, Staged][]): Promise<void> {
    /** Blob sha of each large object already uploaded with `git/blobs`, by name. */
    const uploaded = new Map<string, string>()
    for (let attempt = 0; ; attempt++) {
      const b = await branch()
      let state = await loadState()
      if (state.commit === null) {
        if (state.reason === 'empty') await bootstrap(b)
        else await createBranch(b)
        state = await loadState()
        if (state.commit === null) throw new RemoteError('network', `GitHub branch ${b} could not be created`)
      }
      const head: Head = state
      // Objects never change: one already in the branch is not written again.
      const writes = batch.filter(([name, s]) => (s === null ? head.entries.has(name) : !head.entries.has(name)))
      if (writes.length === 0) return
      let tree = head.tree
      let items: unknown[] = []
      let size = 0
      const send = async (): Promise<void> => {
        if (items.length === 0) return
        tree = await postTree(tree, items)
        items = []
        size = 0
      }
      for (const [name, s] of writes) {
        const path = `${root}/${name}`
        if (s === null) {
          items.push({ path, mode: '100644', type: 'blob', sha: null })
          continue
        }
        if (s.length > maxTreeBytes) {
          let sha = uploaded.get(name)
          if (sha === undefined) {
            const res = await c.call('POST', 'git/blobs', { body: { content: s, encoding: 'utf-8' }, write: true })
            sha = (await json<{ sha: string }>(res, 'write blob')).sha
            uploaded.set(name, sha)
          }
          items.push({ path, mode: '100644', type: 'blob', sha })
          continue
        }
        if (size + s.length > maxTreeBytes) await send()
        items.push({ path, mode: '100644', type: 'blob', content: s })
        size += s.length
      }
      await send()
      const commit = await json<{ sha: string }>(
        await c.call('POST', 'git/commits', {
          body: {
            message: COMMIT_MESSAGE,
            tree,
            parents: [head.commit],
            author: COMMIT_AUTHOR,
            committer: COMMIT_AUTHOR,
          },
          write: true,
        }),
        'write commit',
      )
      const res = await c.call('PATCH', `git/refs/heads/${encPath(b)}`, {
        body: { sha: commit.sha, force: false },
        write: true,
      })
      if (res.ok) {
        // The new head's blob shas are read back on the next listing.
        cache = null
        return
      }
      // 422: not a fast forward, another device pushed. New paths never conflict: rebuild on its head.
      if (res.status !== 422) throw await c.fail(res, 'update branch')
      if (attempt >= maxRefRetries) {
        throw new RemoteError('network', `GitHub branch ${b} kept moving during ${attempt + 1} attempts`)
      }
    }
  }

  async function doFlush(): Promise<void> {
    if (staged.size === 0) return
    const batch = [...staged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    await commitBatch(batch)
    for (const [name, s] of batch) if (staged.get(name) === s) stage(name, undefined)
  }

  /** One flush at a time; a flush waits for the one in progress, then writes what is still staged. */
  function flush(): Promise<void> {
    const p = (running ?? Promise.resolve()).catch(() => undefined).then(doFlush)
    running = p
    const clear = (): void => {
      if (running === p) running = null
    }
    p.then(clear, clear)
    return p
  }

  async function getBlob(sha: string): Promise<Bytes | null> {
    const res = await c.call('GET', `git/blobs/${sha}`, { accept: 'application/vnd.github.raw+json' })
    if (res.status === 404) return null
    if (!res.ok) throw await c.fail(res, 'read object')
    // The raw media type gives the stored base64 text; the JSON form wraps it once more in base64.
    let text = await res.text()
    if (text.startsWith('{')) {
      const blob = JSON.parse(text) as { content: string; encoding: string }
      text = blob.encoding === 'base64' ? atob(blob.content.replace(/\s/g, '')) : blob.content
    }
    try {
      return fromBase64(text.trim())
    } catch {
      // Not base64: edited outside the app. The bytes then fail authentication downstream.
      return enc.encode(text) as Bytes
    }
  }

  const pace: WritePace = {
    get queuedWrites() {
      if (staged.size === 0) return 0
      return Math.ceil(stagedBytes / maxTreeBytes) + 2
    },
    msPerWrite: pacer.msPerWrite,
    writesFor(objects, bytes) {
      if (objects === 0) return 0
      // Base64 adds a third; each batch is one or more trees, a commit and a ref update.
      const text = Math.ceil((bytes * 4) / 3)
      const batches = Math.max(1, Math.ceil(text / maxBatchBytes))
      return Math.ceil(text / maxTreeBytes) + 2 * batches
    },
  }

  return {
    id: githubStoreId(o),
    kind: 'github',
    keepsHistory: true,
    pacer,
    pace,
    get staged() {
      return staged.size
    },
    async list(prefix = '') {
      const state = await loadState()
      if (state.commit === null) return []
      const out: RemoteEntry[] = []
      for (const [name, sha] of state.entries) if (name.startsWith(prefix)) out.push({ name, handle: sha })
      return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    },
    async get(entry) {
      let sha = entry.handle
      if (sha === undefined) {
        const state = await loadState()
        if (state.commit === null) return null
        sha = state.entries.get(entry.name)
        if (sha === undefined) return null
      }
      return getBlob(sha)
    },
    async put(name, bytes) {
      stage(name, toBase64(bytes))
      if (stagedBytes > maxBatchBytes) await flush()
    },
    flush,
    async delete(name) {
      stage(name, null)
      await flush()
    },
    async info(): Promise<StoreInfo> {
      const r = await repoInfo()
      const expires = c.expiry()
      return {
        ...(r.size !== undefined ? { sizeBytes: r.size * 1024 } : {}),
        isPublic: r.private !== true,
        ...(expires !== undefined ? { credentialsExpireAt: expires } : {}),
      }
    },
  }
}

export type GitHubProblem = 'token' | 'not-found' | 'no-access' | 'read-only' | 'rate-limited' | 'network'
export type GitHubCheck =
  | { readonly ok: true; readonly defaultBranch: string; readonly isPublic: boolean; readonly sizeBytes?: number }
  | { readonly ok: false; readonly problem: GitHubProblem; readonly detail: string; readonly retryAfterMs?: number }

/**
 * Validates a token and repository for the setup form, with read-only calls. GitHub answers 404 both for a private
 * repository that does not exist and for one the token cannot see: `not-found` is certain only for an owner that does
 * not exist, `no-access` covers both other cases. `read-only`: no push permission, or archived.
 */
export async function checkGitHub(o: Omit<GitHubOptions, 'pacer' | 'sleep'>): Promise<GitHubCheck> {
  const c = client(o, null)
  const fromError = (e: unknown): GitHubCheck => {
    if (!(e instanceof RemoteError)) throw e
    const problem: GitHubProblem =
      e.kind === 'auth'
        ? 'token'
        : e.kind === 'rate-limited'
          ? 'rate-limited'
          : e.kind === 'network'
            ? 'network'
            : 'no-access'
    return {
      ok: false,
      problem,
      detail: e.message,
      ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
    }
  }
  try {
    const res = await c.call('GET', '', { fresh: true })
    if (res.status === 404) {
      const user = await c.call('GET', `/users/${encodeURIComponent(o.owner.trim())}`)
      if (user.status === 404) return { ok: false, problem: 'not-found', detail: `No GitHub account ${o.owner}` }
      if (!user.ok) throw await c.fail(user, 'owner')
      return {
        ok: false,
        problem: 'no-access',
        detail: `Repository ${o.owner}/${o.repo} not found, or not among the repositories of this token`,
      }
    }
    if (!res.ok) throw await c.fail(res, 'repository')
    const r = (await res.json()) as {
      default_branch: string
      private?: boolean
      size?: number
      archived?: boolean
      permissions?: { push?: boolean }
    }
    if (r.archived) return { ok: false, problem: 'read-only', detail: `Repository ${o.owner}/${o.repo} is archived` }
    if (r.permissions?.push === false) {
      return { ok: false, problem: 'read-only', detail: `No write access to ${o.owner}/${o.repo}` }
    }
    return {
      ok: true,
      defaultBranch: r.default_branch,
      isPublic: r.private !== true,
      ...(r.size !== undefined ? { sizeBytes: r.size * 1024 } : {}),
    }
  } catch (e) {
    return fromError(e)
  }
}
