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
```

## CLI

`aparte` is also a coding agent for the terminal, built from library crates: `aparte-llm` (streaming client for
Anthropic Messages, OpenAI chat completions and Gemini), `aparte-tools` (read, write, edit, sandboxed bash, grep,
find, ls, git, web fetch), `aparte-agent` (tool trait, hooks, approvals, steering and follow-up queues, JSONL
sessions) and `aparte-tui` (inline terminal interface).

```sh
aparte                                  # terminal interface in the current project
aparte -p "explain src/main.rs"         # one prompt, answer on stdout
aparte --json -p "..."                  # one JSON event per line
aparte rpc                              # JSON lines over stdin and stdout
aparte models                           # providers, models and effort levels
aparte trust                            # trust this project (AGENTS.md, edits without asking)
aparte key set anthropic < key.txt      # store a key in the OS keychain
```

Keys come from the provider's variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`...) or the OS
keychain. `bash` runs under `sandbox-exec` on macOS or bubblewrap on Linux: writes stay inside the project, and the
network is closed unless `--allow-net`. Tool calls that write or run commands ask first; `--yes` approves them all.
`crates/aparte/examples` builds a custom tool and a custom agent from the crates.

## License

[MIT](LICENSE)
