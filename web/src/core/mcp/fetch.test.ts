/* The MCP fetch (fetch.ts): purpose mcp, no user-agent, redirects refused, bodies capped, 401 challenges kept. */
import { describe, expect, test } from 'bun:test'
import { capResponse, createMcpFetch, MAX_RESPONSE_BYTES } from './fetch.ts'

describe('MCP fetch', () => {
  test('goes through request() with purpose mcp, without user-agent, refusing redirects', async () => {
    const seen: { url: string; init: RequestInit & { purpose: string } }[] = []
    const fetch = createMcpFetch({
      request: async (url, init) => {
        seen.push({ url: String(url), init })
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      },
    })
    await fetch('https://mcp.example.test/mcp', { method: 'POST', headers: { 'User-Agent': 'ai-sdk/mcp', a: 'b' } })
    expect(seen[0]?.init.purpose).toBe('mcp')
    expect(seen[0]?.init.redirect).toBe('error')
    const headers = new Headers(seen[0]?.init.headers)
    expect(headers.has('user-agent')).toBe(false)
    expect(headers.get('a')).toBe('b')
  })

  test('hands the challenge of a 401 over', async () => {
    let challenge: string | null = 'none'
    const fetch = createMcpFetch({
      request: async () => new Response('', { status: 401, headers: { 'www-authenticate': 'Bearer scope="x"' } }),
      onUnauthorized: (h) => {
        challenge = h
      },
    })
    expect((await fetch('https://mcp.example.test/mcp')).status).toBe(401)
    expect(challenge).toBe('Bearer scope="x"')
  })

  test('a body over the cap errors, declared or not', async () => {
    const big = new Uint8Array(MAX_RESPONSE_BYTES + 1)
    expect(() => capResponse(new Response(big, { headers: { 'content-length': String(big.length) } }))).toThrow(
      RangeError,
    )
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(big)
        c.close()
      },
    })
    await expect(capResponse(new Response(stream)).arrayBuffer()).rejects.toBeInstanceOf(RangeError)
    expect(await capResponse(new Response('small')).text()).toBe('small')
    expect(capResponse(new Response(null, { status: 204 })).status).toBe(204)
  })
})
