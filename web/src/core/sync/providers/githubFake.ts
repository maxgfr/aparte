/*
 * An in-memory GitHub, enough of the REST API for the GitHub store: the repository, refs, recursive trees, blobs,
 * commits, the Contents API's first commit, token checks, the token expiry header, and injected rate limits. The unit
 * tests run the store against it, and the end-to-end spec routes the browser's requests to api.github.com to it, so no
 * test ever talks to the real service. Never imported by the app.
 */

export interface FakeGitHubOptions {
  readonly owner: string
  readonly repo: string
  readonly token: string
  readonly defaultBranch?: string
  readonly isPrivate?: boolean
  /** Sent as `github-authentication-token-expiration` on every answer. */
  readonly tokenExpiration?: string
  readonly now?: () => number
  /** Starts with a first commit holding a README at the root, as GitHub's "Add a README" option makes it. */
  readonly initialized?: boolean
}

export interface FakeAnswer {
  readonly status: number
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: unknown
}

interface Commit {
  readonly tree: string
  readonly parents: readonly string[]
  readonly message: string
  readonly author?: unknown
}

export interface FakeGitHub {
  /** Answers one request as GitHub would. */
  handle(url: string, init?: { method?: string; headers?: HeadersInit; body?: BodyInit | null }): Promise<Response>
  /** The next `times` content-creating requests get this answer instead (a 403 secondary rate limit, a 429...). */
  failWrites(answer: FakeAnswer, times?: number): void
  /** Content-creating requests that were answered (successfully or not), with their times. */
  readonly writes: { readonly method: string; readonly path: string; readonly at: number; readonly status: number }[]
  /** Commits on the default branch, newest first. */
  history(): Commit[]
  /** Path -> stored text of the files at the branch head. */
  files(): Map<string, string>
  /** Moves the branch to an older commit (a force push); `back` commits back. */
  forcePush(back: number): void
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const decode64 = (text: string): string => {
  const bin = atob(text.replace(/\s/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

const encode64 = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fakeGitHub(o: FakeGitHubOptions): FakeGitHub {
  const now = o.now ?? (() => Date.now())
  const branchName = o.defaultBranch ?? 'main'
  const blobs = new Map<string, string>()
  const trees = new Map<string, Map<string, string>>()
  const commits = new Map<string, Commit>()
  const refs = new Map<string, string>()
  const writes: FakeGitHub['writes'] = []
  let failing: { answer: FakeAnswer; times: number } | null = null
  let n = 0
  const sha = (): string => (++n).toString(16).padStart(40, '0')

  const blob = (text: string): string => {
    const id = sha()
    blobs.set(id, text)
    return id
  }
  const tree = (entries: Map<string, string>): string => {
    const id = sha()
    trees.set(id, entries)
    return id
  }
  const treeOf = (id: string): Map<string, string> | undefined => trees.get(commits.get(id)?.tree ?? id)
  const extra = (): Record<string, string> =>
    o.tokenExpiration ? { 'github-authentication-token-expiration': o.tokenExpiration } : {}
  const sizeKb = (): number => {
    let bytes = 0
    for (const text of blobs.values()) bytes += text.length
    return Math.ceil(bytes / 1024)
  }

  if (o.initialized) {
    const readme = sha()
    blobs.set(readme, `# ${o.repo}\n`)
    const root = sha()
    trees.set(root, new Map([['README.md', readme]]))
    const first = sha()
    commits.set(first, { tree: root, parents: [], message: 'Initial commit' })
    refs.set(branchName, first)
  }

  const handle: FakeGitHub['handle'] = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers)
    const u = new URL(url)
    const reply = (status: number, body: unknown) => json(status, body, extra())
    if (headers.get('authorization') !== `Bearer ${o.token}`) return reply(401, { message: 'Bad credentials' })
    const write = method !== 'GET'
    const base = `/repos/${o.owner}/${o.repo}`
    const path = decodeURIComponent(u.pathname)
    if (write) {
      if (failing && failing.times > 0) {
        failing.times--
        const a = failing.answer
        writes.push({ method, path, at: now(), status: a.status })
        return json(a.status, a.body ?? { message: 'You have exceeded a secondary rate limit.' }, {
          ...extra(),
          ...a.headers,
        })
      }
    }
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    const answer = ((): Response => {
      if (path.startsWith('/users/'))
        return path === `/users/${o.owner}` ? reply(200, { login: o.owner }) : reply(404, { message: 'Not Found' })
      if (path !== base && !path.startsWith(`${base}/`)) return reply(404, { message: 'Not Found' })
      const rest = path.slice(base.length)
      if (rest === '' && method === 'GET') {
        return reply(200, {
          default_branch: branchName,
          private: o.isPrivate ?? true,
          size: sizeKb(),
          archived: false,
          permissions: { push: true },
        })
      }
      let m = /^\/git\/ref\/heads\/(.+)$/.exec(rest)
      if (m && method === 'GET') {
        if (refs.size === 0) return reply(409, { message: 'Git Repository is empty.' })
        const head = refs.get(m[1] as string)
        return head === undefined ? reply(404, { message: 'Not Found' }) : reply(200, { object: { sha: head } })
      }
      m = /^\/git\/trees\/([0-9a-f]+)$/.exec(rest)
      if (m && method === 'GET') {
        const id = commits.get(m[1] as string)?.tree ?? (m[1] as string)
        const entries = trees.get(id)
        if (!entries) return reply(404, { message: 'Not Found' })
        const tree = [...entries].map(([p, s]) => ({
          path: p,
          mode: '100644',
          type: 'blob',
          sha: s,
          size: blobs.get(s)?.length,
        }))
        return reply(200, { sha: id, tree, truncated: false })
      }
      if (rest === '/git/trees' && method === 'POST') {
        const baseTree = typeof body.base_tree === 'string' ? treeOf(body.base_tree) : new Map<string, string>()
        if (!baseTree) return reply(422, { message: 'Invalid base_tree' })
        const next = new Map(baseTree)
        for (const item of body.tree as { path: string; content?: string; sha?: string | null }[]) {
          if (item.sha === null) next.delete(item.path)
          else if (typeof item.content === 'string') next.set(item.path, blob(item.content))
          else if (typeof item.sha === 'string' && blobs.has(item.sha)) next.set(item.path, item.sha)
          else return reply(422, { message: 'Invalid tree item' })
        }
        return reply(201, { sha: tree(next) })
      }
      if (rest === '/git/blobs' && method === 'POST') {
        const content = String(body.content)
        return reply(201, { sha: blob(body.encoding === 'base64' ? decode64(content) : content) })
      }
      m = /^\/git\/blobs\/([0-9a-f]+)$/.exec(rest)
      if (m && method === 'GET') {
        const text = blobs.get(m[1] as string)
        if (text === undefined) return reply(404, { message: 'Not Found' })
        if (headers.get('accept') === 'application/vnd.github.raw+json') {
          return new Response(text, {
            status: 200,
            headers: { 'content-type': 'application/vnd.github.raw', ...extra() },
          })
        }
        return reply(200, { sha: m[1], content: encode64(text), encoding: 'base64' })
      }
      if (rest === '/git/commits' && method === 'POST') {
        const treeId = String(body.tree)
        if (!trees.has(treeId)) return reply(422, { message: 'Invalid tree' })
        const id = sha()
        commits.set(id, {
          tree: treeId,
          parents: (body.parents as string[]) ?? [],
          message: String(body.message),
          author: body.author,
        })
        return reply(201, { sha: id })
      }
      m = /^\/git\/refs\/heads\/(.+)$/.exec(rest)
      if (m && method === 'PATCH') {
        const name = m[1] as string
        const current = refs.get(name)
        const next = commits.get(String(body.sha))
        if (current === undefined || !next) return reply(422, { message: 'Reference does not exist' })
        if (body.force !== true && next.parents[0] !== current)
          return reply(422, { message: 'Update is not a fast forward' })
        refs.set(name, String(body.sha))
        return reply(200, { object: { sha: body.sha } })
      }
      if (rest === '/git/refs' && method === 'POST') {
        const ref = String(body.ref).replace(/^refs\/heads\//, '')
        if (refs.has(ref)) return reply(422, { message: 'Reference already exists' })
        refs.set(ref, String(body.sha))
        return reply(201, { ref: body.ref })
      }
      m = /^\/contents\/(.+)$/.exec(rest)
      if (m && method === 'PUT') {
        const target = String(body.branch ?? branchName)
        if (refs.has(target)) return reply(422, { message: '"sha" wasn\'t supplied.' })
        const entries = new Map([[m[1] as string, blob(decode64(String(body.content)))]])
        const id = sha()
        commits.set(id, { tree: tree(entries), parents: [], message: String(body.message), author: body.author })
        refs.set(target, id)
        return reply(201, { commit: { sha: id } })
      }
      return reply(404, { message: `Not handled by the fake: ${method} ${rest}` })
    })()
    if (write) writes.push({ method, path, at: now(), status: answer.status })
    return answer
  }

  return {
    handle,
    failWrites(answer, times = 1) {
      failing = { answer, times }
    },
    writes,
    history() {
      const out: Commit[] = []
      let at = refs.get(branchName)
      while (at !== undefined) {
        const c = commits.get(at)
        if (!c) break
        out.push(c)
        at = c.parents[0]
      }
      return out
    },
    files() {
      const head = refs.get(branchName)
      const entries = head === undefined ? new Map<string, string>() : (treeOf(head) ?? new Map<string, string>())
      return new Map([...entries].map(([p, s]) => [p, blobs.get(s) ?? '']))
    },
    forcePush(back) {
      let at = refs.get(branchName)
      for (let i = 0; i < back && at !== undefined; i++) at = commits.get(at)?.parents[0]
      if (at !== undefined) refs.set(branchName, at)
    },
  }
}
