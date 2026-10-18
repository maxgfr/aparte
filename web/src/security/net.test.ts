import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { checkRequestURL, NET_PURPOSES, type NetPurpose, networkLog, request, resetNetworkLog } from './net.ts'

const page = 'https://maxgfr.github.io/aparte/'
const allowlist: Record<string, unknown> = await Bun.file(
  new URL('../../../spec/network-allowlist.json', import.meta.url),
).json()

interface Call {
  url: string
  init: RequestInit | undefined
}

let calls: Call[] = []
const realFetch = globalThis.fetch
const g = globalThis as { location?: unknown }
const realLocation = g.location

beforeEach(() => {
  calls = []
  resetNetworkLog()
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return new Response('ok')
  }) as typeof fetch
  g.location = new URL(page)
})

afterEach(() => {
  globalThis.fetch = realFetch
  g.location = realLocation
})

describe('checkRequestURL', () => {
  test.each([
    ['https://api.example.com/v1/chat', 'provider'],
    ['http://localhost:11434/api/chat', 'provider'],
    ['http://localhost/v1', 'provider'],
    ['http://127.0.0.1:1234/v1/models', 'provider'],
    ['https://mcp.example.org/sse', 'mcp'],
    ['/aparte/manifest.webmanifest', 'app'],
    ['https://maxgfr.github.io/aparte/version.json', 'app'],
  ] as const)('accepts %s for %s', (url, purpose) => {
    expect(checkRequestURL(url, purpose, page)).toBeInstanceOf(URL)
  })

  test.each([
    ['plain HTTP to a remote host', 'http://api.example.com/v1', 'provider'],
    ['plain HTTP to a LAN address', 'http://192.168.1.10:11434/api', 'provider'],
    ['plain HTTP to a localhost subdomain', 'http://evil.localhost/v1', 'provider'],
    ['plain HTTP to the IPv6 loopback, which the CSP does not list', 'http://[::1]:11434/', 'provider'],
    ['a look-alike loopback host', 'http://127.0.0.1.evil.example/', 'provider'],
    ['a user in the URL', 'https://user@api.example.com/', 'provider'],
    ['a user and password in the URL', 'https://user:secret@api.example.com/', 'provider'],
    ['credentials on the loopback', 'http://a:b@localhost:8080/', 'provider'],
    ['a web socket', 'wss://sync.example.com/', 'sync'],
    ['a data URL', 'data:text/plain,hi', 'download'],
    ['a blob URL', 'blob:https://maxgfr.github.io/x', 'download'],
    ['a file URL', 'file:///etc/passwd', 'download'],
    ['another origin as the app', 'https://evil.example/aparte/x', 'app'],
    ['an unparsable URL', 'http://', 'provider'],
  ] as const)('refuses %s', (_, url, purpose) => {
    expect(() => checkRequestURL(url, purpose, page)).toThrow(TypeError)
  })

  test('refuses an unknown purpose', () => {
    expect(() => checkRequestURL('https://a.example/', 'telemetry' as NetPurpose, page)).toThrow(TypeError)
  })

  test('refuses relative URLs and the app purpose without a page', () => {
    expect(() => checkRequestURL('/aparte/x', 'app', null)).toThrow(TypeError)
    expect(() => checkRequestURL('https://maxgfr.github.io/aparte/x', 'app', null)).toThrow(TypeError)
  })
})

describe('request', () => {
  test('never sends cookies, HTTP auth or a referrer, whatever the caller asks', async () => {
    await request('https://api.example.com/v1/chat', {
      purpose: 'provider',
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      referrerPolicy: 'unsafe-url',
    })
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call?.url).toBe('https://api.example.com/v1/chat')
    expect(call?.init?.credentials).toBe('omit')
    expect(call?.init?.referrerPolicy).toBe('no-referrer')
    expect(call?.init?.method).toBe('POST')
    expect(call?.init?.body).toBe('{}')
    expect(call?.init).not.toHaveProperty('purpose')
  })

  test('rejects refused URLs without fetching or recording them', async () => {
    await expect(request('http://api.example.com/', { purpose: 'provider' })).rejects.toThrow(TypeError)
    await expect(request('https://u:p@api.example.com/', { purpose: 'provider' })).rejects.toThrow(TypeError)
    expect(calls).toHaveLength(0)
    expect(networkLog.snapshot()).toEqual([])
  })

  test('records each origin and purpose, never the path', async () => {
    const seen: number[] = []
    const off = networkLog.subscribe(() => seen.push(networkLog.snapshot().length))
    await request('https://api.example.com/v1/chat?key=secret', { purpose: 'provider' })
    await request('https://api.example.com/v1/models', { purpose: 'provider' })
    await request('https://api.example.com/v1/models', { purpose: 'catalog' })
    await request('manifest.webmanifest', { purpose: 'app' })
    off()
    await request('http://localhost:11434/api/tags', { purpose: 'provider' })

    const log = networkLog.snapshot()
    expect(log.map((e) => [e.purpose, e.origin, e.count])).toEqual([
      ['provider', 'https://api.example.com', 2],
      ['catalog', 'https://api.example.com', 1],
      ['app', 'https://maxgfr.github.io', 1],
      ['provider', 'http://localhost:11434', 1],
    ])
    expect(JSON.stringify(log)).not.toContain('secret')
    expect(JSON.stringify(log)).not.toContain('/v1')
    expect(seen).toEqual([1, 1, 2, 3])
    expect(calls[3]?.url).toBe('https://maxgfr.github.io/aparte/manifest.webmanifest')
  })

  test('keeps the snapshot stable between changes and frozen', async () => {
    const before = networkLog.snapshot()
    expect(networkLog.snapshot()).toBe(before)
    await request('https://api.example.com/', { purpose: 'provider' })
    const after = networkLog.snapshot()
    expect(after).not.toBe(before)
    expect(networkLog.snapshot()).toBe(after)
    expect(Object.isFrozen(after)).toBe(true)
  })

  test('records an attempt even when the network fails', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('offline')
    }) as unknown as typeof fetch
    await expect(request('https://api.example.com/', { purpose: 'provider' })).rejects.toThrow('offline')
    expect(networkLog.snapshot().map((e) => e.origin)).toEqual(['https://api.example.com'])
  })
})

describe('spec/network-allowlist.json', () => {
  test('lists exactly the purposes net.ts knows', () => {
    const purposes = Object.keys(allowlist).filter((k) => !k.startsWith('$'))
    expect(purposes.sort()).toEqual([...NET_PURPOSES].sort())
  })

  test('lets the app contact its own origin, the default provider hosts and the pinned model hosts, and nothing else', () => {
    expect(allowlist.app).toEqual(['self'])
    expect(allowlist.provider).toEqual([
      'https://api.anthropic.com',
      'https://api.openai.com',
      'https://generativelanguage.googleapis.com',
      'https://api.mistral.ai',
      'https://openrouter.ai',
    ])
    expect(allowlist.download).toEqual([
      'https://huggingface.co',
      'https://us.aws.cdn.hf.co',
      'https://eu.aws.cdn.hf.co',
      'https://cas-bridge.xethub.hf.co',
      'https://cdn-lfs.hf.co',
      'https://cdn-lfs-us-1.hf.co',
      'https://cdn-lfs-eu-1.hf.co',
      'https://raw.githubusercontent.com',
    ])
    for (const purpose of NET_PURPOSES.filter((p) => p !== 'app' && p !== 'provider' && p !== 'download'))
      expect(allowlist[purpose]).toEqual([])
  })
})
