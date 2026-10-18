/*
 * OAuth 2.1 for remote MCP servers (MCP authorization, 2025-11-25): discovery of the authorization server from the
 * protected resource metadata (RFC 9728) and the authorization server metadata (RFC 8414, OpenID Connect discovery),
 * dynamic client registration (RFC 7591), the authorization code flow with PKCE S256 (RFC 7636), resource indicators
 * (RFC 8707), the `iss` response parameter (RFC 9207), and refresh. Pure: the network is an injected `http` function (the MCP
 * fetch of fetch.ts, purpose `mcp`), randomness an injected Rng, time an injected Clock.
 *
 * Invariants:
 * - Every endpoint the app contacts or opens comes from metadata it validated: https (http on the loopback only), an
 *   issuer equal to the one it asked for, a protected resource that is the server it is signing in to.
 * - The PKCE verifier and the state are 256-bit random values, kept in the returned flow object only (memory): they
 *   are never stored, logged or sent anywhere but where OAuth says (the challenge and the state to the authorization
 *   endpoint, the verifier to the token endpoint).
 * - A token response must be a JSON object with a string `access_token` and a `token_type` of `Bearer`; anything else
 *   is an error, never a partial success.
 * - Errors are OAuthError with a code the interface explains; the message never contains a token or a code.
 */
import type { FetchLike } from '../contracts/ai.ts'
import type { Rng } from '../contracts/crypto.ts'
import type { OAuthClient, OAuthTokens } from '../contracts/mcp.ts'
import type { Clock } from '../contracts/vault.ts'
import { base64urlEncode, utf8 } from '../crypto/bytes.ts'
import { sha256 } from '../crypto/keys.ts'

export type OAuthErrorCode =
  /** No usable metadata (or metadata that fails validation). */
  | 'discovery'
  /** The authorization server has no registration endpoint, or refused to register the app. */
  | 'registration'
  /** The callback's `iss` is not the issuer (RFC 9207). */
  | 'issuer'
  /** The user or the authorization server refused (`error` in the callback). */
  | 'denied'
  /** The token endpoint refused, or answered something that is not a bearer token. */
  | 'token'
  /** An endpoint is not https. */
  | 'insecure'

export class OAuthError extends Error {
  override readonly name = 'OAuthError'
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

export interface OAuthDeps {
  /** The MCP fetch (fetch.ts): net.ts with purpose `mcp`. */
  readonly http: FetchLike
  readonly rng: Rng
  readonly clock: Clock
}

/** Authorization server metadata, the fields the app uses. */
export interface AuthServerMetadata {
  readonly issuer: string
  readonly authorization_endpoint: string
  readonly token_endpoint: string
  readonly registration_endpoint?: string
  readonly code_challenge_methods_supported?: readonly string[]
  readonly response_types_supported?: readonly string[]
  readonly token_endpoint_auth_methods_supported?: readonly string[]
  readonly authorization_response_iss_parameter_supported?: boolean
  readonly scopes_supported?: readonly string[]
}

export interface Discovered {
  readonly metadata: AuthServerMetadata
  /** The RFC 8707 resource, when the server published protected resource metadata. */
  readonly resource?: string
  readonly scope?: string
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Parses `url` and refuses anything but https (http on the loopback), credentials and fragments. */
export function safeEndpoint(value: unknown, what: string): URL {
  if (typeof value !== 'string') throw new OAuthError('discovery', `${what} is missing`)
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new OAuthError('discovery', `${what} is not a URL`, { cause })
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new OAuthError('insecure', `${what} is not https`)
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new OAuthError('discovery', `${what} carries credentials or a fragment`)
  }
  return url
}

const noSlash = (s: string): string => s.replace(/\/+$/, '')

/** The parameters of a `WWW-Authenticate: Bearer ...` challenge (RFC 6750, RFC 9728 section 5.1). */
export function parseWwwAuthenticate(header: string | null | undefined): {
  readonly resourceMetadata?: string
  readonly scope?: string
  readonly error?: string
} {
  if (typeof header !== 'string' || !/^\s*bearer\b/i.test(header)) return {}
  const out: Record<string, string> = {}
  for (const m of header.matchAll(/([A-Za-z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
    const key = (m[1] as string).toLowerCase()
    const value = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1')
    if (!(key in out)) out[key] = value
  }
  return {
    ...(out.resource_metadata === undefined ? {} : { resourceMetadata: out.resource_metadata }),
    ...(out.scope === undefined ? {} : { scope: out.scope }),
    ...(out.error === undefined ? {} : { error: out.error }),
  }
}

/**
 * GETs a JSON object; null when it is absent (a 4xx, or a network error such as a document served without CORS),
 * throws on a server error or a malformed body.
 */
async function getJson(url: URL, http: FetchLike): Promise<Record<string, unknown> | null> {
  let response: Response
  try {
    response = await http(url.href, { method: 'GET', headers: { accept: 'application/json' } })
  } catch (error) {
    if (error instanceof TypeError) return null
    throw error
  }
  if (response.status >= 400 && response.status < 500) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  if (!response.ok) throw new OAuthError('discovery', `${url.origin} answered ${response.status}`)
  let data: unknown
  try {
    data = await response.json()
  } catch (cause) {
    throw new OAuthError('discovery', `${url.origin} answered something that is not JSON`, { cause })
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new OAuthError('discovery', `${url.origin} answered something that is not a JSON object`)
  }
  return data as Record<string, unknown>
}

/** The candidate URLs of a `.well-known` document for `base` (RFC 8615 with the path appended, then at the root). */
function wellKnown(base: URL, name: string): URL[] {
  const path = noSlash(base.pathname)
  const urls = [new URL(`/.well-known/${name}${path}`, base.origin)]
  if (path !== '') urls.push(new URL(`/.well-known/${name}`, base.origin))
  return urls
}

/** Whether a protected resource metadata `resource` names the server at `serverUrl` (RFC 9728 section 3.3). */
function resourceMatches(resource: string, serverUrl: URL): boolean {
  let r: URL
  try {
    r = new URL(resource)
  } catch {
    return false
  }
  if (r.origin !== serverUrl.origin) return false
  const want = noSlash(serverUrl.pathname)
  const got = noSlash(r.pathname)
  // The resource is the server's URL or a parent of it (the origin, a common base path).
  return got === '' || want === got || want.startsWith(`${got}/`)
}

/** RFC 8414 section 3.1 and OpenID Connect discovery URLs of an issuer, in the order MCP prescribes. */
function metadataUrls(issuer: URL): URL[] {
  const path = noSlash(issuer.pathname)
  if (path === '') {
    return [
      new URL('/.well-known/oauth-authorization-server', issuer.origin),
      new URL('/.well-known/openid-configuration', issuer.origin),
    ]
  }
  return [
    new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin),
    new URL(`/.well-known/openid-configuration${path}`, issuer.origin),
    new URL(`${path}/.well-known/openid-configuration`, issuer.origin),
  ]
}

function checkMetadata(data: Record<string, unknown>, issuer: string): AuthServerMetadata {
  if (typeof data.issuer !== 'string' || noSlash(data.issuer) !== noSlash(issuer)) {
    throw new OAuthError('discovery', 'The authorization server metadata names another issuer')
  }
  safeEndpoint(data.authorization_endpoint, 'authorization_endpoint')
  safeEndpoint(data.token_endpoint, 'token_endpoint')
  if (data.registration_endpoint !== undefined) safeEndpoint(data.registration_endpoint, 'registration_endpoint')
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined)
  const methods = list(data.code_challenge_methods_supported)
  if (methods !== undefined && !methods.includes('S256')) {
    throw new OAuthError('discovery', 'The authorization server does not support PKCE with S256')
  }
  const responseTypes = list(data.response_types_supported)
  if (responseTypes !== undefined && !responseTypes.includes('code')) {
    throw new OAuthError('discovery', 'The authorization server does not support the authorization code flow')
  }
  return {
    issuer: data.issuer,
    authorization_endpoint: data.authorization_endpoint as string,
    token_endpoint: data.token_endpoint as string,
    ...(typeof data.registration_endpoint === 'string' ? { registration_endpoint: data.registration_endpoint } : {}),
    ...(methods === undefined ? {} : { code_challenge_methods_supported: methods }),
    ...(responseTypes === undefined ? {} : { response_types_supported: responseTypes }),
    ...(list(data.token_endpoint_auth_methods_supported) === undefined
      ? {}
      : { token_endpoint_auth_methods_supported: list(data.token_endpoint_auth_methods_supported) }),
    ...(data.authorization_response_iss_parameter_supported === true
      ? { authorization_response_iss_parameter_supported: true }
      : {}),
    ...(list(data.scopes_supported) === undefined ? {} : { scopes_supported: list(data.scopes_supported) }),
  }
}

/**
 * Finds the authorization server of the MCP server at `serverUrl`: its protected resource metadata (from the 401's
 * `resource_metadata`, which must be on the server's origin, else the well-known URLs), then the first authorization
 * server it lists. A server without protected resource metadata is its own authorization server (MCP 2025-03-26),
 * with the default endpoints when it publishes no metadata either.
 */
export async function discover(
  serverUrl: string,
  hint: { readonly resourceMetadata?: string; readonly scope?: string },
  deps: Pick<OAuthDeps, 'http'>,
): Promise<Discovered> {
  const server = safeEndpoint(serverUrl, 'The server URL')
  const candidates: URL[] = []
  if (hint.resourceMetadata !== undefined) {
    const url = safeEndpoint(hint.resourceMetadata, 'resource_metadata')
    if (url.origin === server.origin) candidates.push(url)
  }
  candidates.push(...wellKnown(server, 'oauth-protected-resource'))
  let resourceMetadata: Record<string, unknown> | null = null
  for (const url of candidates) {
    resourceMetadata = await getJson(url, deps.http)
    if (resourceMetadata !== null) break
  }

  if (resourceMetadata !== null) {
    const resource = resourceMetadata.resource
    if (typeof resource !== 'string' || !resourceMatches(resource, server)) {
      throw new OAuthError('discovery', 'The protected resource metadata is for another server')
    }
    const servers = Array.isArray(resourceMetadata.authorization_servers)
      ? resourceMetadata.authorization_servers.filter((s): s is string => typeof s === 'string')
      : []
    const issuerText = servers[0]
    if (issuerText === undefined) throw new OAuthError('discovery', 'The server names no authorization server')
    const issuer = safeEndpoint(issuerText, 'The authorization server')
    let metadata: AuthServerMetadata | null = null
    for (const url of metadataUrls(issuer)) {
      const data = await getJson(url, deps.http)
      if (data !== null) {
        metadata = checkMetadata(data, issuerText)
        break
      }
    }
    if (metadata === null) throw new OAuthError('discovery', 'The authorization server publishes no metadata')
    const scopes = Array.isArray(resourceMetadata.scopes_supported)
      ? resourceMetadata.scopes_supported.filter((s): s is string => typeof s === 'string')
      : []
    const scope = hint.scope ?? (scopes.length > 0 ? scopes.join(' ') : undefined)
    return { metadata, resource, ...(scope === undefined ? {} : { scope }) }
  }

  // Protocol 2025-03-26: the authorization base URL is the server's origin.
  const issuer = server.origin
  let metadata: AuthServerMetadata | null = null
  for (const url of metadataUrls(new URL(issuer))) {
    const data = await getJson(url, deps.http)
    if (data !== null) {
      metadata = checkMetadata(data, issuer)
      break
    }
  }
  metadata ??= {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
  }
  return { metadata, ...(hint.scope === undefined ? {} : { scope: hint.scope }) }
}

/** The JSON body of a response, or an OAuthError of `code` naming its status and OAuth `error`. */
async function jsonOrError(response: Response, code: OAuthErrorCode, what: string): Promise<Record<string, unknown>> {
  let data: unknown = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  const body =
    data !== null && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : null
  if (!response.ok || body === null) {
    const error = typeof body?.error === 'string' && /^[\x20-\x7e]{1,64}$/.test(body.error) ? ` (${body.error})` : ''
    throw new OAuthError(code, `${what} answered ${response.status}${error}`)
  }
  return body
}

/** Registers the app at the authorization server (RFC 7591) as a public client with this redirect URI. */
export async function registerClient(
  discovered: Discovered,
  input: { readonly redirectUri: string; readonly clientName: string; readonly clientUri?: string },
  deps: Pick<OAuthDeps, 'http'>,
): Promise<OAuthClient> {
  const endpoint = discovered.metadata.registration_endpoint
  if (endpoint === undefined) {
    throw new OAuthError('registration', 'The authorization server does not let apps register themselves')
  }
  const url = safeEndpoint(endpoint, 'registration_endpoint')
  const response = await deps.http(url.href, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: input.clientName,
      ...(input.clientUri === undefined ? {} : { client_uri: input.clientUri }),
      redirect_uris: [input.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
      ...(discovered.scope === undefined ? {} : { scope: discovered.scope }),
    }),
  })
  const body = await jsonOrError(response, 'registration', 'The registration endpoint')
  if (typeof body.client_id !== 'string' || body.client_id === '') {
    throw new OAuthError('registration', 'The registration answer has no client_id')
  }
  const secret = typeof body.client_secret === 'string' && body.client_secret !== '' ? body.client_secret : undefined
  const method =
    typeof body.token_endpoint_auth_method === 'string'
      ? body.token_endpoint_auth_method
      : secret === undefined
        ? 'none'
        : 'client_secret_basic'
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(method)) {
    throw new OAuthError('registration', 'The registered client uses an authentication method the app lacks')
  }
  return clientOf(discovered, {
    clientId: body.client_id,
    ...(secret === undefined ? {} : { clientSecret: secret }),
    tokenAuth: method,
    redirectUri: input.redirectUri,
  })
}

/** The stored client of a registration (or of a client id the user was given). */
export function clientOf(
  discovered: Discovered,
  registration: Pick<OAuthClient, 'clientId' | 'clientSecret' | 'tokenAuth' | 'redirectUri'>,
): OAuthClient {
  const m = discovered.metadata
  return {
    clientId: registration.clientId,
    ...(registration.clientSecret === undefined ? {} : { clientSecret: registration.clientSecret }),
    tokenAuth: registration.tokenAuth,
    issuer: m.issuer,
    authorizationEndpoint: m.authorization_endpoint,
    tokenEndpoint: m.token_endpoint,
    issParameter: m.authorization_response_iss_parameter_supported === true,
    ...(discovered.resource === undefined ? {} : { resource: discovered.resource }),
    ...(discovered.scope === undefined ? {} : { scope: discovered.scope }),
    redirectUri: registration.redirectUri,
  }
}

/** One authorization request in flight: everything the callback is checked against, in memory only. */
export interface PendingFlow {
  readonly client: OAuthClient
  /** base64url of 32 random bytes: the CSRF token, and the name of the callback's channel. */
  readonly state: string
  /** base64url of 32 random bytes (RFC 7636 section 4.1). */
  readonly verifier: string
  /** The authorization URL the popup opens. */
  readonly url: string
  readonly createdAt: number
}

/** Prepares an authorization request with a fresh state and PKCE verifier. */
export async function startFlow(client: OAuthClient, deps: Pick<OAuthDeps, 'rng' | 'clock'>): Promise<PendingFlow> {
  const endpoint = safeEndpoint(client.authorizationEndpoint, 'authorization_endpoint')
  const state = base64urlEncode(deps.rng.bytes(32))
  const verifier = base64urlEncode(deps.rng.bytes(32))
  const challenge = base64urlEncode(await sha256(utf8(verifier)))
  const url = new URL(endpoint.href)
  const q = url.searchParams
  q.set('response_type', 'code')
  q.set('client_id', client.clientId)
  q.set('redirect_uri', client.redirectUri)
  q.set('code_challenge', challenge)
  q.set('code_challenge_method', 'S256')
  q.set('state', state)
  if (client.scope !== undefined) q.set('scope', client.scope)
  if (client.resource !== undefined) q.set('resource', client.resource)
  return { client, state, verifier, url: url.href, createdAt: deps.clock.now() }
}

/** RFC 9207: the `iss` of an authorization response, checked against the client's issuer. */
export function checkIssuer(client: OAuthClient, iss: string | null): void {
  if (iss === null) {
    if (client.issParameter) throw new OAuthError('issuer', 'The authorization response does not name its issuer')
    return
  }
  if (noSlash(iss) !== noSlash(client.issuer)) {
    throw new OAuthError('issuer', 'The authorization response comes from another issuer')
  }
}

function basic(id: string, secret: string): string {
  const encoded = `${encodeURIComponent(id)}:${encodeURIComponent(secret)}`
  let binary = ''
  for (const byte of utf8(encoded)) binary += String.fromCharCode(byte)
  return `Basic ${btoa(binary)}`
}

async function tokenRequest(client: OAuthClient, params: URLSearchParams, deps: OAuthDeps): Promise<OAuthTokens> {
  const url = safeEndpoint(client.tokenEndpoint, 'token_endpoint')
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  }
  if (client.tokenAuth === 'client_secret_basic' && client.clientSecret !== undefined) {
    headers.authorization = basic(client.clientId, client.clientSecret)
  } else {
    params.set('client_id', client.clientId)
    if (client.tokenAuth === 'client_secret_post' && client.clientSecret !== undefined) {
      params.set('client_secret', client.clientSecret)
    }
  }
  if (client.resource !== undefined) params.set('resource', client.resource)
  const started = deps.clock.now()
  const response = await deps.http(url.href, { method: 'POST', headers, body: params.toString() })
  const body = await jsonOrError(response, 'token', 'The token endpoint')
  if (typeof body.access_token !== 'string' || body.access_token === '' || /[\s\p{Cc}]/u.test(body.access_token)) {
    throw new OAuthError('token', 'The token endpoint answered no usable access token')
  }
  if (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer') {
    throw new OAuthError('token', 'The token endpoint answered a token that is not a bearer token')
  }
  const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) ? body.expires_in : null
  return {
    accessToken: body.access_token,
    tokenType: 'Bearer',
    ...(typeof body.refresh_token === 'string' && body.refresh_token !== ''
      ? { refreshToken: body.refresh_token }
      : {}),
    ...(expiresIn === null ? {} : { expiresAt: started + Math.max(0, Math.floor(expiresIn * 1000)) }),
    ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
  }
}

/** Exchanges the code of the flow's callback (with its PKCE verifier) for tokens. */
export function exchangeCode(flow: PendingFlow, code: string, deps: OAuthDeps): Promise<OAuthTokens> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: flow.client.redirectUri,
    code_verifier: flow.verifier,
  })
  return tokenRequest(flow.client, params, deps)
}

/** Refreshes the tokens; the refresh token is kept when the server does not rotate it. */
export async function refreshTokens(client: OAuthClient, tokens: OAuthTokens, deps: OAuthDeps): Promise<OAuthTokens> {
  if (tokens.refreshToken === undefined) throw new OAuthError('token', 'No refresh token')
  const params = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken })
  const fresh = await tokenRequest(client, params, deps)
  return fresh.refreshToken === undefined ? { ...fresh, refreshToken: tokens.refreshToken } : fresh
}

/** Refresh this long before the access token expires. */
export const REFRESH_MARGIN_MS = 60_000

export function needsRefresh(tokens: OAuthTokens, now: number): boolean {
  return tokens.expiresAt !== undefined && tokens.expiresAt - REFRESH_MARGIN_MS <= now
}
