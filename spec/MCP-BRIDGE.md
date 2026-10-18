# MCP bridge and serve

The CLI exposes two loopback HTTP servers that speak the MCP Streamable HTTP transport:

- `aparte mcp bridge <name>...` relays MCP servers configured for the CLI (`<config>/mcp.json`, and the project's
  `.aparte/mcp.json` when the project is trusted) to the web app, which cannot start a stdio server and cannot reach
  an HTTP server that does not answer CORS.
- `aparte mcp serve` offers the CLI's own tools (`read`, `grep`, `find`, `ls`, `git`; with `--allow-write` also
  `write`, `edit`, `bash`, `web_fetch`) to MCP clients, run in the directory it was started in.

Both share the rules below; the implementation is `crates/aparte-mcp/src/{loopback,bridge,serve}.rs`.

## Endpoints

| Command | Default address | Endpoint |
|---|---|---|
| `aparte mcp bridge <name>...` | `http://127.0.0.1:27181` | `/mcp/<name>`, one per server named on the command line |
| `aparte mcp serve` | `http://127.0.0.1:27182` | `/mcp` |

- The servers listen on `127.0.0.1` only; there is no option to listen elsewhere. `--port` changes the port (`0`
  picks a free one). If the port is taken, the command fails; it never falls back to another port.
- Only the servers named on the bridge's command line are reachable. A server of an untrusted project, a disabled
  server or an unknown name is refused when the bridge starts.
- On start, the command prints the URLs on stdout (`--json`: one event, `mcp-bridge` with `servers[].url`, or
  `mcp-serve` with `url` and `tools`) and the token on stderr.

## Token

- A new token is 256 bits from the OS random generator, shown once on stderr as 13 groups of 4 lowercase base32
  characters (RFC 4648 alphabet `a-z2-7`) joined by dashes, for example the shape
  `xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx-xxxx`. The 52 characters encode the 32 bytes; the 4
  bits past the 256 are zero.
- The user types or pastes it into the client. It is never printed on stdout, never put in a URL, never logged.
- For scripted use, `--token-file <file>` reads a fixed token from a file (it should be mode 0600), else the
  environment variable `APARTE_MCP_TOKEN` is read. `aparte mcp token` prints a new one for that purpose. A token
  given this way is not shown.
- Clients send `Authorization: Bearer <token>` on every request except the CORS preflight. The server ignores case,
  dashes and spaces in the token, and compares the 32 bytes in constant time.
- The web app keeps the token like its other secrets (encrypted at rest, never in the synced documents).

## Request rules

Checked in this order, before any MCP processing or any upstream contact:

1. `Host` must be `127.0.0.1:<port>` or `localhost:<port>`, with the port listened on (and an absolute-form request
   target must name the same). Otherwise **421**.
2. `Origin`, when present, must be one of:
   - `https://maxgfr.github.io` (the web app),
   - `http://localhost` or `http://localhost:<port>`, any port (a development or preview server),
   - `http://127.0.0.1` or `http://127.0.0.1:<port>`, any port (the same servers opened by address).

   Any other origin, `null` included, is **403**, with no CORS headers. A request without `Origin` (a native MCP
   client) passes this rule.
3. The request target has no query: a URL with `?` is **400**, so a token is never accepted from a URL.
4. `OPTIONS` (a CORS preflight) from an allowed origin is answered **204** without a token (see CORS).
5. `Authorization: Bearer <token>` must hold the token. Otherwise **401** with
   `WWW-Authenticate: Bearer realm="aparte", error="invalid_token"`.
6. A body larger than 4 MiB is **413**; a `POST` whose `Content-Type` is not `application/json` is **415**.

At most 16 connections are open at once (more are closed), request headers must arrive within 10 seconds, and a
request may take 15 minutes (approvals included) before **504**.

## CORS and Private Network Access

For an allowed origin, every response (refusals after rule 2 included, so a page can read a 401) carries:

- `Access-Control-Allow-Origin: <the request's origin>`, `Vary: Origin`,
- `Access-Control-Expose-Headers: mcp-session-id`.

A preflight is answered with:

- `Access-Control-Allow-Methods: POST, GET, DELETE, OPTIONS`,
- `Access-Control-Allow-Headers: authorization, content-type, accept, mcp-session-id, mcp-protocol-version,
  last-event-id`,
- `Access-Control-Max-Age: 600`,
- `Access-Control-Allow-Private-Network: true` when the preflight carries
  `Access-Control-Request-Private-Network: true` (Chrome's Private Network Access).

`Access-Control-Allow-Credentials` is never sent: the client fetches with `credentials: "omit"` and sets the
`Authorization` header itself. Chrome's Local Network Access asks the user for permission before a public page may
reach the loopback; that permission is the browser's and the bridge cannot grant it. Browsers that do not treat
`http://127.0.0.1` as a potentially trustworthy origin block the request as mixed content.

## JSON-RPC relay

Each `POST` carries one JSON-RPC 2.0 message. Batches (arrays) are **400**.

| Message | Answer |
|---|---|
| request (`method` and `id`) | **200**, `Content-Type: application/json`, the response with the same `id` |
| notification (`method`, no `id`) | **202**, empty body |
| response (`id` and `result` or `error`) | **202**, empty body |

Responses are always JSON, never an SSE stream. `GET` (the server-to-client stream) and methods other than `POST`,
`DELETE` and `OPTIONS` are **405** with an `Allow` header; clients fall back to POST-only operation.

### Sessions

- `initialize` opens a session; its response carries `Mcp-Session-Id`. Every later message of that session must
  carry the header: without it **400**, with an unknown or ended one **404** (initialize again).
- `DELETE` with `Mcp-Session-Id` ends the session: **204**, or **404** if it is unknown.
- `MCP-Protocol-Version` is passed through by the bridge unchecked. `aparte mcp serve` accepts `2025-11-25`,
  `2025-06-18`, `2025-03-26` and `2024-11-05` (another value is **400**) and answers `initialize` with the version
  asked for when it knows it, else `2025-11-25`.

### Bridged stdio servers

- `initialize` starts a new copy of the server (its environment rebuilt from an allowlist plus the entry's `env`,
  its own process group) and the session id is the bridge's (128 random bits, hex). Up to 4 copies of one server run
  at once; a new session ends the least recently used one, and sessions idle for an hour end when another starts.
  Ending a session kills the server's process group; stopping the bridge (Ctrl-C, SIGTERM) ends them all.
- A request is written to the server's stdin as one line, and the response with the same `id` is returned. Two
  pending requests of a session with the same `id` are refused (**400**).
- Requests the server sends on its own (sampling, roots, elicitation) are answered by the bridge with error
  `-32601`; `ping` is answered with an empty result. Notifications from the server are dropped.

### Bridged HTTP servers

- Each message is posted to the configured URL (https, or http on the loopback) with the configured headers, the
  configured `Authorization` or else the OAuth token stored by `aparte mcp login <name>`, and the client's
  `Mcp-Session-Id` and `MCP-Protocol-Version`. The bridge token is never forwarded. Redirects are not followed.
- The server's `Mcp-Session-Id` is returned unchanged: the session is the server's.
- A JSON answer is relayed with its status (2xx and 4xx); an SSE answer is read until the response with the
  request's `id`, which is returned as JSON. Requests the server sends in that stream are answered as for stdio.

## Errors

Refusals by the rules above, and failures of the bridge, have a JSON-RPC error body:

```json
{"jsonrpc": "2.0", "id": null, "error": {"code": -32001, "message": "a valid token is needed: ..."}}
```

| Status | When | `error.code` |
|---|---|---|
| 400 | bad JSON, batch, query in the URL, missing session id, bad protocol version | `-32600` |
| 401 | missing or wrong token | `-32001` |
| 403 | origin not allowed | `-32000` |
| 404 | unknown path or server, unknown or ended session | `-32601` |
| 405 | `GET` or another method | `-32000` |
| 413 | body over 4 MiB | `-32600` |
| 415 | `POST` that is not `application/json` | `-32600` |
| 421 | `Host` not allowed | `-32000` |
| 502 | the server could not start, exited, is unreachable, or asks for a login (`aparte mcp login <name>`) | `-32603` (`-32001` for a login) |
| 504 | the server did not answer in time (30 s for `initialize`, 300 s otherwise) | `-32603` |

502 and 504 errors carry the `id` of the request when there is one. A server that asks the bridge for authorization is reported as
502, never as 401: a 401 always means the bridge token is wrong. Errors of the MCP methods themselves (unknown
method, unknown tool, a failing tool) are ordinary JSON-RPC responses with status 200.

## `aparte mcp serve`

- Without `--allow-write`, only tools that are read-only and closed-world are listed and callable (`read`, `grep`,
  `find`, `ls`, `git` restricted to read-only subcommands).
- With `--allow-write`, the other tools are listed with their annotations (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`), and every call of one is approved in the terminal (`y` to allow, anything
  else denies), one question at a time. Without a terminal on stdin, these calls are denied; `--yes` approves them
  all. A denied call returns a tool result with `isError: true`. `bash` runs under the OS sandbox, without network.
- A `path` argument must resolve inside the served directory (symbolic links followed); `~` paths are refused.
- Each call is logged on stderr (and as an `mcp-call` event with `--json`): tool, a 120-character summary of the
  input with control characters replaced, outcome, duration.
- The bridge logs each relayed message the same way (`mcp-relay`): server, method, tool name of a `tools/call`,
  status. Neither logs bodies, URLs or the token.

## Threat model

- **A shared origin.** The web app lives on `https://maxgfr.github.io`, an origin shared by every project page of
  that GitHub account. Any page of that origin, and any page served from `localhost` or `127.0.0.1`, passes the
  Origin rule. The token is what keeps them out: it is typed by the user into the app, never sent by the CLI to the
  browser, never in a URL a page could read from history or `Referer`.
- **Other web pages.** A page from any other origin is refused (403) before the token is even checked, and gets no
  CORS headers, so it can neither call the server nor read an answer. Simple requests a browser sends without a
  preflight still carry the page's `Origin` and are refused the same way.
- **DNS rebinding.** A hostile name rebound to `127.0.0.1` makes the browser send its own name in `Host` (and its own
  origin in `Origin`): refused with 421.
- **Other local processes and users.** Anything on the machine can open a connection to the loopback port; without
  the token it gets 401 and nothing runs. The token is 256 bits and compared in constant time; there is no lockout
  because guessing is not feasible. A process that takes the port first could pose as the bridge and collect a token
  typed into the app: the bridge refuses to start on a taken port, so a successful start (and its printed URL) is
  the user's check.
- **What a token holder can do.** With the bridge: whatever the bridged servers allow, as the user, with their
  configured credentials; nothing else is reachable. With `serve`: read files under the served directory, and with
  `--allow-write` ask for writes, commands and network access, each approved by the user in the terminal.
- **Out of scope.** Malware running as the user can read the terminal, the token file or the CLI's configuration;
  the loopback rules do not defend against it.
