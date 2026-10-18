import { afterEach, describe, expect, test } from 'bun:test'
import { networkLog, resetNetworkLog } from './net.ts'
import { confineFetch } from './workerNet.ts'

const PINNED = 'https://huggingface.co/org/model/resolve/abc/config.json'

/** A worker-like global scope whose own fetch records what reaches the network. */
function scope() {
  const reached: { url: string; init?: RequestInit }[] = []
  const s: Record<string, unknown> = {
    location: { href: 'https://app.example/aparte/assets/w.js' },
    fetch: async (url: string, init?: RequestInit) => {
      reached.push({ url, ...(init ? { init } : {}) })
      return new Response('body')
    },
    XMLHttpRequest: class {},
    WebSocket: class {},
    EventSource: class {},
  }
  return { s, reached }
}

async function sha(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

afterEach(() => resetNetworkLog())

describe('confineFetch', () => {
  test('admits routed URLs through net.ts, without credentials or referrer, and records them', async () => {
    const { s, reached } = scope()
    const confined = confineFetch((url) => (url.href === PINNED ? { purpose: 'download' } : null), s)
    expect(s.fetch).toBe(confined)
    expect(await (await confined(PINNED)).text()).toBe('body')
    expect(reached[0]?.url).toBe(PINNED)
    expect(reached[0]?.init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' })
    expect(networkLog.snapshot().map((e) => [e.origin, e.purpose])).toEqual([['https://huggingface.co', 'download']])
  })

  test('refuses everything else without touching the network', async () => {
    const { s, reached } = scope()
    const confined = confineFetch(() => null, s)
    await expect(confined('https://evil.example/x')).rejects.toBeInstanceOf(TypeError)
    await expect(confined('http://192.168.1.2/x')).rejects.toBeInstanceOf(TypeError)
    expect(reached).toEqual([])
    expect(s.XMLHttpRequest).toBeUndefined()
    expect(s.WebSocket).toBeUndefined()
    expect(s.EventSource).toBeUndefined()
  })

  test('net.ts rules still apply to a routed URL', async () => {
    const { s, reached } = scope()
    const confined = confineFetch(() => ({ purpose: 'download' }), s)
    await expect(confined('http://example.com/x')).rejects.toThrow('plain HTTP')
    expect(reached).toEqual([])
  })

  test('a pinned digest is checked', async () => {
    const ok = scope()
    const digest = await sha('body')
    const confinedOk = confineFetch(() => ({ purpose: 'download', sha256: digest }), ok.s)
    expect(await (await confinedOk(PINNED)).text()).toBe('body')
    const bad = scope()
    const confinedBad = confineFetch(() => ({ purpose: 'download', sha256: '0'.repeat(64) }), bad.s)
    await expect(confinedBad(PINNED)).rejects.toThrow('pinned digest')
  })

  test('a local answer never reaches the network', async () => {
    const { s, reached } = scope()
    const confined = confineFetch(() => ({ respond: () => new Response(null, { status: 404 }) }), s)
    expect((await confined(PINNED)).status).toBe(404)
    expect(reached).toEqual([])
  })

  test('`via` fetches the pinned copy in place of the name asked for, under the same digest', async () => {
    const { s, reached } = scope()
    const digest = await sha('body')
    const moving = 'https://huggingface.co/org/model/resolve/main/config.json'
    const confined = confineFetch(
      (url) => (url.href === moving ? { purpose: 'download', sha256: digest, via: PINNED } : null),
      s,
    )
    expect(await (await confined(moving)).text()).toBe('body')
    expect(reached.map((r) => r.url)).toEqual([PINNED])
    const wrong = scope()
    const confinedWrong = confineFetch(() => ({ purpose: 'download', sha256: '0'.repeat(64), via: PINNED }), wrong.s)
    await expect(confinedWrong(moving)).rejects.toThrow('pinned digest')
  })

  test('the route sees the request options (a range probe can be answered locally)', async () => {
    const { s, reached } = scope()
    const confined = confineFetch(
      (_url, init) =>
        new Headers(init?.headers).get('range') === 'bytes=0-0'
          ? { respond: () => new Response(null, { status: 200 }) }
          : null,
      s,
    )
    expect((await confined(PINNED, { headers: { Range: 'bytes=0-0' } })).status).toBe(200)
    await expect(confined(PINNED)).rejects.toBeInstanceOf(TypeError)
    expect(reached).toEqual([])
  })
})
