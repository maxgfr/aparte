# Aparté

Private AI chat that runs entirely in your browser. Bring your own keys or run models on the device; conversations
and photos are encrypted on the device and synced end-to-end to storage you own. No account, no server.

- App: <https://maxgfr.github.io/aparte/>
- Interface language: English.
- Format: `aparte/1` is frozen ([spec/FORMAT.md](spec/FORMAT.md)): any change to it needs a new format version.
- Sync: a GitHub repository, an S3-compatible bucket, a local folder, or an archive (`.aparte.zip`). Only encrypted
  objects and the keyslots leave the device; a sync credential stays on the device that uses it.

## Development

The web app lives in `web/` (Bun, Vite, React) and the CLI in `crates/` (Rust).

```sh
cd web && bun install && bun run dev      # http://localhost:5173/aparte/
cd web && bun run check                   # types, lint, tests, build, security scan, size budget
scripts/check.sh                          # Rust: fmt, clippy, tests, cargo deny
scripts/check-vectors.sh                  # aparte/1 vectors and fixtures, TypeScript against Rust
scripts/check-interop.sh                  # the web app's sync code and the CLI sync one vault through Git
```

## CLI

`aparte` is also a coding agent for the terminal, built from library crates: `aparte-llm` (streaming client for
Anthropic Messages, OpenAI Responses, OpenAI chat completions and Gemini), `aparte-tools` (read, write, edit,
sandboxed bash, grep, find, ls, git, web fetch), `aparte-agent` (tool trait, hooks, approvals, steering and
follow-up queues, JSONL sessions), `aparte-skills` (`SKILL.md` skills), `aparte-mcp` (MCP client) and `aparte-tui`
(inline terminal interface), `aparte-store` (the encrypted device store and the vault) and `aparte-sync` (the Yjs
documents through `yrs`, the sync engine, and the folder, Git, GitHub and S3 stores).

```sh
aparte                                  # terminal interface in the current project
aparte -p "explain src/main.rs"         # one prompt, answer on stdout
aparte --json -p "..."                  # one JSON event per line
aparte rpc                              # JSON lines over stdin and stdout
aparte models                           # providers, models and effort levels
aparte trust                            # trust this project (AGENTS.md, edits without asking)
aparte key set anthropic < key.txt      # store a key in the OS keychain
aparte skills list                      # skills found, and whether the model is offered each
aparte mcp add files -- npx -y @modelcontextprotocol/server-filesystem .
aparte mcp add docs https://example.com/mcp && aparte mcp login docs
aparte mcp tools                        # start the servers, list their tools and approval state
aparte mcp bridge files                 # let the web app reach a stdio server, over 127.0.0.1 with a token
aparte mcp serve                        # offer the CLI's read-only tools to MCP clients
aparte vault create                     # a new vault; the Emergency Kit is shown once
aparte vault join github owner/repo     # take the vault the web app syncs there (or folder, git, s3)
aparte sync setup git git@host:me/vault.git && aparte sync now
aparte sessions list                    # the vault's conversations, from the CLI and the web app
aparte --session <id>                   # continue one of them here
```

Keys come from the provider's variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`...) or the OS
keychain. `bash` runs under `sandbox-exec` on macOS or bubblewrap on Linux: writes stay inside the project, and the
network is closed unless `--allow-net`. Tool calls that write or run commands ask first; `--yes` approves them all.
`crates/aparte/examples` builds a custom tool and a custom agent from the crates.

Skills are directories with a `SKILL.md`, found in `.agents/skills` from the working directory up, then in
`~/.agents/skills` and `.claude/skills` (where `npx skills add` installs them). The model sees each skill's name and
description, loads the instructions with the `skill` tool when a task matches, and runs a skill's scripts through
`bash`, so under the sandbox and with approval. `/skill:<name> ...` runs one by hand. A project's own skills, like its
`AGENTS.md`, are offered only once the project is trusted.

MCP servers are configured in `~/.config/aparte/mcp.json` with the `mcpServers` shape of Claude and Cursor (a
project's `.aparte/mcp.json` is read only when the project is trusted). Stdio servers run in their own process group
with a filtered environment and are killed with it; HTTP servers use Streamable HTTP and OAuth 2.1 with PKCE, their
tokens encrypted under a key kept in the OS keychain. MCP annotations drive approvals (only read-only, closed-world
tools run without asking), and every tool definition is pinned by fingerprint: a tool that changes later is held back
until `aparte mcp tools <server> --approve`. `aparte mcp bridge` and `aparte mcp serve` listen on `127.0.0.1` only and
ask for a 256-bit token typed into the client, never put in a URL ([spec/MCP-BRIDGE.md](spec/MCP-BRIDGE.md)).

The CLI opens the same vault as the web app: the same keyslots (a passphrase with the Secret Key of the Emergency
Kit, or the recovery key), the same encrypted objects, the same anti-rollback checks. Its store is
`~/.local/share/aparte/vault`, ciphertext only, files 0600; the Secret Key is kept in the OS keychain (unless `--no-keychain`),
never in a file. Once a vault exists, chats are recorded in it as conversations (append-only branches, reasoning
signatures kept) and show in the web app after a sync; `--no-save` skips that. A Git destination is any remote
`git` can reach, written in the layout of the web app's GitHub store, so both can sync through one repository.

## License

[MIT](LICENSE)
