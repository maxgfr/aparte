# Data model `aparte/1`

**Status: draft**, frozen with [FORMAT.md](FORMAT.md) at the end of milestone M3. This document describes what the
encrypted documents of a vault contain; FORMAT.md describes how they are encrypted, named and stored. A change that
an older build would misread needs a new format version.

## 1. Documents

A vault holds 17 Yjs documents, each synced as its own stream of segments and checkpoints (FORMAT.md section 8.4):

| `docId` | Content | Loaded |
|---|---|---|
| `index` | everything except messages: conversation list, folders, personas, prompts, provider and MCP configuration, skills, knowledge, settings | at unlock |
| `c00` to `c15` | the messages of the conversations whose shard (FORMAT.md section 8.3) is that `docId` | on demand, when one of its conversations is opened or searched |

Sharding keeps the index small and lets a phone open one conversation without downloading the whole history. A
conversation never moves between shards: its shard is a function of its id.

## 2. Yjs rules

Both implementations (Yjs on the web, `yrs` in Rust) must decode every update the other writes and see the same
values. To keep that tractable the schema is restricted:

- Shared types: `Y.Map` and `Y.Array` only. No `Y.Text`, no `Y.XmlFragment` or other XML types, no subdocuments.
- Leaf values are Yjs `Any`: `null`, booleans, finite numbers, strings, byte arrays, and arrays or objects of those.
  Never `undefined` (absent means the key is not set), never `BigInt`, never `NaN` or an infinity.
- Integers (timestamps, sizes, counts) are safe integers (`|n| < 2^53`). Timestamps are Unix milliseconds.
- Strings are well-formed Unicode. `yrs` MUST be configured with `OffsetKind::Utf16`, the Yjs default, so offsets and
  lengths agree.
- Updates use the v2 encoding (`Y.encodeStateAsUpdateV2`, `yrs` `encode_v2`).
- A JSON value stored at a key is replaced as a whole; concurrent writes to the same key resolve last-writer-wins by
  Yjs rules. Values that devices edit independently are separate keys.
- Ids are 26-character base32 strings of 16 random bytes (FORMAT.md section 4). Keys of top-level maps are entity
  ids.

## 3. Index document

Top-level `Y.Map`s, each `id -> Y.Map` of one entity whose fields are `Any` values:

| Map | Entity |
|---|---|
| `conversations` | [3.2](#32-conversation) |
| `folders` | `{id, name, parent: folderId \| null, order: string}` |
| `personas` | `{id, name, systemPrompt: string, model?: ModelRef, params?: object, avatar?: blob ref}` |
| `prompts` | `{id, title, body: string, tags: string[]}` |
| `providers` | [3.3](#33-provider) |
| `mcp` | `{id, name, transport: 'http' \| 'sse', url, auth: 'none' \| 'oauth' \| 'bearer', enabled: boolean, approvals: object}` |
| `skills` | `{id, name, description, source: object, files?: blob ref, enabled: boolean}` |
| `knowledge` | `{id, name, documents: {blob: blob ref, name, mediaType}[]}` |
| `settings` | not entities: `settingName -> Any`, synced preferences: `defaultModel: ModelRef \| null`, `defaultEffort: Effort \| null`, `defaultSystem: string`... |
| `keyslots` | `slotId -> {label: string, createdAt}`: names the user gave the keyslots; the slots themselves are not in the document |

Every entity also has `createdAt` and `updatedAt`, and the trash fields of [3.1](#31-trash). `order` is a fractional
index string for manual ordering among siblings.

### 3.1 Trash

An entity is never removed from its map by a user action. `deletedAt` (timestamp) moves it to the trash; removing
`deletedAt` restores it. `purgedAt` empties it for good: every field except `id`, `createdAt` and `purgedAt` is
deleted, and for a conversation its messages are deleted from the shard. Ciphertext already synced stays on the store
(FORMAT.md section 14).

### 3.2 Conversation

| Field | Type | Meaning |
|---|---|---|
| `id` | string | conversation id; its shard is derived from it |
| `title` | string | |
| `folder` | string \| null | folder id |
| `persona` | string \| null | persona id it started with |
| `model` | ModelRef \| null | `{provider: providerId, id: modelId}`: the model new turns use |
| `effort` | Effort \| null | the effort new turns use (`'none' \| 'minimal' \| 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'`); `null`: the synced default |
| `leaf` | string \| null | the message id of the active branch's last message |
| `system` | string | the top-level system prompt, frozen when the first message is sent ([5](#5-provider-replay-rules)) |
| `tools` | ToolSnapshot | the tool set declared when the first message is sent ([5](#5-provider-replay-rules)) |
| `pinned` | boolean | |
| `archived` | boolean | hidden from the main list, still searchable; not the trash |
| `startedAt?` | number | when the first message was appended; from then on `system` and `tools` never change |
| `createdAt`, `updatedAt`, `deletedAt?`, `purgedAt?` | number | |

`ToolSnapshot` is `{name, source: 'builtin' | 'mcp' | 'skill', origin?: string, fingerprint: string}[]` sorted by
`name`; `fingerprint` is the base64url SHA-256 of the canonical JSON (FORMAT.md section 3.3) of the tool's definition as
sent to the provider, so a drifted definition is detected before it is used.

### 3.3 Provider

`{id, kind, label, baseUrl?: string, preset?: string, models?: string[], defaultModel?: string, syncKey: boolean,
secret?: string, overrides?: {modelId: object}}`. `kind` names the adapter (`anthropic`, `openai`, `google`,
`mistral`, `openrouter`, `openai-compatible`, `webllm`, `chrome-ai`); a reader keeps a provider of a kind it does not
know and leaves it unusable. `openai-compatible` covers every server speaking OpenAI's chat completions; `preset` names
the one it was set up from (`groq`, `xai`, `deepseek`, `ollama`, `lmstudio`... or `custom`) and `baseUrl` is then
required. `overrides` holds the user's corrections of a model's resolved capabilities (`Capabilities` in
`web/src/core/contracts/ai.ts`), by model id. No API key is ever a
field: `syncKey` says whether the user opted in to syncing the key, and `secret` is then the id of its secret
([6](#6-secrets)). With `syncKey` false the key is a device-only record.

## 4. Conversation shard documents

One top-level `Y.Map` named `messages`, `messageId -> Y.Map`:

| Field | Type | Meaning |
|---|---|---|
| `conv` | string | conversation id |
| `parent` | string \| null | previous message on the branch; `null` for the first |
| `role` | `'user' \| 'assistant' \| 'system' \| 'tool'` | |
| `parts` | Part[] | content, [4.2](#42-parts); immutable once committed |
| `model` | ModelRef \| null | the model that produced an assistant message; `null` otherwise |
| `createdAt` | number | |
| `status` | `'done' \| 'stopped' \| 'error' \| 'refused'` | `stopped`: the user stopped the stream; `error`: it failed; `refused`: the provider declined it (Anthropic `stop_reason: 'refusal'`) |
| `stop?` | string | why an assistant response ended: `'end' \| 'length' \| 'tool-calls' \| 'stop-sequence' \| 'refusal' \| 'content-filter' \| 'pause' \| 'other'` |
| `effort?` | string | the effort the response was requested with |
| `usage?` | object | `{input, output, cacheRead?, cacheWrite?, reasoning?}` token counts as reported; `input` and `output` are totals (cached input and reasoning included) |
| `error?` | object | `{code, message}` for `status: 'error'`; `code` is a `ChatErrorCode` (`web/src/core/contracts/ai.ts`) |
| `refusal?` | object | `{category: string \| null, explanation?: string}` for `status: 'refused'`, from the provider's `stop_details` |
| `deletedAt?` | number | hidden from the branch view; set once, never cleared, never removed while the conversation lives |

### 4.1 The message tree

Messages form a tree through `parent`. The conversation's `leaf` selects one path from the root; the UI shows that
path. Sending a message appends a child of `leaf` and moves `leaf`. Editing a message, or regenerating an answer,
never changes it: it creates a sibling (same `parent`) and moves `leaf` to the new branch. Switching branches only
moves `leaf`, to the most recently created descendant at each level below the chosen sibling. Siblings are ordered by
`createdAt`, then id.

Messages are **immutable**. A response streams in memory; the message is committed to the document once, when it
ends, is stopped (`status: 'stopped'`, with the parts received so far), fails (`status: 'error'`, with the parts
received so far) or is refused (`status: 'refused'`, with no parts: the partial output of a refusal is discarded, as
the provider requires). A lock, a sync or an update never cuts a stream short (the vault's `holdLock`, the PWA's
`holdReload`); a reload mid-stream loses only the uncommitted message, and the user message it answered stays as the
leaf. Committing an answer moves `leaf` to it only if `leaf` is still the message it answers: a branch switch made
during the stream wins. A message sent while an answer streams in the same conversation waits for that answer to be
committed, then becomes a child of the leaf.

The first message of a conversation sets `startedAt`. Deleting a message (`deletedAt`) is final: the branch view
hides it, and the request builder leaves it out under rule 7 of [section 5](#5-provider-replay-rules).

### 4.2 Parts

`parts` is an array of objects tagged by `type`. Unknown members are kept and replayed as they are.

| `type` | Fields |
|---|---|
| `text` | `text: string` |
| `reasoning` | `text: string` (a summary or empty), `providerMeta?: ProviderMeta` |
| `image` | `blob: string` (manifest id), `mediaType: string`, `width: number`, `height: number`, `name?: string` |
| `file` | `blob: string`, `mediaType: string`, `size: number`, `name: string` |
| `tool-call` | `callId: string`, `name: string`, `input: Any`, `providerMeta?: ProviderMeta` |
| `tool-result` | `callId: string`, `name: string`, `output: Any`, `isError?: true`, `parts?: Part[]` (images a tool returned) |
| `source` | `sourceType: 'url' \| 'document'`, `url?: string`, `title?: string`, `citedText?: string`, `documentPart?: number` |
| `artifact` | `artifactId: string`, `kind: 'html' \| 'svg' \| 'mermaid' \| 'react' \| 'code'`, `title: string`, `blob?: string`, `content?: string` |
| `provider` | `provider: string`, `block: Any`: a provider block with no portable meaning (server tool use and results, compaction blocks), replayed verbatim to that provider and ignored by others |
| `ref` | `partType: string`, `blob: string`, `size: number`: a part too large to inline ([4.3](#43-large-parts)) |

`ProviderMeta` is an object keyed by provider kind, `{anthropic?: Any, openai?: Any, ...}`, opaque to everything but
that provider's adapter. For Anthropic it holds what replay needs byte for byte: a `reasoning` part keeps
`{type: 'thinking', signature}` or `{type: 'redacted_thinking', data}`; a `tool-call` part may keep the original
`tool_use` block. Nothing may edit, reformat or drop a `providerMeta` value; it is never shown and never sent to
another provider.

### 4.3 Large parts

A part whose JSON (FORMAT.md section 3.4) exceeds 16 KiB is stored as a blob (`mediaType`
`application/vnd.aparte.part+json`) holding that JSON, and replaced in `parts` by `{type: 'ref', partType, blob,
size}`. Readers load the blob and substitute it before rendering or replay. Images and files are always blobs.

### 4.4 Blob references

A blob reference is the 26-character manifest id (FORMAT.md section 8.6) in a field named `blob`. A segment lists in
its header `blobs` every manifest id its update adds; a writer knows them because it creates the parts. Blobs are
content-addressed and shared: the same photo in two conversations is stored once. Image bytes are prepared once at
attach time (resized, EXIF and other metadata removed) and the stored bytes are the ones sent to providers, so a
replay sends identical bytes.

### 4.5 Local persistence

Until a document's updates are sealed into segments (FORMAT.md section 8.4), they live in the device's `pending`
queue (FORMAT.md section 11.1), one kind-6 envelope per update, under the document's `docId`. Opening a document
applies its queue in order. Every local transaction appends its v2 update; an update is appended only after every
earlier update of the same document was acknowledged, so a later change is never persisted without the one before it.
Updates applied from the queue or received from another device are not appended again. Compacting a queue appends one
merged update first and then drops the positions it covers, so an interruption leaves duplicates, which Yjs ignores,
and never a gap. No plaintext copy of a document exists outside memory.

## 5. Provider replay rules

Some providers bind a model's reasoning to the exact conversation that produced it. Anthropic signs each thinking
block over the conversation prefix (the top-level system prompt, the tool set and every earlier message); replaying a
block after any earlier part of that prefix changed returns an error or drops the reasoning. The data model is
append-only so a conversation's prefix never changes:

1. **Frozen system prompt.** A conversation's `system` is fixed when its first message is sent. A persona or
   system-prompt change later appends a message with `role: 'system'` at the point it takes effect; earlier messages
   are never rewritten.
2. **Snapshotted tools.** The tool set is declared once (`tools` in the conversation) and sent in the same order with
   the same definitions on every turn. Enabling or disabling a tool later appends a `system` message recording the
   change (sent as a mid-conversation tool change where the provider supports it); a tool whose definition drifted is
   refused, not silently re-declared.
3. **Verbatim replay.** `reasoning`, `tool-call` and `provider` parts are replayed in their original order with their
   `providerMeta` unchanged, every turn, including the turn that continues a tool loop. The adapter passes them back
   even after a model switch: the provider drops what the new model cannot read.
4. **No history edits.** Old tool results are never trimmed or rewritten client-side; per-turn reminders are appended,
   never injected into an earlier message and removed. Trimming long histories uses the provider's server-side
   compaction or context editing, whose blocks are kept as `provider` parts.
5. **Branches are separate prefixes.** Editing creates a sibling, so each branch is its own append-only history and
   its reasoning stays valid for it.
6. **Stable bytes.** Images and documents are sent from blobs, as the same bytes on every turn.

The request for a turn is a function of `system`, `tools`, the committed messages of the path and the target model
(`planPrompt` in `web/src/core/contracts/chat.ts`), so the same path always gives the same request and a new turn only
appends to it:

7. **Left out, always the same way.** Assistant messages with status `error` or `refused` and deleted messages are
   never sent. A message created before a deleted message that precedes it on the path was deleted loses its
   `reasoning` parts on every later turn: they were signed over a prefix that no longer exists (text and tool calls
   stay). A `stopped` message loses its `tool-call` parts, which never ran.
8. **Own provider only.** A `reasoning` part is sent only when its `providerMeta` has an entry for the target
   provider's kind, and a `provider` part only to its `provider`; reasoning text from another provider is never sent.
   Within a provider, a model switch replays everything and the provider drops what the new model cannot read.
9. **No prefill.** A request never ends with an assistant message: regenerating sends the path up to the answer's
   parent, and "continue" is a new user message.
10. **System messages degrade deterministically.** A `role: 'system'` message is sent as a mid-conversation system
    message to a model that supports them, and otherwise as a user message holding only
    `<system-update>\n…\n</system-update>`. An image sent to a model without vision becomes the text
    `[image omitted: <name>]`, a PDF sent to a model without PDF input `[document omitted: <name>]`.
11. **Explicit effort, allowed parameters only.** Every turn to a model that takes effort sends a level explicitly; no
    request carries a sampling parameter, a forced tool choice or an effort the model's capabilities do not allow.

## 6. Secrets

Secrets never enter a Yjs document. They are of two kinds.

**Device-only** (local records, FORMAT.md section 11.3, never synced):

| Purpose | Content |
|---|---|
| `sync-credential` | credentials of a sync destination (a GitHub token, S3 keys) |
| `oauth-token` | OAuth tokens: MCP servers, Dropbox, OneDrive, GitLab |
| `provider-key` | an API key, under the provider id: the UTF-8 JSON `{"kind": "api-key", "provider": "<providerId>", "key": "<the key>"}` |
| `device` | the `deviceId` |

The Secret Key is also device-only, in `meta`, wrapped by the device key (FORMAT.md section 11.2). Sync credentials
and the Secret Key reach another device only by pairing (QR or code), never through the store.

**Synced on opt-in**: an API key the user chose to sync (`providers.syncKey`) is a secret, stored as secret versions
(FORMAT.md sections 8.7 and 9.5), last-writer-wins by `hlc`. Its `value` is:

```json
{"kind": "api-key", "provider": "<providerId>", "key": "<the key>"}
```

Deleting it writes a version with `deleted: true` and no `value`. Each device keeps the newest value it has seen in a
`provider-key` record, so a provider works offline.

## 7. Device-only versus synced

| Data | Where | Synced |
|---|---|---|
| conversations, messages, folders, personas, prompts, settings, keyslot labels | Yjs documents | yes |
| provider and MCP configuration (no secret) | index document | yes |
| photos, files, artifacts, large parts | blobs | yes |
| API keys with `syncKey` | secret versions | yes, on opt-in |
| keyslots | `keys/*.json`, `meta` | yes (plaintext, by design) |
| API keys without `syncKey`, OAuth tokens, sync credentials | local records | no |
| `deviceId`, high-water marks, drafts, pending updates | local records | no |
| Secret Key | `meta`, wrapped | no (pairing only) |
| theme and other UI preferences | `localStorage` | no |
| unlocked keys | memory, non-extractable `CryptoKey` | no; dropped at lock |
