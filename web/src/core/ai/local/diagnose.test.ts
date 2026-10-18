import { describe, expect, test } from 'bun:test'
import type { FetchLike } from '../../contracts/ai.ts'
import { diagnoseServer, isSafari, ollamaVersion } from './diagnose.ts'

const BASE = 'http://localhost:11434/v1'

/** A fetch that answers by URL and mode; `null` plays a request the browser refused (a TypeError). */
function fakeGet(answer: (url: string, init?: RequestInit) => Response | null): FetchLike & { calls: string[] } {
  const calls: string[] = []
  const get = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.mode ?? 'cors'} ${url}`)
    const res = answer(url, init)
    if (res === null) throw new TypeError('Failed to fetch')
    return res
  }) as FetchLike & { calls: string[] }
  get.calls = calls
  return get
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('diagnoseServer', () => {
  test('ok with the model count, and Ollama’s version', async () => {
    const get = fakeGet((url) =>
      url.endsWith('/v1/models') ? json({ data: [{ id: 'a' }, { id: 'b' }] }) : json({ version: '0.12.3' }),
    )
    expect(await diagnoseServer(BASE, 'ollama', { get, online: true })).toEqual({
      kind: 'ok',
      models: 2,
      version: '0.12.3',
    })
    expect(get.calls).toEqual(['cors http://localhost:11434/v1/models', 'cors http://localhost:11434/api/version'])
    expect(await diagnoseServer('http://localhost:1234/v1', 'lmstudio', { get, online: true })).toEqual({
      kind: 'ok',
      models: 2,
    })
  })

  test('an HTTP error', async () => {
    const get = fakeGet(() => json({}, 404))
    expect(await diagnoseServer(BASE, 'ollama', { get, online: true })).toEqual({ kind: 'http', status: 404 })
  })

  test('refused but answering is CORS; refused both ways is unreachable', async () => {
    const cors = fakeGet((_url, init) => (init?.mode === 'no-cors' ? new Response(null) : null))
    expect(await diagnoseServer(BASE, 'ollama', { get: cors, online: true })).toEqual({ kind: 'cors' })
    expect(cors.calls[1]).toBe('no-cors http://localhost:11434')
    const down = fakeGet(() => null)
    expect(await diagnoseServer(BASE, 'ollama', { get: down, online: true })).toEqual({ kind: 'unreachable' })
  })

  test('offline asks nothing', async () => {
    const get = fakeGet(() => json({}))
    expect(await diagnoseServer(BASE, 'ollama', { get, online: false })).toEqual({ kind: 'offline' })
    expect(get.calls).toEqual([])
  })

  test('a version that is not a plain token is ignored', async () => {
    const get = fakeGet(() => json({ version: '<img src=x>' }))
    expect(await ollamaVersion(BASE, { get, online: true })).toBeNull()
  })

  test('Safari is told apart from Chromium and Firefox', () => {
    const safari = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15'
    const chrome = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'
    expect(isSafari(safari)).toBe(true)
    expect(isSafari(chrome)).toBe(false)
  })
})
