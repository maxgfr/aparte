/* OAuth 2.1 of the MCP client (oauth.ts): discovery and its checks, registration, PKCE, tokens, refresh, issuer. */
import { describe, expect, test } from 'bun:test'
import type { FetchLike } from '../contracts/ai.ts'
import { base64urlEncode, utf8 } from '../crypto/bytes.ts'
import { sha256 } from '../crypto/keys.ts'
import { cryptoRng } from '../crypto/rng.ts'
import { FakeClock } from '../workspace/testkit.ts'
import { createMcpFetch } from './fetch.ts'
import {
  checkIssuer,
  clientOf,
  discover,
  exchangeCode,
  needsRefresh,
  OAuthError,
  parseWwwAuthenticate,
  refreshTokens,
  registerClient,
  startFlow,
} from './oauth.ts'
import { FakeMcpServer, ISSUER, REDIRECT_URI, SERVER_URL } from './testkit.ts'

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

/** A fetch answering from a table of URL -> JSON (404 for the rest). */
function table(entries: Record<string, unknown>): FetchLike {
  return async (input) => {
    const url = String(input instanceof Request ? input.url : input)
    return url in entries ? json(entries[url]) : json({}, 404)
  }
}

const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: `${ISSUER}/register`,
  code_challenge_methods_supported: ['S256'],
}

async function fakeFlow() {
  const server = new FakeMcpServer()
  server.oauth = true
  const fetch = createMcpFetch({ request: server.request })
  const deps = { http: fetch, rng: cryptoRng(), clock: new FakeClock() }
  const discovered = await discover(SERVER_URL, {}, deps)
  const client = await registerClient(discovered, { redirectUri: REDIRECT_URI, clientName: 'Aparté' }, deps)
  return { server, deps, discovered, client }
}

describe('WWW-Authenticate', () => {
  test('reads the parameters of a Bearer challenge', () => {
    expect(
      parseWwwAuthenticate('Bearer realm="x", resource_metadata="https://a.example/.well-known/r", scope="a b"'),
    ).toEqual({ resourceMetadata: 'https://a.example/.well-known/r', scope: 'a b' })
    expect(parseWwwAuthenticate('Bearer error=invalid_token')).toEqual({ error: 'invalid_token' })
    expect(parseWwwAuthenticate('Basic realm="x"')).toEqual({})
    expect(parseWwwAuthenticate(null)).toEqual({})
  })
})

describe('discovery', () => {
  test('protected resource metadata, then the authorization server it names', async () => {
    const { discovered } = await fakeFlow()
    expect(discovered.metadata.issuer).toBe(ISSUER)
    expect(discovered.resource).toBe(SERVER_URL)
  })

  test('refuses metadata for another server, another issuer, or without S256', async () => {
    const prm = 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp'
    const asm = `${ISSUER}/.well-known/oauth-authorization-server`
    await expect(
      discover(
        SERVER_URL,
        {},
        { http: table({ [prm]: { resource: 'https://other.example/mcp', authorization_servers: [ISSUER] } }) },
      ),
    ).rejects.toMatchObject({ code: 'discovery' })
    await expect(
      discover(
        SERVER_URL,
        {},
        {
          http: table({
            [prm]: { resource: SERVER_URL, authorization_servers: [ISSUER] },
            [asm]: { ...METADATA, issuer: 'https://evil.example' },
          }),
        },
      ),
    ).rejects.toMatchObject({ code: 'discovery' })
    await expect(
      discover(
        SERVER_URL,
        {},
        {
          http: table({
            [prm]: { resource: SERVER_URL, authorization_servers: [ISSUER] },
            [asm]: { ...METADATA, code_challenge_methods_supported: ['plain'] },
          }),
        },
      ),
    ).rejects.toMatchObject({ code: 'discovery' })
    await expect(
      discover(
        SERVER_URL,
        {},
        {
          http: table({
            [prm]: { resource: SERVER_URL, authorization_servers: [ISSUER] },
            [asm]: { ...METADATA, token_endpoint: 'http://auth.example.test/token' },
          }),
        },
      ),
    ).rejects.toMatchObject({ code: 'insecure' })
  })

  test('a resource_metadata hint on another origin is ignored', async () => {
    const seen: string[] = []
    const fetch: FetchLike = async (input) => {
      seen.push(String(input))
      return json({}, 404)
    }
    await discover(SERVER_URL, { resourceMetadata: 'https://evil.example/prm' }, { http: fetch })
    expect(seen.some((u) => u.startsWith('https://evil.example'))).toBe(false)
  })

  test('a server without metadata is its own authorization server (MCP 2025-03-26)', async () => {
    const d = await discover(SERVER_URL, {}, { http: table({}) })
    expect(d.metadata).toEqual({
      issuer: 'https://mcp.example.test',
      authorization_endpoint: 'https://mcp.example.test/authorize',
      token_endpoint: 'https://mcp.example.test/token',
      registration_endpoint: 'https://mcp.example.test/register',
    })
    expect(d.resource).toBeUndefined()
  })
})

describe('flow', () => {
  test('state and verifier are fresh 256-bit values; the challenge is S256 of the verifier', async () => {
    const { client, deps } = await fakeFlow()
    const a = await startFlow(client, deps)
    const b = await startFlow(client, deps)
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.state).not.toBe(b.state)
    expect(a.verifier).not.toBe(b.verifier)
    const q = new URL(a.url).searchParams
    expect(q.get('code_challenge')).toBe(base64urlEncode(await sha256(utf8(a.verifier))))
    expect(q.get('state')).toBe(a.state)
    expect(a.url).not.toContain(a.verifier)
    expect(q.get('client_id')).toBe(client.clientId)
    expect(q.get('resource')).toBe(SERVER_URL)
  })

  test('the code exchanges once, with the verifier; refresh keeps the refresh token unless rotated', async () => {
    const { server, client, deps } = await fakeFlow()
    const flow = await startFlow(client, deps)
    const { code } = server.authorize(flow.url)
    const tokens = await exchangeCode(flow, code, deps)
    expect(tokens).toMatchObject({ tokenType: 'Bearer', accessToken: server.issued[0]?.access })
    expect(tokens.expiresAt).toBe(deps.clock.now() + 3_600_000)
    await expect(exchangeCode(flow, code, deps)).rejects.toMatchObject({ code: 'token' })
    const other = await startFlow(client, deps)
    const second = server.authorize(other.url)
    await expect(exchangeCode(flow, second.code, deps)).rejects.toBeInstanceOf(OAuthError)
    const fresh = await refreshTokens(client, tokens, deps)
    expect(fresh.accessToken).toBe(server.issued[1]?.access as string)
    expect(needsRefresh(fresh, deps.clock.now())).toBe(false)
    expect(needsRefresh(fresh, deps.clock.now() + 3_600_000)).toBe(true)
  })

  test('a token that is not a bearer token is refused', async () => {
    const client = clientOf({ metadata: METADATA }, { clientId: 'c', tokenAuth: 'none', redirectUri: REDIRECT_URI })
    const deps = {
      http: (async () => json({ access_token: 'x', token_type: 'mac' })) as FetchLike,
      rng: cryptoRng(),
      clock: new FakeClock(),
    }
    await expect(
      refreshTokens(client, { accessToken: 'a', tokenType: 'Bearer', refreshToken: 'r' }, deps),
    ).rejects.toMatchObject({
      code: 'token',
    })
  })

  test('the iss parameter (RFC 9207)', () => {
    const base = clientOf({ metadata: METADATA }, { clientId: 'c', tokenAuth: 'none', redirectUri: REDIRECT_URI })
    expect(() => checkIssuer(base, null)).not.toThrow()
    expect(() => checkIssuer(base, `${ISSUER}/`)).not.toThrow()
    expect(() => checkIssuer(base, 'https://evil.example')).toThrow(OAuthError)
    const strict = { ...base, issParameter: true }
    expect(() => checkIssuer(strict, null)).toThrow(OAuthError)
  })

  test('registration needs a registration endpoint', async () => {
    const { registration_endpoint: _r, ...noReg } = METADATA
    await expect(
      registerClient({ metadata: noReg }, { redirectUri: REDIRECT_URI, clientName: 'x' }, { http: table({}) }),
    ).rejects.toMatchObject({ code: 'registration' })
  })
})
