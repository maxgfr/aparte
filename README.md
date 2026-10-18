# Aparté

Aparté is a private AI chat that runs entirely in the browser. It talks to the models you choose, with your own API
keys or on your own hardware, and keeps conversations, documents and photos encrypted on the device, synced end to end
to storage you own. There is no account and no server: the app is a static site, and a Rust CLI opens the same vault
from the terminal.

**App:** <https://maxgfr.github.io/aparte/> (installable as a PWA on desktop, Android and iPhone; the shell works
offline).

## Features

- **Models:** Anthropic, OpenAI, Google Gemini, Mistral, OpenRouter and OpenAI-compatible services with your own keys;
  Ollama, LM Studio and Jan on your computer; models in the browser with WebLLM; Chrome's built-in Gemini Nano.
  Streaming, reasoning display, effort levels, regenerate and edit as branches.
- **Tools:** built-in web reading, MCP servers (Streamable HTTP, OAuth 2.1 with PKCE) with approvals that show the full
  arguments and detect definition changes, skills (`SKILL.md`), and Deep research with keyless search backends and
  checked citations.
- **Sandboxes:** JavaScript and Python (Pyodide with numpy, pandas and matplotlib) in sandboxed frames, and HTML, SVG
  and Mermaid artifacts that run only after a click.
- **Knowledge:** local knowledge bases over your documents (PDF and text), with hybrid search and cited answers.
- **Voice:** dictation with Whisper on the device or a provider's API, and reading answers aloud.
- **Sync:** a GitHub repository, an S3-compatible bucket (AWS, R2, MinIO, B2, Garage), a folder, or an `.aparte.zip`
  archive. Only ciphertext and the keyslots leave the device.
- **Also:** characters, side-by-side comparison of models, imports, exports, usage statistics, image generation, the
  share target and notifications.
- **CLI:** a coding agent for the terminal with sandboxed tools, skills, MCP, a JSON-lines RPC mode, and the same
  vault and sync as the web app.

## Privacy model, in brief

- Everything the app stores on the device is encrypted (AES-256-GCM under a master key wrapped by Argon2id from your
  passphrase and the Secret Key of the Emergency Kit), except public code, public model files and interface
  preferences.
- A sync destination sees ciphertext, sizes and times only, and devices detect a destination that rolls back or
  withholds data. The format, `aparte/1`, is specified in [spec/FORMAT.md](spec/FORMAT.md) and implemented twice, in
  TypeScript and in Rust, against shared vectors.
- API keys, sync credentials and OAuth tokens stay on the device that uses them, encrypted, and never sync.
- Every request goes through one module, over HTTPS (or to a model server on this machine), without cookies or a
  referrer; the About screen lists every origin contacted this session. A strict Content-Security-Policy and Trusted
  Types keep any other code from running, and model output is rendered without images, scripts or frames.
- The app on `maxgfr.github.io` shares its origin with other sites of the same account; what that allows, and what it
  does not, is in [docs/security-model.md](docs/security-model.md). [docs/self-hosting.md](docs/self-hosting.md)
  explains how to run it on an origin of its own.

## Install

- **Web app:** open <https://maxgfr.github.io/aparte/>, create a vault and keep the Emergency Kit. To install it, use
  the browser's install action (Add to Home Screen on iPhone).
- **CLI:** `brew install maxgfr/tap/aparte` on macOS or Linux, or a binary from the
  [releases](https://github.com/maxgfr/aparte/releases), checked against `SHA256SUMS` and its build provenance
  (`gh attestation verify aparte-<target> --repo maxgfr/aparte`). See [docs/cli.md](docs/cli.md).
- **Check the deployed app** against this repository: `scripts/verify-deploy.sh`.

## Development

The web app lives in `web/` (Bun, Vite, React, TypeScript), the CLI in `crates/` (Rust), the shared format and its
vectors in `spec/`.

```sh
cd web && bun install && bun run dev      # http://localhost:5173/aparte/
cd web && bun run check                   # types, lint, unit tests, build, security scan, size budget
cd web && bun run build && E2E_PORT=4530 bunx playwright test   # end to end: Chromium, WebKit, Firefox, with axe
scripts/check.sh                          # Rust: fmt, clippy, tests, cargo deny, actionlint, shellcheck
scripts/check-vectors.sh                  # aparte/1 vectors and fixtures, TypeScript against Rust
scripts/check-interop.sh                  # the web app's sync code and the CLI sync one vault through Git
```

Every user-facing string goes through `web/src/i18n`, `web/src/core` stays free of React and the DOM, and the test
and security gates are never weakened. The visual system is in [DESIGN.md](DESIGN.md), the product in
[PRODUCT.md](PRODUCT.md).

## Documentation

- [docs/security-model.md](docs/security-model.md): threat model, what is protected and how, documented leaks, the
  shared-origin limits.
- [docs/self-hosting.md](docs/self-hosting.md): building for an origin of your own, headers, verifying a deployment.
- [docs/sync.md](docs/sync.md): each destination, its CORS rule and GitHub token permissions.
- [docs/local-models.md](docs/local-models.md): Ollama, LM Studio, WebLLM and Chrome's built-in model.
- [docs/cli.md](docs/cli.md): install, commands, the RPC protocol, the MCP bridge.
- [spec/](spec/README.md): the `aparte/1` format, the data model and the MCP bridge protocol.
- [SECURITY.md](SECURITY.md): reporting a vulnerability.

## License

[MIT](LICENSE)
