# The CLI

`aparte` is a coding agent for the terminal and the command-line companion of the web app: it opens the same vault,
syncs through the same stores, records its chats as conversations the web app shows, and can relay MCP servers to the
web app.

## Install

```sh
brew install maxgfr/tap/aparte
```

Release binaries exist for macOS (Apple silicon and Intel) and Linux (x86_64 and arm64, glibc 2.35 or later); there is
no Windows build. Each release carries `aparte-<target>` binaries, a `SHA256SUMS` file and a build provenance
attestation, so a downloaded binary can be checked:

```sh
sha256sum -c --ignore-missing SHA256SUMS
gh attestation verify aparte-aarch64-apple-darwin --repo maxgfr/aparte
```

From source, with the Rust toolchain of `rust-toolchain.toml`: `cargo build --release --locked -p aparte` builds
`target/release/aparte`. `aparte selftest` checks a binary offline; `aparte doctor` prints what it found on the
machine and the directories it uses.

## Chatting

```sh
aparte                                  # terminal interface in the current directory (needs a TTY)
aparte -p "explain src/main.rs"         # one prompt, the answer on stdout ("-" reads the prompt from stdin)
aparte --json -p "..."                  # one JSON event per line on stdout, human text on stderr
aparte models [--remote]                # providers, models and effort levels (--remote asks the provider)
aparte --session <id>                   # continue a conversation of the vault, from the CLI or the web app
```

Options for the agent (the bare command, `-p` and `rpc`): `--provider` (`anthropic` by default; `openai`, `google`,
`groq`, `deepseek`, `xai`, `mistral`, `openrouter`, `ollama`, `lmstudio`), `-m/--model`, `--base-url` (`https`, or
`http` on the loopback), `--effort` (`none` to `max`), `--max-turns` (50), `--max-output-tokens`, `--system`,
`--append-system`, `--tools read,write,edit,bash,grep,find,ls,git,web_fetch,skill` or `--no-tools`, `--no-skills`,
`--no-mcp`, `-y/--yes` (approve every tool call), `--allow-net`, `--no-sandbox`, `--resume`/`--export` (JSONL files),
`--session`, `--branch-from`, `--no-save`. The base URL is used as given: for `anthropic` it includes the version
(`https://api.example.com/v1`, the CLI calls `<base>/messages`), where the web app accepts it with or without `/v1`.
Every command takes `-v/--verbose` (repeat it for more logs) and `-q/--quiet`; `aparte completions <shell>` prints the
shell completions.

Keys come from the provider's variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` or `GOOGLE_API_KEY`,
`GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`), else the OS keychain:

```sh
aparte key set anthropic < key.txt      # read from stdin, kept in the keychain (service "aparte")
aparte key status                       # where each provider's key comes from
aparte key delete anthropic
```

The keychain is the macOS keychain (`/usr/bin/security`) or the Secret Service on Linux (`secret-tool`); secrets are
passed on stdin, never on a command line. `APARTE_NO_KEYCHAIN=1` turns it off.

### Tools, approvals and the sandbox

The tools are `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `git`, `web_fetch` and `skill`. Read-only,
closed-world tools run without asking; the rest ask in the terminal (`y` yes, `a` always for this tool, `n` or Esc
no). In print mode, calls that would ask are denied unless `--yes`.

`bash` runs under `sandbox-exec` on macOS or bubblewrap (`bwrap`) on Linux: writes are allowed only in the project
directory and a private temporary directory, the network is closed unless `--allow-net`, and the environment is
reduced to a few variables. Without a sandbox, `bash` refuses to run unless `--no-sandbox`.

### Trusted projects

```sh
aparte trust [PATH] [--revoke] [--list]
```

A project's `AGENTS.md` files, its skills and its `.aparte/mcp.json` are used only once the project is trusted; in a
trusted project, tools that are read-only or not destructive run without asking. Decisions are kept in
`<config>/trust.json`.

### Skills

A skill is a directory with a `SKILL.md`, found in `.agents/skills` and `.claude/skills` from the working directory up,
then in `~/.agents/skills` and `~/.claude/skills`; the first of a name wins. The model sees each skill's name and
description and loads it with the `skill` tool; `/skill:<name> ...` runs one by hand.

```sh
aparte skills list [--all] | show <name> | path
```

Skills installed with [`npx skills add`](https://github.com/vercel-labs/skills) are found where it puts them
(`.agents/skills/<name>` in a project, `~/.agents/skills/<name>` with `-g`); the links it makes in `.claude/skills` are
followed, and a skill reached twice is listed once. Only the name and description of each skill are in the system
prompt (`<available_skills>`); the `skill` tool returns the instructions, with the skill's base directory filled in
for `<skill-dir>`, `{baseDir}` and `${CLAUDE_SKILL_DIR}`, and with `path` one file of the skill, such as a reference.
Nothing in a skill runs by itself: its scripts go through `bash`, so each command is approved and sandboxed. A skill
with `disable-model-invocation: true` is only run by hand, and `allowed-tools` approves nothing.

For example, [ultrasearch](https://github.com/maxgfr/ultrasearch), whose engine is a Node script that searches and
fetches the web, needs Node and the network:

```sh
npx skills add maxgfr/ultrasearch       # into .agents/skills/ultrasearch
aparte trust                            # project skills are offered once the project is trusted
aparte --allow-net                      # then ask for an ultrasearch report and approve its `node` commands
```

Its run directories go under the private temporary directory of `bash`, which is removed when the session ends;
ask for `--out` in the project to keep a dossier.

## The vault and sync

```sh
aparte vault create [--no-secret-key] [--no-recovery-key] [--no-keychain]   # the Emergency Kit is shown once
aparte vault join github owner/repo     # or folder <path>, git <url>, s3 --endpoint ... --bucket ...
aparte vault status | unlock-test | change-passphrase
aparte sync setup git git@host:me/vault.git && aparte sync now
aparte sync status | remove <id> | dismiss <alarm id>
aparte sessions list | show <id> | export <id> [-o FILE]
```

The CLI opens the vault the web app uses: the same keyslots, objects and anti-rollback checks. It unlocks with the
passphrase and the Secret Key; the passphrase comes from `APARTE_PASSPHRASE` or a prompt (`APARTE_NEW_PASSPHRASE`
for `vault create` and `change-passphrase`), the Secret Key from the keychain (`secret-key:<vault id>`),
`APARTE_SECRET_KEY` or a prompt. The vault lives in `~/.local/share/aparte/vault` (files 0600, directories 0700),
ciphertext only. Once a vault exists, chats are recorded in it as conversations (`--no-save` skips that). Destinations
and their credentials are encrypted local records, never synced. See [docs/sync.md](sync.md#cli).

## Directories and variables

| | Default | Override |
|---|---|---|
| Configuration (`mcp.json`, `trust.json`, MCP pins and tokens) | `$XDG_CONFIG_HOME/aparte` or `~/.config/aparte` | `--config-dir`, `APARTE_CONFIG_DIR` |
| Data (the vault) | `$XDG_DATA_HOME/aparte` or `~/.local/share/aparte` | `--data-dir`, `APARTE_DATA_DIR` |

Other variables: `APARTE_PROVIDER`, `APARTE_MODEL`, `APARTE_BASE_URL`, `APARTE_LOG`, `APARTE_GITHUB_TOKEN`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `APARTE_MCP_TOKEN`, `NO_COLOR`.

Exit codes: 0 success, 1 error, 2 usage, 3 network, 4 integrity, 5 locked, 6 format, 7 cancelled, 8 authentication,
9 refused.

## `aparte rpc`

`aparte rpc` serves the agent over stdin and stdout, one JSON object per line, for editors and scripts. It takes the
agent options above. Logs go to stderr.

Commands are objects with a `type`; `id` is optional and echoed back. Field names are camelCase.

| `type` | Fields | |
|---|---|---|
| `prompt` | `message` | starts a run; refused while one runs |
| `steer` | `message` | delivered after the current batch of tool calls |
| `follow_up` | `message` | delivered when the run would stop |
| `abort` | | stops the run |
| `approve` | `callId`, `decision` (`allow`, `allow-always`, `deny`), `reason`? | answers an `approval-request` |
| `get_messages`, `get_tools`, `get_skills`, `get_mcp` | | |
| `set_model` | `model` | |
| `set_effort` | `effort` (or `null`) | |
| `export` | `path` | writes the session as JSONL |
| `quit` | | ends after the current run |

Every line out has an `event`:

- `ready` (`provider`, `model`, `skills`, `mcpServers`), once at start;
- `response` (`command`, `success`, `id`, and `error`, `messages`, `tools`, `skills` or `servers`) for each command;
  a line that is not JSON gets `command: "parse"`;
- `approval-request` (`callId`, `tool`, `input`, `annotations`); if the client goes away, the call is denied;
- the agent's events: `agent-start`, `turn-start`, `text-delta`, `reasoning-delta`, `tool-call-start`, `source`,
  `message-end`, `tool-start`, `tool-end`, `usage`, `turn-end`, `steer`, `follow-up`, `refusal`, `error`, and
  `agent-end` (`reason`: `done`, `max-turns`, `aborted`, `error`, `refusal` or `stopped`), sent once the agent can
  take the next prompt.

```text
< {"event":"ready","provider":"anthropic","model":"...","skills":[],"mcpServers":[]}
> {"type":"prompt","message":"What is the capital of France?","id":1}
< {"event":"response","command":"prompt","success":true,"id":1}
< {"event":"text-delta","text":"Paris"}
< {"event":"agent-end","reason":"done","usage":{...}}
> {"type":"quit"}
```

End of input aborts a running prompt and exits.

## MCP

Servers are configured in `<config>/mcp.json` in the `mcpServers` shape of Claude and Cursor; a project's
`.aparte/mcp.json` is read only when the project is trusted.

```sh
aparte mcp add files -- npx -y @modelcontextprotocol/server-filesystem .     # a stdio server
aparte mcp add docs https://example.com/mcp && aparte mcp login docs        # Streamable HTTP with OAuth 2.1 and PKCE
aparte mcp list | remove <name> | logout <name>
aparte mcp tools [name] [--approve]     # start the servers, list their tools and approval state
```

`add` takes `-e KEY=VALUE`, `-H "Header: value"`, `--client-id`, `--scopes`, `--project`. Stdio servers run in their
own process group with a filtered environment. OAuth tokens are encrypted under a key kept in the keychain. Every tool
definition is pinned by fingerprint: a tool whose definition changes is held back until
`aparte mcp tools <server> --approve`. Annotations drive approvals: only read-only, closed-world tools run without
asking.

### `aparte mcp bridge`: MCP servers for the web app

The web app cannot start a stdio server, nor reach an HTTP server that does not answer CORS. The bridge relays servers
configured for the CLI:

```sh
aparte mcp bridge files [more names...] [--port 27181] [--token-file FILE]
```

It listens on `http://127.0.0.1:27181` only, with one endpoint per server named on the command line,
`/mcp/<name>`, and prints a 256-bit token once on stderr (13 groups of 4 base32 characters). In the web app, add an MCP
server with that address (for example `http://127.0.0.1:27181/mcp/files`) and the **Token** authentication, and paste
the token. Ctrl-C stops it.

### `aparte mcp serve`: the CLI's tools for MCP clients

```sh
aparte mcp serve [--port 27182] [--allow-write] [--yes] [--token-file FILE]
```

It offers `read`, `grep`, `find`, `ls` and a read-only `git` over the directory it was started in, at
`http://127.0.0.1:27182/mcp`. `--allow-write` adds `write`, `edit`, `bash` (sandboxed, without network) and
`web_fetch`, each call approved in the terminal (`--yes` approves them all; without a terminal they are denied).

### What both enforce

The full rules are in [spec/MCP-BRIDGE.md](../spec/MCP-BRIDGE.md). In order, before anything reaches a server:

1. `Host` must be `127.0.0.1:<port>` or `localhost:<port>` (else 421), which stops DNS rebinding.
2. `Origin`, when sent, must be `https://maxgfr.github.io`, or `http://localhost` or `http://127.0.0.1` on any port
   (else 403). A native client sends none. A self-hosted copy of the web app on another origin cannot use the bridge.
3. A URL with a query is refused (400): the token is never accepted from a URL.
4. A CORS preflight is answered without the token; every other request needs `Authorization: Bearer <token>` (else
   401), compared in constant time.
5. Bodies are limited to 4 MiB and must be JSON.

`aparte mcp token` prints a new token for `--token-file` (keep the file mode 0600) or `APARTE_MCP_TOKEN`; a token given
that way is not printed.

## Building on the crates

The CLI is built from library crates: `aparte-llm` (streaming client for Anthropic Messages, OpenAI Responses, OpenAI
chat completions and Gemini), `aparte-tools`, `aparte-agent` (tool trait, hooks, approvals, steering and follow-up
queues, JSONL sessions), `aparte-skills`, `aparte-mcp`, `aparte-tui`, `aparte-store` (the encrypted device store and the
vault), `aparte-sync` (the Yjs documents through `yrs`, the sync engine and its stores), `aparte-crypto` and
`aparte-format` (the `aparte/1` primitives and encodings). `crates/aparte/examples` builds a custom tool and a custom
agent from them.
