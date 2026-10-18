/*
 * The device-only secrets of the MCP servers (McpSecrets in web/src/core/contracts/mcp.ts): one `oauth-token` local
 * record per server, under `mcp:<serverId>`, whose value is the UTF-8 JSON `{"kind": "mcp-auth", "server":
 * "<serverId>", "auth": <McpSecret>}` (spec/DATA-MODEL.md section 6), sealed by the vault's LocalStore. A secret is
 * never in plaintext at rest, never in a Yjs document and never logged.
 *
 * Invariants:
 * - What is stored can be sent: a token or header value has no control character and no surrounding space, a header
 *   name is an HTTP token and not one the browser or the transport sets itself.
 * - A record that authenticates but does not have this shape was not written by this module: TamperedError.
 */
import { InvalidInputError, TamperedError } from '../contracts/crypto.ts'
import type { McpSecret, McpSecrets, OAuthClient, OAuthTokens } from '../contracts/mcp.ts'
import type { LocalStore } from '../contracts/store.ts'

const PURPOSE = 'oauth-token'
const KIND = 'mcp-auth'
const TOKEN_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/
/** Headers a request may not choose (the browser's, the MCP transport's own, or CORS-forbidden ones). */
const RESERVED_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'host',
  'origin',
  'referer',
  'user-agent',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
])
const MAX_HEADERS = 16
const BAD_VALUE = /^\s|\s$|\p{Cc}/u

export const recordId = (serverId: string): string => `mcp:${serverId}`

function checkValue(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '' || value.length > 16384 || BAD_VALUE.test(value)) {
    throw new InvalidInputError(`${what} is empty, too long, or has surrounding spaces or control characters`)
  }
  return value
}

function checkHeaders(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidInputError('headers must be an object')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0 || entries.length > MAX_HEADERS) throw new InvalidInputError('1 to 16 headers')
  const out: Record<string, string> = {}
  for (const [name, v] of entries) {
    const lower = name.toLowerCase()
    if (
      !TOKEN_NAME.test(name) ||
      RESERVED_HEADERS.has(lower) ||
      lower.startsWith('sec-') ||
      lower.startsWith('proxy-')
    ) {
      throw new InvalidInputError(`The header name ${JSON.stringify(name.slice(0, 64))} cannot be sent`)
    }
    if (lower in out) throw new InvalidInputError('A header is repeated')
    out[lower] = checkValue(v, 'A header value')
  }
  return out
}

function optString(v: unknown): v is string | undefined {
  return v === undefined || typeof v === 'string'
}

function isClient(v: unknown): v is OAuthClient {
  if (v === null || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return (
    typeof c.clientId === 'string' &&
    optString(c.clientSecret) &&
    typeof c.tokenAuth === 'string' &&
    typeof c.issuer === 'string' &&
    typeof c.authorizationEndpoint === 'string' &&
    typeof c.tokenEndpoint === 'string' &&
    typeof c.issParameter === 'boolean' &&
    optString(c.resource) &&
    optString(c.scope) &&
    typeof c.redirectUri === 'string'
  )
}

function isTokens(v: unknown): v is OAuthTokens {
  if (v === null || typeof v !== 'object') return false
  const t = v as Record<string, unknown>
  return (
    typeof t.accessToken === 'string' &&
    typeof t.tokenType === 'string' &&
    optString(t.refreshToken) &&
    (t.expiresAt === undefined || Number.isSafeInteger(t.expiresAt)) &&
    optString(t.scope)
  )
}

/** The secret, checked for what a request can carry; InvalidInputError otherwise. */
export function checkSecret(secret: McpSecret): McpSecret {
  if (secret === null || typeof secret !== 'object') throw new InvalidInputError('A secret must be an object')
  switch (secret.kind) {
    case 'bearer':
      return { kind: 'bearer', token: checkValue(secret.token, 'The token') }
    case 'headers':
      return { kind: 'headers', headers: checkHeaders(secret.headers) }
    case 'oauth': {
      if (!isClient(secret.client)) throw new InvalidInputError('Malformed OAuth client')
      if (secret.tokens !== undefined) {
        if (!isTokens(secret.tokens)) throw new InvalidInputError('Malformed OAuth tokens')
        checkValue(secret.tokens.accessToken, 'The access token')
      }
      return secret.tokens === undefined
        ? { kind: 'oauth', client: secret.client }
        : { kind: 'oauth', client: secret.client, tokens: secret.tokens }
    }
    default:
      throw new InvalidInputError('Unknown secret kind')
  }
}

function parse(serverId: string, bytes: Uint8Array): McpSecret {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (cause) {
    throw new TamperedError('The MCP secret record is not JSON', { cause })
  }
  const record = value as { kind?: unknown; server?: unknown; auth?: unknown } | null
  if (record === null || typeof record !== 'object' || record.kind !== KIND || record.server !== serverId) {
    throw new TamperedError('The MCP secret record is not this server’s')
  }
  try {
    return checkSecret(record.auth as McpSecret)
  } catch (cause) {
    throw new TamperedError('The MCP secret record is malformed', { cause })
  }
}

export function createMcpSecrets(store: LocalStore): McpSecrets {
  return {
    async get(serverId) {
      const bytes = await store.get(PURPOSE, recordId(serverId))
      return bytes === null ? null : parse(serverId, bytes)
    },
    async set(serverId, secret) {
      const auth = checkSecret(secret)
      const json = JSON.stringify({ kind: KIND, server: serverId, auth })
      await store.put(PURPOSE, recordId(serverId), new TextEncoder().encode(json))
    },
    async delete(serverId) {
      await store.delete(PURPOSE, recordId(serverId))
    },
  }
}
