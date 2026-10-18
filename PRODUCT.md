# Product

<!-- impeccable:product-schema 1 -->

This record was written from the project brief and the repository at milestone M0, without a separate interview, and
brought up to date with what has shipped since.
Facts marked _(assumed)_ are inferences from that brief and should be confirmed or corrected before they steer a
decision.

## Platform

web

## Stack

Delegated, set by the brief: Bun 1.4 (package manager, scripts, `bun test`), Vite 8 + vite-plugin-pwa 2, React 19,
wouter, TypeScript 7 strict, native CSS (custom-property tokens), Biome 2, Playwright + axe for the UI. Static hosting
on GitHub Pages under `/aparte/`; no server of any kind. A Rust CLI (`crates/`) reads and writes the same sync format.

## Users

Privacy-minded power users and developers who already use AI chat daily and do not want their conversations, keys or
documents to live on someone else's server. They bring their own API keys or run models on their own hardware
(WebLLM in the browser, Ollama or LM Studio on the local network). Same person across moments:

- iPhone or Android, installed as a PWA, for quick questions, voice and photos on the move; this is the first target;
- desktop browser for long sessions: code, documents, tool calls, reading long answers;
- the terminal, through the CLI: a coding agent with tools, skills and MCP that opens the same vault, syncs through
  the same stores and continues the web app's conversations.

They read technical detail and want to verify claims rather than take them on trust.

## Product Purpose

Aparté is a private AI chat. "En aparté" means in private, a word said aside: the conversation happens between the
user and the model, and nobody else is in the room. Everything stays in the browser: data is encrypted on the device,
synced end-to-end to storage the user owns, and every network request is visible. Success: the user asks anything,
including about private documents and photos, and can see for themselves that nothing left the device except the
request to the provider they chose.

## Positioning

Client-only by construction, not by policy: there is no Aparté server to trust, breach or subpoena. Keys, history,
documents and photos are encrypted at rest on the device and synced as ciphertext to the user's own Git repository or
storage; the format (`aparte/1`, `spec/`) is open and readable by an independent Rust implementation. Hosted chat apps
own the account and the data; local model front-ends rarely offer encrypted multi-device sync, a sandbox and a
transparency panel together.

## Operating Context

- A chat thread is the unit of work; threads hold text, images, files, tool calls and their results.
- Providers are configured once per device with the user's own keys; on-device and local-network models need no key.
- Optional capabilities the user turns on deliberately: MCP tools, skills, a JavaScript and Python sandbox, local
  document search, voice input and output.
- The app is locked behind a passphrase and the Secret Key of the Emergency Kit; unlocking decrypts locally. Passkey
  unlock is reserved to builds served from a dedicated origin and not offered yet.
- Sync destinations (a Git repository the user owns, or other user-owned storage) are configured once and carry only
  ciphertext.
- A transparency panel (on the About screen) lists every origin contacted this session and why (`provider`, `mcp`,
  `tool`, `sync`, `download`, `catalog`, `skills`, `research`, `app`).

## Capabilities and Constraints

- Strictly client-only PWA on a shared origin (`maxgfr.github.io`); installable on iPhone, Android and desktop; the
  shell works offline.
- Security baseline is part of the product, not an implementation detail: strict CSP, Trusted Types, no third-party
  script, style, font or CDN, all requests through one audited module, untrusted code only in sandbox frames, nothing
  stored in plaintext.
- Interface language: English only for now, every string through i18n so more languages can follow.
- Shipped: chat with streaming, branches and effort; in-browser and local models; tools, MCP with OAuth and
  approvals; skills and Deep research; JavaScript and Python sandboxes and artifacts; local knowledge bases; voice;
  end-to-end sync to a GitHub repository, an S3-compatible bucket, a folder or an archive; the CLI.
- Undecided: a custom domain, pricing (none is planned _(assumed)_).

## Brand Commitments

- Name: Aparté, with the accent; "Aparte" only where a system forbids it (package names, paths, the sync format id).
- Voice: calm, plain and exact. Security is stated as verifiable fact ("Encrypted on this device", "3 requests to
  api.example.com"), never as reassurance or fear. No hype, no anthropomorphic assistant persona, no exclamation marks.
- Identity: a private room. Quiet, warm, trustworthy, legible for long reading; restrained rather than loud.
- Mark: `web/public/logo.svg`, a speech bubble with a keyhole on a deep green square.
- System font stack only; no external or bundled web fonts.

## Evidence on Hand

None yet: no users, testimonials, audits, benchmarks or press. Do not fabricate any, and do not claim an external
security audit until one exists.

## Product Principles

1. Verifiable, not promised: every privacy or security claim in the UI is backed by something the user can inspect
   (the network log, the format spec, the open source).
2. Nothing leaves without a reason: each request has a declared purpose and an origin the user chose.
3. The user owns the room: their keys, their models, their storage, open formats, export at any time, no account.
4. Quiet by default: powerful features (tools, sandbox, sync) are opt-in and never interrupt reading or writing.
5. Never cut the user off: an update, a lock or a sync never interrupts an answer that is still streaming.

## Accessibility & Inclusion

- WCAG 2.2 AA as the target, checked by axe in the end-to-end gates.
- Phone first: touch targets of at least 44px, safe areas, on-screen keyboard aware layout, 16px minimum input size.
- Keyboard complete on desktop; screen-reader announcements for streaming answers and tool results.
- Respects reduced motion, system dark mode and forced colours; long reading is a first-class use, so prose measure
  and line height are tuned for it.
