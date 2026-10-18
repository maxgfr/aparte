# Security model

This document describes what Aparté protects, against whom, how each protection is enforced, and what it does not
protect. It covers the web app (`web/`) and, where they share the vault and the sync format, the CLI (`crates/`). The
byte-level format is in [spec/FORMAT.md](../spec/FORMAT.md); its sections 13 (what leaks) and 14 (known limits) are
part of this model and are summarised below.

## What there is to protect

- **Conversations, documents, photos and settings.** They live in the user's vault: encrypted on each device and
  synced as ciphertext.
- **Secrets.** Model provider API keys, sync credentials (a GitHub token, S3 keys) and MCP OAuth tokens. They stay on
  the device that uses them, encrypted, and never enter the synced documents.
- **The vault's keys.** The passphrase, the Secret Key of the Emergency Kit, the recovery key, and the master key they
  unwrap.
- **The integrity of the app itself.** The code that runs is the code that was built from this repository.

## Who is in the threat model

| Adversary | Can | Aparté's answer |
|---|---|---|
| The sync host (GitHub, an S3 provider, whoever holds the folder or the archive) | read, withhold, roll back, reorder or tamper with everything stored | it holds only ciphertext and keyslots; every object is authenticated; devices detect rollback ([FORMAT §10](../spec/FORMAT.md#10-store-rules-and-anti-rollback)) |
| A network observer | see TLS metadata | HTTPS only, except to a model server on this machine's loopback |
| A model provider or an MCP server the user chose | read what is sent to it, answer anything | sends only what the conversation needs; its answers are untrusted (sanitised rendering, tool approvals, sandboxes) |
| Model output, a fetched page, a tool result, an artifact (prompt injection) | make the model ask for anything | no tool with effects runs without approval; untrusted code runs only in sandbox frames; rendered output cannot load anything |
| Another site of the shared origin `maxgfr.github.io` | everything a page of the same origin can do | see [Shared origin](#shared-origin): it finds ciphertext, cannot get its code served as Aparté, and cannot frame Aparté or keep a handle on an Aparté window while the service worker controls it |
| Someone with a copy of the device's browser profile | read the IndexedDB database | ciphertext and keyslots; only the passphrase and Argon2id protect the vault ([FORMAT §14](../spec/FORMAT.md#14-known-limits)) |

Out of the model: a compromised operating system, browser or browser extension; someone who has the passphrase (and the
Secret Key, or the recovery key); a malicious build of the app (see [Verifying the deployed
app](#verifying-the-deployed-app) for how to check the build you run).

## What is protected, and how it is enforced

Each invariant below names the gate that fails the build or the tests when it is broken. The gates are frozen: they
are never skipped or weakened, and `bun run check` plus the Playwright suite (five projects: Chromium desktop and
phone, WebKit desktop and iPhone, Firefox) run on every pull request.

### Nothing is stored in plaintext

- IndexedDB `aparte-v1` holds a `meta` store (the format marker, the vault id, the keyslots, a non-extractable
  device key and the Secret Key wrapped by it) and three stores of AES-256-GCM envelopes under HMAC-derived names
  ([FORMAT §11](../spec/FORMAT.md#11-local-storage)). `meta` refuses any other entry.
- IndexedDB `aparte-inbox-v1` holds what another app shared to Aparté while it was locked, sealed at once by the
  service worker to the device's inbox public key ([FORMAT §16](../spec/FORMAT.md#16-share-inbox)).
- CacheStorage holds public code and model files only: the precache of the app (checked against the digests in the
  service worker), the sandbox runtimes (`aparte-runtime-v1`) and in-browser model files (`aparte-webllm/*`,
  `aparte-transformers`), each pinned by SHA-256 and checked again when read back.
- localStorage holds the interface preferences listed in `web/src/app/prefs.ts` (theme, dictation and read-aloud
  engines, push to talk, notifications, a pending Emergency Kit marker); sessionStorage holds one reload flag.
- Answers from providers, MCP servers and fetched pages are requested with `cache: 'no-store'`, so they stay out of
  the browser's HTTP cache (`web/src/security/net.ts`).

Enforced by: the plaintext canary of the e2e suite (`web/e2e/fixtures/storage.ts`), which reads IndexedDB,
localStorage, sessionStorage, CacheStorage and the origin private file system after real flows (a chat with an API key,
a GitHub token, OAuth tokens, a shared photo with a GPS tag, sandbox output, a knowledge base, generated images) and
fails on any canary string in UTF-8, UTF-16 or base64; the `web-storage` rule of `bun run scan` (only `prefs.ts` may
touch Web Storage); the unit tests of `core/store`, `core/vault` and `core/inbox`.

### Secrets never reach the synced documents

Provider keys (`provider-key`), sync configurations with their credentials (`sync-credential`) and MCP tokens
(`oauth-token`) are local records of the device that uses them ([FORMAT
§11.3](../spec/FORMAT.md#113-local-record-names)). The synced workspace refuses provider and MCP entries that carry a
field named like a secret or a value shaped like a key, and endpoint URLs with credentials, a query or a fragment
(`web/src/core/workspace/workspace.ts`). A second device asks for its own keys.

Enforced by: the workspace unit tests, and the canary of the sync e2e test, which searches the remote store and the
archive for the token.

### The code that runs is the build's

- **Content-Security-Policy.** Every page carries a `<meta>` policy written at build time
  (`web/src/security/policy.ts`, `web/build/csp.ts`): `default-src 'none'`; scripts, styles, fonts, the manifest and
  workers from `<origin>/aparte/` only (not the origin: other sites share it); WebAssembly may compile
  (`'wasm-unsafe-eval'`) but JavaScript may not be evaluated; images and media from the app, `blob:` and `data:`
  only; frames from `<origin>/aparte/sandbox/` only; no `object`, `base` or form target.
- **Trusted Types.** `require-trusted-types-for 'script'` with two policies and no default one: `aparte`
  (`web/src/security/tt.ts`) vouches only for `<base>assets/<chunk>.js` and `<base>sw.js`, and `dompurify` is the
  sanitiser's. An engine that implements Trusted Types refuses any string at an HTML or script URL sink (Chromium
  does, and the e2e suite records which other engines do); the About screen shows whether this browser enforces them.
- **No HTML sink in the app.** Model output goes through DOMPurify, returns a DocumentFragment and is inserted with
  `replaceChildren`; it keeps text structure only: no image, media, frame, form, script, style or SVG, and links go
  through an interstitial that shows the full address (`web/src/ui/render/purify.ts`).
- **Startup order.** `web/src/main.tsx` creates the Trusted Types policy, switches Zod to its jitless mode and checks
  the window before any other module is imported.
- **Workers** start only through `web/src/security/workers.ts`, from a Trusted Type. The service worker adds a policy
  to every worker script it serves (no evaluation, `connect-src` as the page).
- **No third-party code at runtime** except pinned, hash-checked files: the model files and WebLLM libraries, ONNX
  Runtime (served by the app itself), Pyodide, its packages and Mermaid (fetched by the page, checked against
  `web/src/core/sandbox/runtime-lock.json`, handed to the sandbox frames as bytes).

Enforced by: `bun run scan` (`web/scripts/scan.ts`: no `innerHTML`, `outerHTML`, `insertAdjacentHTML`,
`document.write`, `eval`, `new Function` or string timer in `src`; `dangerouslySetInnerHTML` only in the sanitiser;
every place the built JavaScript could evaluate code; the CSP `<meta>` ahead of everything in `dist/index.html`);
the e2e gates, which fail any test on a CSP or Trusted Types violation, a console error or an uncaught exception in
any frame (`web/e2e/gates.ts`); the shell e2e tests (the policy served, Trusted Types refusing a string sink and a
rogue policy); the XSS corpus of the renderer.

### Every request goes through one door

`request()` in `web/src/security/net.ts` is the only caller of `fetch`. Each request states a purpose (`app`,
`provider`, `mcp`, `tool`, `sync`, `download`, `catalog`, `skills`, `research`); it must be HTTPS, or plain HTTP to
`localhost` or `127.0.0.1`; it carries no cookie, HTTP authentication or referrer; credentials in a URL are refused; and
the origin and purpose (never the path or the body) are recorded in an in-memory log, with the origin a redirect led to;
the About screen lists it ("Network this session"). Every AI SDK provider and the MCP transports are handed this
wrapper; the model and document workers replace their global `fetch` with a confined one and drop `XMLHttpRequest`,
`WebSocket` and `EventSource` before any library loads (`web/src/security/workerNet.ts`). The `fetch_url` tool drops
what a redirect brought back from this machine, a private network or plain HTTP, and so does Deep research's
`research_read`.

[spec/network-allowlist.json](../spec/network-allowlist.json) lists, per purpose, the fixed hosts the app may contact:
the default API hosts of the providers it ships, the GitHub API (sync), the pinned download hosts, the GitHub API and
`raw.githubusercontent.com` for importing a skill from a public repository (unauthenticated), and the keyless search
backends and readable APIs of Deep research (Wikipedia, Marginalia, Mojeek, Hacker News, Stack Exchange, GitHub,
OpenAlex, Crossref, Europe PMC, PubMed, ClinicalTrials.gov, the IETF datatracker and the RFC Editor). Hosts the user
enters (a provider endpoint, a preset of the catalog they pick, an MCP server, an S3 endpoint, a page `fetch_url` reads)
are not listed.

Enforced by: the `fetch`, `fetch-reference`, `network-api`, `import-scripts` and `new-worker` rules of
`bun run scan`; the network gate of every e2e test, which aborts and reports any request to a host the allowlist does
not grant for the purposes the test declares (`web/e2e/gates.ts`); the unit tests of `net.ts`.

### Untrusted code runs only in sandbox frames

`run_js`, `run_python` and artifacts run in `<base>sandbox/runner.html` and `<base>sandbox/artifact.html`, framed with
`sandbox="allow-scripts"`: an opaque origin, so nothing of the app's storage is reachable. Each page carries its own
policy with `connect-src 'none'` and no host for any load; it refuses to run unless its origin is opaque and it is
framed. Messages are checked in both directions (`event.source`, the origin, a schema). Code runs in `blob:` workers
with storage, network and channel APIs removed. An artifact is inert (`sandbox=""`) until the user clicks Run; then a
prelude removes WebRTC from its realm (no CSP governs WebRTC), removes any frame it nests and the APIs that would
parse markup out of reach, and an artifact whose markup nests a document does not run at all.

Enforced by: the sandbox escape suite (`web/e2e/sandbox.spec.ts`: fetch, XHR, WebSocket, EventSource,
`importScripts`, `sendBeacon`, WebRTC, IndexedDB, caches, workers, channels, nested documents), and the network gate
of every test.

### Tools with effects run only with approval

A tool call that is not a read-only, closed-world built-in waits for the user, who sees its full arguments. An
approval is stored for the tool's fingerprint: an MCP tool whose definition changes asks again
(`web/src/core/tools/policy.ts`). A call to a tool the conversation does not declare is refused.

Deep research uses two open-world built-ins, `research_search` and `research_read`, which a Deep research chat allows
for that conversation when the user starts it. `research_read` reads only an address the chat surfaced (a result of
its own searches), so text planted in a page cannot make it fetch an address of its choosing
(`web/src/core/research/tools.ts`).

Skills are imported by the user from a public GitHub repository (read at one commit), a zip archive or a folder, and
stored in the vault like any other data (an encrypted blob, synced). The `skill` tool only reads an installed skill's
files; a skill's scripts run only through `run_js` or `run_python`, which ask with the code shown in full. A skill's
instructions are text the model reads: installing one is trusting its author with the model's behaviour, not with
the device.

Enforced by: the tool and MCP e2e tests, including injection through a tool result that tries to call a network or
destructive tool; the research and skills unit tests.

### The vault

The master key is wrapped by keyslots: a passphrase (Argon2id, `m = 64 MiB`, `t = 3`, `p = 1`) combined with the
16-byte Secret Key of the Emergency Kit, and a recovery key. Keyslots commit to their key before decrypting, so a
wrong secret is told apart from a damaged slot. Keys are non-extractable `CryptoKey` objects; raw key bytes are zeroed
after use; locking drops them (the vault locks after 5 minutes without activity, after a 30-second grace period). The
pending Emergency Kit marker in localStorage only asks for a renewal: the vault renews the recovery key only for a
proof it made itself, under a key derived from the master key, for a recovery slot it still holds.

Enforced by: the crypto, keyslot and vault unit tests (RFC and Wycheproof vectors, bit flips, hostile parameters), the
cross-implementation vectors (`scripts/check-vectors.sh`) and the vault e2e tests.

## Shared origin

`https://maxgfr.github.io/aparte/` shares its origin with every other GitHub Pages site of the same account. A page of
another site (or a script injected into one) is same-origin with Aparté: it can read and write the same IndexedDB,
CacheStorage and localStorage, see the service worker registrations, post to the same BroadcastChannels, and script
any window of the origin it holds a reference to. `web/e2e/shared-origin.spec.ts` plays such a page at `/evil/` on
every engine and checks each defence below.

What holds:

- **It reads ciphertext.** The database is encrypted as described above; the test reads everything back from the
  sibling page and finds no canary.
- **It cannot get its code served as Aparté.** Every precached response is checked against an SRI digest compiled into
  the service worker before it is served; a planted entry is deleted, fetched again with `integrity` and put back.
  The worker script itself is fetched from the network on every update check (`updateViaCache: 'none'`).
- **It cannot frame Aparté.** While the service worker controls the app, every navigation it answers carries
  `frame-ancestors 'none'`. Without it, the page refuses to run framed (`web/src/security/frame.ts`), comparing
  `window.top` with `window` (which no script can redefine) as well as with `self` (which a framing page of the same
  origin can replace).
- **It cannot keep a handle on an Aparté window it opens** while the service worker controls the app: the navigation
  carries `Cross-Origin-Opener-Policy: same-origin`, which severs the opener, even one that set the window's
  `opener` to null to hide.
- **It cannot drive the service worker.** The worker activates an update only for a top-level window it controls on a
  page of the app shell (`web/src/pwa/routes.ts`), and the page acts on a worker message only when it comes from the
  worker that controls it.
- **A planted preference does not change what the app does with data.** The pending-kit marker needs a proof only the
  open vault can make; choosing the browser's speech service for dictation (which sends the audio to the browser
  maker) asks again in each page before the microphone uses it (`web/src/app/consent.ts`).
- **No passkey to trigger.** The shared-origin build never calls WebAuthn.
- **OAuth.** The sign-in popup is opened with `noopener`; the callback page relays the code on a BroadcastChannel named
  after a 256-bit random `state`, which another page cannot guess, and the PKCE verifier stays in the app's memory.

What does not hold, and cannot on a shared origin:

- **Deletion.** It can delete the database, the caches and the registrations. Sync is the backup.
- **Unregistering the service worker, then scripting a window it opens.** Any page of the origin may unregister the
  worker. The next window it opens on Aparté then loads without the worker's headers; it can set that window's
  `opener` to null, which no check in the page can detect, and script it, including what the user types into it. The
  worker is registered again at the next visit the user makes themselves.
- **Phishing on the same origin.** It can show a copy of Aparté under its own path and rewrite the address bar to
  `/aparte/` with `history.replaceState`.
- **The Secret Key.** It can use the non-extractable device key to unwrap the stored Secret Key, so against it only
  the passphrase and Argon2id protect a copy of the keyslots.
- **The share inbox.** It can replace the inbox public key between a share and the next unlock, read what is shared to
  its key, and put the original key back; the planted key is then not detected ([FORMAT
  §16](../spec/FORMAT.md#16-share-inbox)). It can also POST forged shares to `<base>share`, which reach the share
  screen as if another app had shared them; nothing is sent anywhere before the user starts a chat with one.
- **The root site.** A service worker registered by `https://maxgfr.github.io/` itself (the account's root site, which
  can use the scope `/`) controls `/aparte/` whenever Aparté's own registration is gone. That site is part of what the
  shared-origin build trusts.
- **Local Network Access.** A permission to reach a model server on the local network is granted to the whole origin.

For this reason passkey (WebAuthn PRF) unlock and "stay unlocked on this device" are not offered on the shared origin:
another site of the origin could use a passkey made for it, or a key kept unlocked. A build with `DEDICATED_ORIGIN=1`
marks itself as running on an origin of its own (the About screen says so); the format defines a passkey keyslot for
such builds, but the web app does not offer passkey unlock or "stay unlocked" yet. The remedy for everything in this
list is to run the app on an origin of its own: [docs/self-hosting.md](self-hosting.md).

## Documented leaks

- **To the sync host:** that the store is an `aparte/1` vault, the number and kinds of keyslots, the number of
  documents, devices and objects, padded sizes, upload times and which objects are fetched together
  ([FORMAT §13](../spec/FORMAT.md#13-what-leaks)). A Git host keeps the whole history: deleted data stays there as
  ciphertext.
- **To a provider:** everything in the conversation sent to it, as for any client of that provider. Photos are
  re-encoded first, without their metadata.
- **To search backends and read pages:** the queries Deep research sends to its keyless backends and the addresses
  it reads, without cookies or a referrer, from the user's IP address.
- **On the device, in clear:** which in-browser models are downloaded (their files are public); the interface
  preferences; the browser's history of the app's addresses (`#/chat/<id>` and similar), which says how many
  conversations were opened and when, but not what they hold; pinned downloads and sync objects in the HTTP cache
  (public files and ciphertext).
- **To a sibling site of the shared origin:** all of the above that is on the device.
- **WebRTC in a Run artifact:** an artifact the user ran is kept from WebRTC by the prelude only, since no CSP governs
  it; a browser bug that left a realm with WebRTC would let it resolve a host name of its choice.

## Not offered yet: a tighter connect-src

The policy allows `connect-src 'self' https: http://localhost:* http://127.0.0.1:*`, because the endpoints are chosen
by the user. A tighter policy after unlock (a second `<meta>` naming only the configured hosts, which can only narrow,
with a reload whenever they change) was evaluated and deferred:

- the hosts are not all known ahead of a request: an MCP server names its OAuth authorization server during
  discovery, Hugging Face redirects model downloads to CDN hosts that differ by region, and `fetch_url` reads a page
  the conversation chose after the user approved it, which a narrowed policy would block until a reload that ends the
  turn;
- a `<meta>` policy in the page does not govern workers, which load the models and documents and are governed by the
  policy of their own response;
- what it would stop, script running in the page and calling `fetch`, is already prevented by the script policy and
  Trusted Types, and every request the app makes goes through `net.ts`, which enforces the same scheme rule and
  records every origin.

## Verifying the deployed app

The deploy workflow attests every file of the site: one build provenance attestation names each file with its SHA-256
(`.github/workflows/deploy.yml`). `scripts/verify-deploy.sh` downloads the live `index.html`, `sw.js` and every file
the attestation names, checks each against it with `gh attestation verify`, checks every precached file against the
digest `sw.js` carries, and can rebuild a given commit locally and compare it with the live site byte for byte. See
[docs/self-hosting.md](self-hosting.md#verifying-a-deployment).

## Reporting

See [SECURITY.md](../SECURITY.md).
