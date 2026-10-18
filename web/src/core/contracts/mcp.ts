/*
 * Contract of the MCP client (milestone M5b): the servers the user adds, their device-only secrets, the OAuth 2.1
 * sign-in that obtains them, and the manager that connects to the servers and plugs their tools into the tool
 * registry (contracts/tools.ts, F6). Implemented by web/src/core/mcp/*.ts:
 *
 *   mapping.ts   prefixFor, registryName, toToolSpec, toToolResult      (how an MCP tool becomes a registry tool)
 *   fetch.ts     createMcpFetch                                        (net.ts with purpose `mcp`, size caps)
 *   oauth.ts     discovery, dynamic client registration, PKCE, tokens (RFC 9728, 8414, 7591, 7636, 8707, 9207)
 *   callback.ts  channelNameFor, parseCallback, awaitCallback          (the popup's answer, over a BroadcastChannel)
 *   secrets.ts   createMcpSecrets                                      (the `oauth-token` local records)
 *   manager.ts   createMcpManager                                      (connections, tools, sign-in, drift)
 *
 * Invariants:
 * - A server's configuration (name, address, transport, kind of authentication, which of its tools are on and the
 *   fingerprint the user accepted for each) is synced in the workspace index (`mcp` map, spec/DATA-MODEL.md section
 *   3.5). Its secrets (a bearer token, headers, the OAuth client and tokens) are device-only `oauth-token` local
 *   records (spec/DATA-MODEL.md section 6): never in a Yjs document, never logged, never sent but to that server and
 *   its authorization server.
 * - Every request goes through web/src/security/net.ts with purpose `mcp`: HTTPS, or HTTP on the loopback only, no
 *   cookies, no referrer. Responses are read up to a size cap, and what a tool returns to the model is capped again.
 * - A tool is offered (registered) only when the user turned it on and its live definition has the fingerprint the
 *   user accepted. A changed definition is held back and shown as changed until the user accepts it again: what the
 *   model reads never changes behind the user's back. A new tool of a known server starts off.
 * - MCP tools always ask before running (contracts/tools.ts): their annotations are the server's claim and only
 *   decide what the approval card says.
 * - The OAuth sign-in is a popup on the authorization server that comes back to `oauth-callback.html`, which only
 *   relays `code`, `state`, `iss` and `error` on the BroadcastChannel named after the flow's random `state`. The
 *   manager accepts one answer per flow, with the flow's state; the PKCE verifier and the state stay in memory.
 */

import type { Id } from './workspace.ts'

// Configuration (synced)

/** `http`: Streamable HTTP; `sse`: the legacy HTTP+SSE transport (protocol 2024-11-05). */
export type McpTransportKind = 'http' | 'sse'

/** How the app authenticates to the server; the secret itself is device-only. */
export type McpAuthKind = 'none' | 'oauth' | 'bearer' | 'headers'

/** The user's choice for one tool of a server, by its MCP name. */
export interface McpToolChoice {
  /** The tool's name on the server. */
  readonly name: string
  readonly enabled: boolean
  /** contracts/tools.ts fingerprint of the definition the user accepted. */
  readonly fingerprint: string
}

export interface McpServerConfig {
  readonly id: Id
  /** What the interface calls it. */
  readonly name: string
  /**
   * `^[a-z][a-z0-9]{0,15}$`, unique among servers, fixed at creation: the tools of the server are registered as
   * `<prefix>__<tool>`, so renaming the server never changes what the model reads.
   */
  readonly prefix: string
  readonly transport: McpTransportKind
  /** The endpoint: https (http on the loopback only), no credentials, query or fragment. */
  readonly url: string
  readonly auth: McpAuthKind
  /** Off: never contacted, no tool offered. */
  readonly enabled: boolean
  /** The choices made so far, by tool name; a tool absent here is new. */
  readonly tools: readonly McpToolChoice[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly deletedAt?: number
}

export interface NewMcpServer {
  readonly name: string
  readonly prefix: string
  readonly transport: McpTransportKind
  readonly url: string
  readonly auth: McpAuthKind
  readonly enabled?: boolean
}

export type McpServerPatch = {
  readonly [K in 'name' | 'transport' | 'url' | 'auth' | 'enabled' | 'tools']?: McpServerConfig[K]
}

/** The `mcp` map of the workspace index. */
export interface McpServers {
  /** Not trashed, by name then id. */
  list(): readonly McpServerConfig[]
  get(id: Id): McpServerConfig | undefined
  /**
   * InvalidInputError for a malformed field, a prefix already taken, a URL that is not https (or loopback http) or
   * carries credentials, a query or a fragment, or anything that looks like a secret.
   */
  create(input: NewMcpServer): Id
  update(id: Id, patch: McpServerPatch): void
  trash(id: Id): void
}

// Secrets (device-only)

export interface OAuthTokens {
  readonly accessToken: string
  /** `Bearer` (any other type is refused). */
  readonly tokenType: string
  readonly refreshToken?: string
  /** Unix milliseconds. */
  readonly expiresAt?: number
  readonly scope?: string
}

/** The client the app registered (or was given) at one authorization server, and that server's endpoints. */
export interface OAuthClient {
  readonly clientId: string
  readonly clientSecret?: string
  /** `none`, `client_secret_post` or `client_secret_basic`. */
  readonly tokenAuth: string
  readonly issuer: string
  readonly authorizationEndpoint: string
  readonly tokenEndpoint: string
  /** RFC 9207: the authorization response carries `iss`, which must then be the issuer. */
  readonly issParameter: boolean
  /** RFC 8707 resource indicator sent with every request, when the server published protected resource metadata. */
  readonly resource?: string
  readonly scope?: string
  readonly redirectUri: string
}

export type McpSecret =
  | { readonly kind: 'bearer'; readonly token: string }
  | { readonly kind: 'headers'; readonly headers: Readonly<Record<string, string>> }
  | { readonly kind: 'oauth'; readonly client: OAuthClient; readonly tokens?: OAuthTokens }

/** The `oauth-token` local records of the MCP servers, under `mcp:<serverId>`. */
export interface McpSecrets {
  get(serverId: Id): Promise<McpSecret | null>
  /** InvalidInputError for a malformed secret (an empty token, a header name or value a request cannot carry). */
  set(serverId: Id, secret: McpSecret): Promise<void>
  delete(serverId: Id): Promise<void>
}

// Connection state (memory only)

/** Why a server could not be used. */
export type McpProblem =
  /** The server answered no-cors probes but not the app's requests: it does not allow this origin (CORS). */
  | { readonly kind: 'cors' }
  /** Nothing answered: the address is wrong or the server is down. */
  | { readonly kind: 'unreachable' }
  /** The address is not one the app may contact (net.ts refused it). */
  | { readonly kind: 'insecure' }
  /** 401 or 403 with the configured token or headers, or a sign-in that failed. */
  | { readonly kind: 'auth'; readonly status?: number; readonly detail?: string }
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'timeout' }
  /** The server answered but not as an MCP server of this transport. */
  | { readonly kind: 'protocol'; readonly detail: string }

/**
 * How a tool of a server stands: `on` (offered to chats), `off` (turned off), `new` (never reviewed, off), `changed`
 * (its definition differs from the one accepted: held back), `invalid` (it cannot be offered: a schema that is not an
 * object, a name clash).
 */
export type McpToolState = 'on' | 'off' | 'new' | 'changed' | 'invalid'

export interface McpToolView {
  /** The tool's name on the server. */
  readonly name: string
  /** The name chats and the model know it by. */
  readonly registryName: string
  readonly title: string
  /** What the model reads; untrusted text from the server, shown as text. */
  readonly description: string
  readonly annotations: { readonly readOnly: boolean; readonly destructive: boolean; readonly openWorld: boolean }
  readonly fingerprint: string
  readonly state: McpToolState
}

export type McpSignIn = 'preparing' | 'ready' | 'waiting' | 'failed'

export type McpStatus =
  | { readonly state: 'off' }
  | { readonly state: 'connecting' }
  | {
      readonly state: 'connected'
      readonly tools: readonly McpToolView[]
      /** The name and version the server reported. */
      readonly server: string
    }
  /** OAuth: the user must sign in; `signIn` says whether the popup can open. */
  | { readonly state: 'needs-auth'; readonly signIn: McpSignIn; readonly problem?: McpProblem }
  | { readonly state: 'error'; readonly problem: McpProblem }

export interface McpManager {
  /** The state of a server (`off` for an unknown or disabled one). */
  status(serverId: Id): McpStatus
  /** Calls `fn` on every status change; returns the unsubscribe function. */
  subscribe(fn: () => void): () => void
  /** (Re)connects and lists the tools; resolves with the new status. The connection test of the settings. */
  connect(serverId: Id): Promise<McpStatus>
  /** Turns a tool on or off (stored in the configuration). Turning on accepts its current definition. */
  setToolEnabled(serverId: Id, name: string, enabled: boolean): void
  /** Accepts the current definition of a changed tool and turns it on. */
  acceptTool(serverId: Id, name: string): void
  /**
   * The authorization URL of the prepared sign-in, available synchronously so the popup opens in the click that asks
   * for it; null unless the status is `needs-auth` with `signIn: 'ready'`.
   */
  signInUrl(serverId: Id): string | null
  /**
   * Waits for the popup's answer on the flow's channel, exchanges the code and reconnects. Call it before opening the
   * popup. Resolves with the new status; a cancelled, refused or timed-out flow leaves `needs-auth` with a new flow.
   */
  completeSignIn(serverId: Id): Promise<McpStatus>
  cancelSignIn(serverId: Id): void
  /** Forgets the tokens of an OAuth server (the registered client is kept). */
  signOut(serverId: Id): Promise<void>
  /** Closes every connection and unregisters every MCP tool. Idempotent. */
  dispose(): Promise<void>
}
