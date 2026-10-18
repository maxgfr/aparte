# Security policy

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting:
<https://github.com/maxgfr/aparte/security/advisories/new>. Do not open a public issue, pull request or discussion for
it.

A useful report says what is affected (the web app at a given version and commit, as the About screen shows it, or
the CLI at a given version), the steps to reproduce, and what an attacker gains. A proof of concept against your own
vault, storage and keys is welcome; never test against another person's data or accounts.

The discussion stays in the private advisory. A confirmed issue is fixed on `main`, which deploys the web app and, for
a `fix` commit, releases a new CLI version; the advisory is published once the fix is out, crediting the reporter
unless they prefer otherwise.

## Supported versions

| Component | Supported |
|---|---|
| Web app at <https://maxgfr.github.io/aparte/> | The deployed version only: every fix ships there. |
| Self-hosted web builds | Builds of the latest `main`. |
| CLI (`aparte`) | The latest release. Earlier releases are not patched; upgrade with `brew upgrade aparte`. |
| Sync format `aparte/1` | Supported. A flaw in the format itself is fixed by a new format version ([spec/FORMAT.md](spec/FORMAT.md)). |

## Scope

In scope:

- the web app built from this repository: its encryption at rest, the vault and keyslots, sync, the service worker,
  the Content-Security-Policy and Trusted Types, the sandbox frames, tool approvals, the OAuth flow, the network rules
  of `web/src/security/net.ts`;
- the CLI and its crates: the vault and keychain use, sync, the bash sandbox, `aparte mcp serve` and
  `aparte mcp bridge`, the MCP client and its OAuth;
- the `aparte/1` format and its two implementations;
- the release pipeline: the Pages deployment, its attestation and the CLI binaries.

Out of scope:

- the limits [docs/security-model.md](docs/security-model.md) documents, unless you find a way past the defence it
  describes: for example, that another site of `maxgfr.github.io` can delete the app's storage or phish on the same
  origin, or that a sync host can withhold data from a new device;
- model providers, MCP servers, sync storage and local model servers the user chooses, and what they do with the data
  they are sent;
- a compromised device, browser profile, browser extension or operating system;
- attacks that need the user's passphrase, Secret Key or recovery key, or that rely on the user approving a tool call
  whose full arguments were shown to them;
- denial of service against GitHub Pages or a provider.
