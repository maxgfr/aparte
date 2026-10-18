import { describe, expect, test } from 'bun:test'
import { RemoteError } from '../../contracts/sync.ts'
import { FakeClock } from '../../workspace/testkit.ts'
import { device } from '../testkit.ts'
import {
  COMMIT_AUTHOR,
  COMMIT_MESSAGE,
  checkGitHub,
  fromBase64,
  githubStore,
  githubStoreId,
  tokenExpiry,
} from './github.ts'
import { fakeGitHub } from './githubFake.ts'
import { MemoryBucket } from './memory.ts'
import { createPacer } from './pacer.ts'
import { remoteContract } from './remote.contract.ts'

const TOKEN = 'github_pat_test'

/** A GitHub store over a fake server, with a virtual clock: pacing sleeps advance it instead of waiting. */
function setup(options: { tokenExpiration?: string } = {}) {
  const clock = new FakeClock()
  const server = fakeGitHub({ owner: 'me', repo: 'vault', token: TOKEN, now: () => clock.now(), ...options })
  const sleep = async (ms: number) => clock.tick(ms)
  const make = () =>
    githubStore({ owner: 'me', repo: 'vault', token: TOKEN, http: server.handle, now: () => clock.now(), sleep })
  return { clock, server, make }
}

remoteContract('GitHub', async () => {
  const { make } = setup()
  return { store: make(), again: make }
})

describe('GitHub store', () => {
  test('objects are base64 files under the root, written in one commit with a constant message and author', async () => {
    const { server, make } = setup()
    const store = make()
    await store.put('fmt/1', new TextEncoder().encode('aparte/1\n'))
    await store.put('b/aa/aaaaaaaaaaaaaaaaaaaaaaaaaa', new Uint8Array([0, 1, 255]))
    await store.flush()
    const files = server.files()
    expect([...files.keys()].sort()).toEqual([
      'aparte/README.md',
      'aparte/b/aa/aaaaaaaaaaaaaaaaaaaaaaaaaa',
      'aparte/fmt/1',
    ])
    expect(fromBase64(files.get('aparte/b/aa/aaaaaaaaaaaaaaaaaaaaaaaaaa') as string)).toEqual(
      new Uint8Array([0, 1, 255]),
    )
    // The bootstrap commit and the batch commit, both anonymous and alike.
    const history = server.history()
    expect(history).toHaveLength(2)
    for (const commit of history) {
      expect(commit.message).toBe(COMMIT_MESSAGE)
      expect(commit.author).toEqual(COMMIT_AUTHOR)
    }
  })

  test('writes are paced at most one a second, and 60 in any minute', async () => {
    const { server, make, clock } = setup()
    const store = make()
    for (let round = 0; round < 25; round++) {
      await store.put(
        `d/${'a'.repeat(16)}/s/${'b'.repeat(16)}/0000000/${String(round + 1).padStart(10, '0')}-cccccccc`,
        new Uint8Array([round]),
      )
      await store.flush()
    }
    const times = server.writes.map((w) => w.at)
    expect(times.length).toBeGreaterThan(60)
    for (let i = 1; i < times.length; i++)
      expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(1000)
    for (let i = 60; i < times.length; i++)
      expect((times[i] as number) - (times[i - 60] as number)).toBeGreaterThanOrEqual(60_000)
    expect(clock.now()).toBeGreaterThan(1_760_000_000_000)
  })

  test('the hourly cap holds over a long upload', async () => {
    const clock = new FakeClock()
    const pacer = createPacer({
      now: () => clock.now(),
      sleep: async (ms) => clock.tick(ms),
      perMinute: 600,
      perHour: 20,
    })
    for (let i = 0; i < 45; i++) await pacer.slot()
    const sent = [...pacer.sent]
    for (let i = 20; i < sent.length; i++)
      expect((sent[i] as number) - (sent[i - 20] as number)).toBeGreaterThanOrEqual(3_600_000)
  })

  test('a 403 secondary rate limit pauses every write for its Retry-After, then the upload resumes', async () => {
    const { server, make, clock } = setup()
    const store = make()
    await store.put('fmt/1', new TextEncoder().encode('aparte/1\n'))
    await store.flush()
    server.failWrites({
      status: 403,
      headers: { 'retry-after': '120' },
      body: { message: 'You have exceeded a secondary rate limit' },
    })
    await store.put('keys/aaaaaaaaaaaaaaaaaaaaaaaaaa.json', new TextEncoder().encode('{}\n'))
    const failure = await store.flush().catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(RemoteError)
    expect(failure).toMatchObject({ kind: 'rate-limited', retryAfterMs: 120_000 })
    const refusedAt = server.writes.at(-1)?.at as number
    // What was staged stays staged: the next flush writes it, after the pause.
    expect(store.staged).toBe(1)
    await store.flush()
    expect(store.staged).toBe(0)
    const next = server.writes.find((w) => w.at > refusedAt)
    expect((next?.at as number) - refusedAt).toBeGreaterThanOrEqual(120_000)
    expect((await store.list('keys/')).map((e) => e.name)).toEqual(['keys/aaaaaaaaaaaaaaaaaaaaaaaaaa.json'])
    void clock
  })

  test('a 429 answer is rate limited too, with a default wait when none is given', async () => {
    const { server, make } = setup()
    const store = make()
    server.failWrites({ status: 429, body: { message: 'Too many requests' } })
    await store.put('fmt/1', new TextEncoder().encode('aparte/1\n'))
    await expect(store.flush()).rejects.toMatchObject({ kind: 'rate-limited', retryAfterMs: 60_000 })
  })

  test('a branch another device moved is rebuilt on, never overwritten', async () => {
    const { make } = setup()
    const a = make()
    const b = make()
    await a.put('fmt/1', new TextEncoder().encode('aparte/1\n'))
    await a.flush()
    await b.list('')
    await a.put('keys/aaaaaaaaaaaaaaaaaaaaaaaaaa.json', new TextEncoder().encode('{}\n'))
    await a.flush()
    await b.put('keys/baaaaaaaaaaaaaaaaaaaaaaaaa.json', new TextEncoder().encode('{}\n'))
    await b.flush()
    expect((await a.list('keys/')).map((e) => e.name)).toEqual([
      'keys/aaaaaaaaaaaaaaaaaaaaaaaaaa.json',
      'keys/baaaaaaaaaaaaaaaaaaaaaaaaa.json',
    ])
  })

  test('a wrong token is an auth error; facts about the repository are reported', async () => {
    const { server, clock } = setup({ tokenExpiration: '2026-11-01 12:00:00 UTC' })
    const bad = githubStore({ owner: 'me', repo: 'vault', token: 'nope', http: server.handle, now: () => clock.now() })
    await expect(bad.list('')).rejects.toMatchObject({ kind: 'auth' })
    const good = githubStore({ owner: 'me', repo: 'vault', token: TOKEN, http: server.handle, now: () => clock.now() })
    const info = await good.info?.()
    expect(info).toMatchObject({ isPublic: false, credentialsExpireAt: Date.parse('2026-11-01T12:00:00Z') })
    expect(tokenExpiry(new Headers({ 'github-authentication-token-expiration': '2026-11-01 12:00:00 +0200' }))).toBe(
      Date.parse('2026-11-01T10:00:00Z'),
    )
  })

  test('checkGitHub tells a wrong token, an unknown owner and a repository the token cannot see', async () => {
    const { server } = setup()
    const check = (owner: string, repo: string, token: string) =>
      checkGitHub({ owner, repo, token, http: server.handle })
    expect(await check('me', 'vault', TOKEN)).toMatchObject({ ok: true, defaultBranch: 'main', isPublic: false })
    expect(await check('me', 'vault', 'nope')).toMatchObject({ ok: false, problem: 'token' })
    expect(await check('someone', 'vault', TOKEN)).toMatchObject({ ok: false, problem: 'not-found' })
    expect(await check('me', 'other', TOKEN)).toMatchObject({ ok: false, problem: 'no-access' })
  })

  test('the destination id is the same on every device and never carries the token', () => {
    const id = githubStoreId({ owner: 'Me', repo: 'Vault' })
    expect(id).toBe(githubStoreId({ owner: 'me', repo: 'vault', root: 'aparte' }))
    expect(id).not.toContain(TOKEN)
  })

  test('two devices sync through it end to end, with a photo, and the upload queue drains', async () => {
    const { make, clock } = setup()
    const bucket = new MemoryBucket()
    const a = await device(bucket, { clock, remote: () => make() })
    const b = await device(bucket, { clock, remote: () => make() })
    const blob = await a.blobs.put(
      new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251),
      'image/jpeg',
    )
    const conv = a.ws.conversations.create({ title: 'via GitHub' })
    await a.sync()
    const status = a.engine.status().dests[0]
    expect(status).toMatchObject({ kind: 'github', state: 'idle', queued: 0 })
    await b.sync()
    expect(b.ws.conversations.get(conv)?.title).toBe('via GitHub')
    expect((await b.blobs.get(blob))?.length).toBe(3 * 1024 * 1024)
  })
})
