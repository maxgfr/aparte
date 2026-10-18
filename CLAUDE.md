# Aparté

Private AI chat that runs entirely in the browser (a PWA on GitHub Pages under `/aparte/`, no server), plus a
compatible Rust CLI. Monorepo: `web/` (TypeScript, Bun, Vite, React), `crates/` (Rust workspace), `spec/` (shared
format, vectors, fixtures).

## Commands

- Web, from `web/`: `bun run dev` / `bun run build` / `bun run preview`; `bun run typecheck`, `bun run lint`,
  `bun run test` (bun test), `bun run scan` (security bans over `src` and `dist`), `bun run size` (bundle budget),
  `bun run test:e2e` (Playwright + axe, needs `bun run build`), `bun run check` (everything but e2e),
  `bun run pin:models` (re-pins the in-browser models to Hugging Face commits with SHA-256 digests; review the diff).
- Rust, from the root: `scripts/check.sh` (fmt, clippy `-D warnings`, tests, cargo deny, actionlint, shellcheck).

## Rules

- `web/src/core/**` is pure TypeScript: no React, no DOM. Tested with `bun test`; the UI is tested with Playwright.
- Every user-facing string goes through i18n (`web/src/i18n`, English is the typed source).
- Security invariants, enforced by `bun run scan` and the e2e gates:
  - no `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function` or string timers;
    `dangerouslySetInnerHTML` only in the sanitised renderer, through the `dompurify` Trusted Types policy;
  - every network request goes through `web/src/security/net.ts`, workers are created only through
    `web/src/security/workers.ts`, the service worker is registered only through `web/src/pwa/register.ts`;
  - nothing is stored in plaintext: IndexedDB, CacheStorage and localStorage hold ciphertext, the format marker,
    keyslots and non-sensitive UI preferences only, and secrets never go into the synced Yjs documents;
  - no third-party script, style, font or CDN in the app; code fetched at runtime is pinned and hash-checked;
  - untrusted code (model output, artifacts, skill scripts) runs only in the sandbox frames.
- The sync format `aparte/1` (`spec/FORMAT.md`, `spec/vectors`, `spec/fixtures`) is frozen once released: a change
  needs a new version and new fixtures, never edited ones. TypeScript is the reference; Rust reads and writes the
  same bytes.
- Gates are frozen: never skip, weaken or delete a test, never lower a threshold, no suppression comments.
- Rust: `unsafe_code` is forbidden, `thiserror` in libraries and `anyhow` only in the binary, no `openssl`.
- Visual rules are in `DESIGN.md`, product truth in `PRODUCT.md`. `.impeccable/` is local working output, never
  committed.
- Docs are in English, factual, without tool or assistant attribution.
