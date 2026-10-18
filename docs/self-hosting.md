# Self-hosting

The deployed app at `https://maxgfr.github.io/aparte/` shares its origin with every other GitHub Pages site of the
account, and [docs/security-model.md](security-model.md#shared-origin) lists what another site of that origin can
still do. Serving the app from an origin of its own removes all of it: no other page can read its storage, unregister
its service worker, open or frame it, or share its permissions.

## Choose an origin

Use a host name that serves nothing else, for example `chat.example.dev`. A domain under `.app` or `.dev` is on the
HSTS preload list as a whole, so browsers never reach it over plain HTTP; on another domain, send
`Strict-Transport-Security` and consider preloading it. `github.io` is not preloaded.

The origin and the path are compiled into the build's Content-Security-Policy, so the build must be made for the exact
origin it will be served from. The app may live under a path (`/aparte/`) or at the root (`/`).

## Build

With Bun 1.4 (the version CI uses):

```sh
cd web
bun install --frozen-lockfile
VITE_ORIGIN=https://chat.example.dev VITE_BASE=/ DEDICATED_ORIGIN=1 bun run build
bun run scan            # the security scan of the source and of the build
```

| Variable | Default | |
|---|---|---|
| `VITE_ORIGIN` | `https://maxgfr.github.io` | the origin, without a trailing slash |
| `VITE_BASE` | `/aparte/` | the path, starting and ending with `/` |
| `DEDICATED_ORIGIN` | unset | `1` marks the build as served from an origin of its own |
| `APP_VERSION` | the latest tag | the version the About screen shows |

The site is `web/dist`: upload it as is. Routing uses the URL fragment (`#/chat/...`), so the server needs no rewrite
rule; it must serve `index.html` at the base path.

`DEDICATED_ORIGIN=1` makes the About screen say the copy runs on an origin of its own. Passkey (WebAuthn PRF) unlock
and "stay unlocked on this device" are reserved to such builds, as they are unsafe on a shared origin; the vault
format defines the passkey keyslot, but the web app does not offer either feature yet.

## Headers

Static hosts that cannot set headers (GitHub Pages with a custom domain, for one) still work: the `<meta>` policy
protects the first load, the page refuses to run framed or opened by another page, and once the service worker
controls the app it adds the headers below to every navigation and worker script it answers. A host that can set them
should, so the first visit and a Shift+Reload, which bypass the service worker, are covered too.

On `index.html` (and the base path itself), print the exact values for your origin from `web/`:

```sh
bun -e "import { securityHeaders } from './src/security/policy.ts'; console.log(securityHeaders({ origin: 'https://chat.example.dev', base: '/' }))"
```

which gives:

```text
Content-Security-Policy: default-src 'none'; script-src https://chat.example.dev/ 'wasm-unsafe-eval'; style-src https://chat.example.dev/; font-src https://chat.example.dev/; manifest-src https://chat.example.dev/; worker-src https://chat.example.dev/ blob:; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; frame-src https://chat.example.dev/sandbox/; object-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'; trusted-types aparte dompurify; frame-ancestors 'none'
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()
```

- On the worker scripts (`assets/*.worker-*.js`), the worker policy: `workerHeaders()` in the same file prints it.
- **Not** on `sandbox/runner.html`, `sandbox/artifact.html` or `oauth-callback.html`: each carries its own policy in
  its markup, and the app's policy would stop them (the sandbox pages run `blob:` workers, the callback an inline
  script allowed by its hash). `X-Content-Type-Options`, `Referrer-Policy` and HSTS suit them too.
- Everywhere: `X-Content-Type-Options: nosniff`, and HSTS.
- Types: `.js` as `text/javascript`, `.webmanifest` as `application/manifest+json`, `.wasm` as `application/wasm`.
- Caching: `assets/` files are named by their content and may be cached for a year (`immutable`); `index.html`,
  `sw.js` and `manifest.webmanifest` should be revalidated (`Cache-Control: no-cache`). The app checks for a new
  service worker every hour and when it returns to the foreground, and offers the update without interrupting an
  answer.

The share target (photos and text shared from another app to the installed PWA) is a `POST` to `<base>share`, answered
by the service worker; the server never sees it.

## What changes with the origin

- **S3 sync:** the bucket's CORS rule must allow the new origin; the Sync screen shows the rule with it filled in
  ([docs/sync.md](sync.md#s3-compatible-bucket)).
- **Local model servers:** allow the new origin (`OLLAMA_ORIGINS=https://chat.example.dev ollama serve`), see
  [docs/local-models.md](local-models.md). Chrome's local network permission then belongs to this origin alone.
- **MCP servers with OAuth:** the redirect address is `<origin><base>oauth-callback.html`.
- **The CLI's MCP bridge** accepts requests from `https://maxgfr.github.io` and from `localhost` or `127.0.0.1` pages
  only; a copy on another origin cannot use it.
- **Data:** a new origin has its own, empty storage. Join the vault from its sync destination or an archive, with the
  passphrase and the Secret Key.

## Checking a build

From `web/`, `bun run check` runs the type check, the lint, the unit tests, the build, the security scan and the size
budget. The end-to-end suite runs the production build in Chromium, WebKit and Firefox:

```sh
bunx playwright install chromium firefox webkit
E2E_PORT=4530 bunx playwright test        # builds for http://localhost:4530/aparte/ and serves it
```

Firefox runs Web Audio only through a sound server. On a Linux machine without one, the dictation spec needs a
PulseAudio null sink: start it as the `web-e2e` job of `.github/workflows/ci.yml` does and name its socket in
`E2E_PULSE_SERVER` (for example `unix:/tmp/aparte-e2e-pulse/native`), which the Playwright config hands to Firefox.

## Verifying a deployment

`scripts/verify-deploy.sh` checks that a live copy is exactly a build of this repository. From the repository root:

```sh
scripts/verify-deploy.sh                                          # https://maxgfr.github.io/aparte/
scripts/verify-deploy.sh --site https://chat.example.dev/ --no-attestation --rebuild <commit> --version <x.y.z>
```

1. It downloads `index.html` and `sw.js`, then every file the service worker precaches, and checks each against the
   SHA-256 compiled into `sw.js`: what the worker itself checks before serving it.
2. For the deployed app, it verifies `sw.js` with `gh attestation verify --repo maxgfr/aparte --signer-workflow
   maxgfr/aparte/.github/workflows/deploy.yml`. The deploy workflow attests every file of the site in one build
   provenance attestation; the script reads the digest of each file from it and checks every one as the site serves
   it, including the sandbox pages, the OAuth callback and the chunks the worker does not precache. It prints the
   commit the attestation was made from.
3. With `--rebuild <commit> --version <x.y.z>` (the version and commit the About screen shows), it builds that commit
   in a temporary worktree for the site's origin and path and compares every file with the live copy byte for byte.
   Use the Bun version of CI; a different one may produce different bytes.

It exits with 0 when every check passed and 1 when a file differs or the attestation does not verify. It needs `curl`,
`jq` and `openssl`, `gh` (logged in) for the attestation, and `git` and `bun` for a rebuild. Attestations exist for
deployments made after the deploy workflow started publishing them.
