# spec

The shared definition of what Aparté stores, read by the web app (`web/`, the reference) and the CLI (`crates/`).

| Path | What it is |
|---|---|
| [FORMAT.md](FORMAT.md) | `aparte/1`: key schedule, keyslots, envelope, object names, payloads, anti-rollback, store layouts, local storage, what leaks, known limits. Frozen. |
| [DATA-MODEL.md](DATA-MODEL.md) | The encrypted documents: Yjs schema, index and conversation shards, the message tree, parts, blob references, provider replay rules, secrets. |
| [vectors/](vectors/README.md) | `inputs.json` (fixed inputs) and the vector files both implementations generate from it and must agree on byte for byte. |
| [fixtures/](fixtures/README.md) | `sync-v1`: a whole store written once by the reference (two devices, a photo, checkpoints) with the secrets that open it; both implementations read it back. |
| [sse/](sse/README.md) | Recorded provider streams (Anthropic, OpenAI-compatible, Gemini) and what the adapters must yield from them. |
| [kat/](kat/) | Published known answers for the primitives: RFC 5869, RFC 4231, RFC 9106 plus the Argon2 reference tests, Wycheproof AES-256-GCM. |
| [MCP-BRIDGE.md](MCP-BRIDGE.md) | `aparte mcp bridge` and `aparte mcp serve`: loopback Streamable HTTP endpoints, token, Host and Origin rules, CORS and Private Network Access, relay semantics, status codes, threat model. |
| [network-allowlist.json](network-allowlist.json) | Hosts the deployed app may contact, by network purpose. |

Once `aparte/1` is frozen, a change to any of these bytes needs a new format version and new fixtures; existing
vectors and fixtures are never edited.
