/*
 * Skill imports against an in-memory GitHub (its API and raw.githubusercontent.com, as plain GETs), zips built with
 * fflate, and picked folders: the sources accepted, the one commit read, several skills in one repository, the limits
 * applied before downloading, and the errors a user can act on.
 */
import { describe, expect, test } from 'bun:test'
import { zipSync } from 'fflate'
import type { FetchLike } from '../contracts/ai.ts'
import { SKILL_LIMITS, SkillError } from '../contracts/skills.ts'
import { importFromFiles, importFromGitHub, importFromZip, parseGitHubSource } from './import.ts'

const enc = new TextEncoder()
const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const skillMd = (name: string, description = `The ${name} skill.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nRead [the guide](references/guide.md).\n`

interface FakeRepo {
  readonly files: Record<string, string>
  /** Sizes the tree reports instead of the real ones. */
  readonly sizes?: Record<string, number>
  readonly branches?: Record<string, string>
}

function fakeGitHub(
  repos: Record<string, FakeRepo>,
  options: { readonly status?: number; readonly headers?: Record<string, string> } = {},
) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, ...(init === undefined ? {} : { init }) })
    if (options.status !== undefined) return new Response('{}', { status: options.status, headers: options.headers })
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } })
    const api = /^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.replace(/\?.*$/, ''))
    if (api !== null) {
      const repo = repos[`${api[1]}/${api[2]}`]
      if (repo === undefined) return new Response('{"message":"Not Found"}', { status: 404 })
      const rest = api[3] ?? ''
      const branches = repo.branches ?? { main: SHA }
      if (rest === '') return json({ default_branch: Object.keys(branches)[0] })
      const commit = /^\/commits\/(.+)$/.exec(rest)
      if (commit !== null) {
        const sha = branches[decodeURIComponent(commit[1] as string)]
        return sha === undefined ? new Response('{}', { status: 404 }) : json({ sha })
      }
      if (rest.startsWith('/git/trees/')) {
        return json({
          sha: 'tree',
          truncated: false,
          tree: Object.entries(repo.files).map(([path, text]) => ({
            path,
            type: 'blob',
            size: repo.sizes?.[path] ?? enc.encode(text).length,
          })),
        })
      }
    }
    const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([0-9a-f]{40})\/(.+)$/.exec(url)
    if (raw !== null) {
      const text = repos[`${raw[1]}/${raw[2]}`]?.files[decodeURIComponent(raw[4] as string)]
      return text === undefined ? new Response('', { status: 404 }) : new Response(text)
    }
    return new Response('', { status: 404 })
  }
  return { fetch, calls }
}

async function codeOf(run: () => Promise<unknown> | unknown): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof SkillError) return error.code
    throw error
  }
  return 'none'
}

describe('parseGitHubSource', () => {
  test('short forms and github.com addresses', () => {
    expect(parseGitHubSource('maxgfr/ultrasearch')).toEqual({
      owner: 'maxgfr',
      repo: 'ultrasearch',
      ref: null,
      path: '',
    })
    expect(parseGitHubSource(' maxgfr/ultrasearch/skills/ultrasearch/ ')).toEqual({
      owner: 'maxgfr',
      repo: 'ultrasearch',
      ref: null,
      path: 'skills/ultrasearch',
    })
    expect(parseGitHubSource('o/r@v1.2')).toEqual({ owner: 'o', repo: 'r', ref: 'v1.2', path: '' })
    expect(parseGitHubSource('o/r@dev/skills/a')).toEqual({ owner: 'o', repo: 'r', ref: 'dev', path: 'skills/a' })
    expect(parseGitHubSource('https://github.com/o/r.git')).toEqual({ owner: 'o', repo: 'r', ref: null, path: '' })
    expect(parseGitHubSource('https://github.com/o/r/tree/main/skills/a?x=1#y')).toEqual({
      owner: 'o',
      repo: 'r',
      ref: 'main',
      path: 'skills/a',
    })
    expect(parseGitHubSource('github.com/o/r/tree/main')).toEqual({ owner: 'o', repo: 'r', ref: 'main', path: '' })
    expect(parseGitHubSource('https://github.com/o/r/blob/main/skills/a/SKILL.md')).toEqual({
      owner: 'o',
      repo: 'r',
      ref: 'main',
      path: 'skills/a',
    })
  })

  test('anything else is refused', async () => {
    for (const bad of [
      '',
      'justone',
      'o/r/../x',
      'https://gitlab.com/o/r',
      'https://github.com/o',
      'https://github.com/o/r/issues/1',
      'o/r@',
      'o/r@a..b',
      '-o/r',
      'o/r@x/../y',
      'file:///etc',
    ])
      expect(await codeOf(() => parseGitHubSource(bad)), bad).toBe('malformed')
  })
})

describe('importFromGitHub', () => {
  const repos = {
    'maxgfr/ultrasearch': {
      files: {
        'README.md': '# readme',
        'skills/ultrasearch/SKILL.md': skillMd('ultrasearch'),
        'skills/ultrasearch/references/guide.md': 'The guide.',
        'skills/ultrasearch/scripts/run.py': 'print("hi")',
        'skills/ultrasearch/.hidden': 'x',
      },
    },
    'o/many': {
      files: {
        'skills/a/SKILL.md': skillMd('a'),
        'skills/a/big.bin': 'x',
        'skills/b/SKILL.md': skillMd('b'),
        'skills/broken/SKILL.md': '# no frontmatter',
      },
      sizes: { 'skills/a/big.bin': SKILL_LIMITS.maxFileBytes + 1 },
      branches: { trunk: SHA, dev: OTHER_SHA },
    },
  } satisfies Record<string, FakeRepo>

  test('reads the default branch at one commit, plain GETs only', async () => {
    const gh = fakeGitHub(repos)
    const { skills, problems } = await importFromGitHub(parseGitHubSource('maxgfr/ultrasearch'), gh.fetch)
    expect(problems).toEqual([])
    expect(skills).toHaveLength(1)
    const skill = skills[0]
    expect(skill?.parsed.name).toBe('ultrasearch')
    expect(skill?.source).toEqual({
      kind: 'github',
      repo: 'maxgfr/ultrasearch',
      path: 'skills/ultrasearch',
      ref: 'main',
      commit: SHA,
    })
    expect(skill?.files.map((f) => f.path)).toEqual(['SKILL.md', 'references/guide.md', 'scripts/run.py'])
    expect(new TextDecoder().decode(skill?.files[1]?.data)).toBe('The guide.')
    expect(gh.calls.map((c) => c.url).slice(0, 3)).toEqual([
      'https://api.github.com/repos/maxgfr/ultrasearch',
      'https://api.github.com/repos/maxgfr/ultrasearch/commits/main',
      `https://api.github.com/repos/maxgfr/ultrasearch/git/trees/${SHA}?recursive=1`,
    ])
    for (const c of gh.calls.slice(3))
      expect(c.url.startsWith(`https://raw.githubusercontent.com/maxgfr/ultrasearch/${SHA}/`)).toBe(true)
    for (const c of gh.calls) expect(c.init?.headers).toBeUndefined()
  })

  test('an explicit ref and a sub path; several skills; large files skipped before download', async () => {
    const gh = fakeGitHub(repos)
    const { skills, problems } = await importFromGitHub(parseGitHubSource('o/many@dev/skills'), gh.fetch)
    expect(skills.map((s) => s.parsed.name)).toEqual(['a', 'b'])
    expect(skills[0]?.source).toMatchObject({ ref: 'dev', commit: OTHER_SHA, path: 'skills/a' })
    expect(skills[0]?.skipped).toEqual(['big.bin: larger than 4 MiB'])
    expect(gh.calls.some((c) => c.url.endsWith('/big.bin'))).toBe(false)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('skills/broken/SKILL.md')
    // No call for the default branch: the ref was given.
    expect(gh.calls[0]?.url).toBe('https://api.github.com/repos/o/many/commits/dev')
  })

  test('errors a user can act on', async () => {
    expect(await codeOf(() => importFromGitHub(parseGitHubSource('no/such'), fakeGitHub(repos).fetch))).toBe(
      'not-found',
    )
    expect(await codeOf(() => importFromGitHub(parseGitHubSource('o/many@nope'), fakeGitHub(repos).fetch))).toBe(
      'not-found',
    )
    expect(
      await codeOf(() => importFromGitHub(parseGitHubSource('maxgfr/ultrasearch/README.md'), fakeGitHub(repos).fetch)),
    ).toBe('not-found')
    const limited = fakeGitHub(repos, { status: 403, headers: { 'x-ratelimit-remaining': '0' } })
    expect(await codeOf(() => importFromGitHub(parseGitHubSource('o/r'), limited.fetch))).toBe('rate-limited')
    expect(
      await codeOf(() => importFromGitHub(parseGitHubSource('o/r'), fakeGitHub(repos, { status: 429 }).fetch)),
    ).toBe('rate-limited')
    expect(
      await codeOf(() => importFromGitHub(parseGitHubSource('o/r'), fakeGitHub(repos, { status: 500 }).fetch)),
    ).toBe('network')
    const offline: FetchLike = async () => {
      throw new TypeError('Failed to fetch')
    }
    expect(await codeOf(() => importFromGitHub(parseGitHubSource('o/r'), offline))).toBe('network')
    const only = { 'o/bad': { files: { 'SKILL.md': '# none' } } }
    expect(await codeOf(() => importFromGitHub(parseGitHubSource('o/bad'), fakeGitHub(only).fetch))).toBe('invalid')
  })

  test('a truncated tree is refused', async () => {
    const fetch: FetchLike = async (input) => {
      const url = String(input)
      if (url.includes('/commits/')) return Response.json({ sha: SHA })
      return Response.json({ truncated: true, tree: [] })
    }
    expect(await codeOf(() => importFromGitHub(parseGitHubSource('o/r@main'), fetch))).toBe('too-large')
  })

  test('an abort rejects with the abort, not a SkillError', async () => {
    const controller = new AbortController()
    const fetch: FetchLike = async () => {
      controller.abort()
      throw new DOMException('stopped', 'AbortError')
    }
    const error = await importFromGitHub(parseGitHubSource('o/r@main'), fetch, controller.signal).catch((e) => e)
    expect((error as Error).name).toBe('AbortError')
  })
})

describe('importFromZip and importFromFiles', () => {
  test('a zip with a top folder, as GitHub downloads are', () => {
    const zip = zipSync({
      'repo-main/': new Uint8Array(),
      'repo-main/skills/demo/SKILL.md': enc.encode(skillMd('demo')),
      'repo-main/skills/demo/scripts/hello.js': enc.encode('console.log("hello")'),
      'repo-main/skills/demo/node_modules/x.js': enc.encode('x'),
    })
    const { skills } = importFromZip(zip, 'repo-main.zip')
    expect(skills).toHaveLength(1)
    expect(skills[0]?.source).toEqual({ kind: 'zip', name: 'repo-main.zip', path: 'repo-main/skills/demo' })
    expect(skills[0]?.files.map((f) => f.path)).toEqual(['SKILL.md', 'scripts/hello.js'])
  })

  test('a skill at the root of an archive is named after the archive when it names none', () => {
    const zip = zipSync({ 'SKILL.md': enc.encode('---\ndescription: Root skill.\n---\nBody\n') })
    const { skills } = importFromZip(zip, 'my-skill.zip')
    expect(skills[0]?.parsed.name).toBe('my-skill')
    expect(skills[0]?.parsed.warnings).toEqual(['no `name` field: named after its directory, "my-skill"'])
  })

  test('a damaged archive or one with no skill', async () => {
    expect(await codeOf(() => importFromZip(enc.encode('not a zip'), 'x.zip'))).toBe('malformed')
    expect(await codeOf(() => importFromZip(zipSync({ 'a.txt': enc.encode('a') }), 'x.zip'))).toBe('not-found')
  })

  test('a picked folder, its files named after it', () => {
    const files = [
      { path: 'demo/SKILL.md', data: enc.encode(skillMd('demo')) },
      { path: 'demo/references/guide.md', data: enc.encode('Guide') },
      { path: 'demo/.DS_Store', data: new Uint8Array([0]) },
    ]
    const { skills } = importFromFiles(files, 'demo')
    expect(skills[0]?.parsed.name).toBe('demo')
    expect(skills[0]?.parsed.warnings).toEqual([])
    expect(skills[0]?.source).toEqual({ kind: 'folder', name: 'demo', path: '' })
    expect(skills[0]?.files.map((f) => f.path)).toEqual(['SKILL.md', 'references/guide.md'])
  })
})
