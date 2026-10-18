# Data model `aparte/1`

**Status: frozen** with [FORMAT.md](FORMAT.md) since milestone M3. This document describes what the encrypted
documents of a vault contain; FORMAT.md describes how they are encrypted, named and stored. A change that an older
build would misread needs a new format version.

## 1. Documents

A vault holds 17 Yjs documents, each synced as its own stream of segments and checkpoints (FORMAT.md section 8.4):

| `docId` | Content | Loaded |
|---|---|---|
| `index` | everything except messages: conversation list, folders, personas, prompts, provider and MCP configuration, skills, knowledge, settings, tool approvals | at unlock |
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
| `mcp` | [3.5](#35-mcp-server) |
| `skills` | `{id, name, description, source: object, files?: blob ref, enabled: boolean}` |
| `knowledge` | [3.7](#37-knowledge-bases): `{id, name, documents: {blob: blob ref, name, mediaType, size?, index?: blob ref, chunks?, addedAt?}[], embedder: EmbedderRef \| null}` |
| `settings` | not entities: `settingName -> Any`, synced preferences: `defaultModel: ModelRef \| null`, `defaultEffort: Effort \| null`, `defaultSystem: string`... |
| `toolApprovals` | not entities: `approvalKey -> Any`, the tool approvals that outlive a call ([3.4](#34-tool-approvals)) |
| `keyslots` | `slotId -> {label: string, createdAt}`: names the user gave the keyslots; the slots themselves are not in the document |

Every entity also has `createdAt` and `updatedAt`, and the trash fields of [3.1](#31-trash). `order` is a fractional
index string for manual ordering among siblings. The maps added after the freeze (characters in `personas`, lorebooks,
quick replies, regex rules, per-chat options and Arena votes) are in [3.6](#36-collections-added-after-the-freeze).

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
| `knowledge?` | string[] | the knowledge bases attached to the chat ([3.7](#37-knowledge-bases)); may change at any time, since their passages travel in user messages; absent: none |
| `createdAt`, `updatedAt`, `deletedAt?`, `purgedAt?` | number | |

`ToolSnapshot` is `{name, source: 'builtin' | 'mcp' | 'skill' | 'sandbox' | 'provider', origin?: string, fingerprint:
string}[]` sorted by `name`. Each entry names one tool of the registry ([8](#8-tools)) by `name`, `source` and `origin`
(the MCP server, skill or sandbox that provides it; absent for built-ins), and `fingerprint` is the tool's fingerprint
([8.2](#82-identity-and-fingerprint)), so a drifted definition is detected before it is used. The entry of source
`provider` is the provider's own web search, named `web_search`, whose fingerprint is the constant fingerprint of
`{"name":"web_search","provider":true}`. The snapshot may be edited until the first message; the commit of that message
refreshes its fingerprints from the registry (dropping names the registry no longer has), and from then on it never
changes.

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

### 3.4 Tool approvals

The `toolApprovals` map holds the approvals the user gave beyond one call ([8.3](#83-approvals)), one key per approval so
two devices granting different tools never overwrite each other:

| Key | Value |
|---|---|
| `always\|<approvalKey>` | `{approvalKey, fingerprint, conversation: null, grantedAt}`: the tool may run in every conversation |
| `conversation\|<conversationId>\|<approvalKey>` | `{approvalKey, fingerprint, conversation, grantedAt}`: the tool may run in that conversation |

An approval holds only while the tool's current fingerprint equals `fingerprint`. Granting again replaces the value
(last writer wins); revoking deletes the key. These are not entities and have no trash.

### 3.5 MCP server

| Field | Type | Meaning |
|---|---|---|
| `id` | string | server id; the `origin` of its tools ([8.1](#81-definition)) |
| `name` | string | what the interface calls it |
| `prefix` | string | `^[a-z][a-z0-9]{0,15}$`, unique among the servers that are not trashed, fixed at creation: the server's tools are registered as `<prefix>__<tool>` (characters outside `[A-Za-z0-9_-]` become `_`; a name longer than 64 characters or taken by another tool of the server ends with a short hash of the MCP name instead) |
| `transport` | `'http' \| 'sse'` | Streamable HTTP, or the legacy HTTP+SSE transport |
| `url` | string | the endpoint: https (http on the loopback only), without credentials, query or fragment |
| `auth` | `'none' \| 'oauth' \| 'bearer' \| 'headers'` | how the app authenticates; the secret itself is a device-only record ([6](#6-secrets)) |
| `enabled` | boolean | off: never contacted, no tool offered |
| `tools` | `{name, enabled: boolean, fingerprint}[]` sorted by `name` | the user's choice per tool of the server, by its MCP name, with the fingerprint ([8.2](#82-identity-and-fingerprint)) of the definition the user accepted |
| `createdAt`, `updatedAt`, `deletedAt?` | number | |

A tool is offered only when its entry is `enabled` and its live definition has the entry's `fingerprint`; a tool
whose definition changed is held back until the user accepts it again (which writes the new fingerprint), and a tool
without an entry is new and off. The first listing of a server just added writes an entry for every tool, enabled.
`tools` is replaced as a whole (last writer wins). No field holds a secret: a value shaped like a key or token is
refused.

### 3.6 Collections added after the freeze

These top-level maps of the index were added in milestone M9. They follow the entity rules above (`id`, `createdAt`,
`updatedAt`, the trash fields of [3.1](#31-trash)); a reader that does not know a map ignores it, and a reader keeps
fields of an entity it does not know, so no earlier build misreads a vault that has them. Field names never contain
`key`, `token`, `secret`, `password`, `auth` or `credential`, and no value is a secret (section 6). The TypeScript
shapes are in `web/src/core/contracts/extras.ts`.

| Map | Entity |
|---|---|
| `personas` | the map of section 3, holding characters: `{name, systemPrompt, description?, personality?, scenario?, firstMessage?, alternateGreetings?: string[], examples?, creator?, creatorNotes?, tags?: string[], lorebook?: lorebookId, avatar?: blob ref, source?: 'card-v2' \| 'card-v3' \| 'manual', model?: ModelRef}` |
| `lorebooks` | `{name, description?, entries: {triggers: string[], secondary?: string[], content, enabled, constant?, caseSensitive?, wholeWord?, order: number, comment?}[], scanDepth: number, budget: number}` (`budget` in characters; `entries` is replaced as a whole) |
| `quickReplies` | `{label, text, order: string}` |
| `regexRules` | `{name, find, flags, replace, placement: 'input' \| 'display', enabled}`: `input` rules rewrite text before it is committed, `display` rules change only what is shown |
| `chatOptions` | per conversation, under the conversation's own id: `{character?: personaId, userName?, lorebooks?: lorebookId[], note?, noteEvery?: number}` (`note` is the Author's Note) |
| `arenaVotes` | `{a: ModelRef, b: ModelRef, winner: 'a' \| 'b' \| 'tie' \| 'bad', conversation}`; ratings are recomputed from the votes in `createdAt`, then id, order and never stored |

None of them rewrites a conversation. What a character, a lorebook or the Author's Note adds to a turn is committed in
the user message it goes with, as `text` parts carrying `injected: 'lorebook' | 'authors-note' | 'character'` (an
extra member, replayed as text; the interface does not show it as the user's words). A character chosen after the
first message is a `system` message (section 5, rule 1). A Beam or Arena answer is an ordinary assistant sibling; an
answer merged from others keeps only its `text` and `source` parts, since it was produced over a request that is not
the stored path.

### 3.7 Knowledge bases

A knowledge base names documents the user added; their content is only in blobs. Each entry of `documents` is
`{blob, name, mediaType, size?, index?, chunks?, addedAt?}`: `blob` the original file (as added, of media type
`application/pdf`, the Word or PowerPoint Open XML type, `text/html`, `text/markdown` or `text/plain`), `index` the
blob of its search index, `chunks` the number of passages in it. `documents` is one value replaced as a whole (last
writer wins): two devices adding a document at the same time may keep only one of them. Adding a document with the
same `blob` replaces its entry.

`embedder` says which model embeds the passages: `{kind: 'local', model}` (the pinned on-device sentence-embedding
model, by repository), `{kind: 'provider', provider: providerId, model}` (that provider's embeddings API, with the key
of the device that embeds), or `null` (keywords only).

The index blob (media type `application/vnd.aparte.knowledge-index+json`) is UTF-8 JSON:

```json
{"v": 1, "format": "pdf", "embedder": "local:<repository>@<commit>", "dim": 384,
 "chunks": [{"text": "...", "page": 3, "heading": "..."}], "vectors": "<base64url>"}
```

`format` is `pdf`, `docx`, `pptx`, `html`, `markdown` or `text`; `page` is the 1-based page or slide; `vectors` holds
`chunks.length * dim` little-endian float32 values, one unit-length row per chunk, and `embedder` names the model they
come from (`provider:<providerId>:<model>` for an API). Both are `null` (and `dim` is 0) for a document indexed for
keywords only. Vectors of two different `embedder` values are never compared; a document whose `embedder` is not its
base's current one is searched by keywords until it is indexed again.

A passage is named `<the first 6 characters of the document's blob id>-<1-based chunk number>`: the id a model cites.

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
| `tool-result` | `callId: string`, `name: string`, `output: Any` (what the model reads), `isError?: true`, `parts?: Part[]` (images a tool returned), `details?: Any` (what the interface shows beside it, never sent; `{notRun: reason}` for a call that did not run, [8.4](#84-the-agent-loop)) |
| `source` | `sourceType: 'url' \| 'document'`, `url?: string`, `title?: string`, `citedText?: string`, `documentPart?: number` |
| `artifact` | `artifactId: string`, `kind: 'html' \| 'svg' \| 'mermaid' \| 'react' \| 'code'`, `title: string`, `blob?: string`, `content?: string` |
| `provider` | `provider: string`, `block: Any`: a provider block with no portable meaning (server tool use and results, compaction blocks), replayed verbatim to that provider and ignored by others. Anthropic's web search is kept in Anthropic's own wire shape: `{type: 'server_tool_use', id, name: 'web_search', input}` and `{type: 'web_search_tool_result', tool_use_id, content}` (`content` the list of `{type: 'web_search_result', url, title, page_age, encrypted_content}`, or `{type: 'web_search_tool_result_error', error_code}`) |
| `ref` | `partType: string`, `blob: string`, `size: number`: a part too large to inline ([4.3](#43-large-parts)) |
| `knowledge` | `query: string`, `passages: {id, base, document, blob, page?, heading?, text}[]`: the passages of the chat's knowledge bases retrieved for this user message ([3.7](#37-knowledge-bases)); sent in that user turn as one delimited text block (`web/src/core/knowledge/context.ts`), never in the system prompt, and left out of any other message |

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

A blob reference is the 26-character manifest id (FORMAT.md section 8.6) in a field named `blob` (and in the
`index` of a knowledge base document, [3.7](#37-knowledge-bases)). A segment lists in its header `blobs` every
manifest id its update adds; a writer knows them because it creates the parts. Blobs are
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
   its reasoning stays valid for it. A tool round is part of its branch: regenerating the answer after a round is a
   sibling of that answer, under the same results.
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
    Tools are declared with the provider's default choice (`auto`); a schema that allows it is declared `strict` to
    Anthropic and OpenAI. A model whose capabilities say it takes no tools gets none, on every turn alike.
12. **Every call answered, in place.** A `role: 'tool'` message carries only the results of the calls of the answer
    right before it, the first result of each call; a result of any other call is never sent. A call of that answer
    with no result there gets the fixed error result `Not run: the app closed before this tool ran.` (`details:
    {notRun: 'interrupted'}`), in the tool message that follows or in one inserted right after the answer. The request
    is therefore always one the provider accepts, and the rule only looks back, so appending still only appends.
13. **Declared as frozen.** Each turn declares, in snapshot order, the snapshot's tools whose registered fingerprint
    still equals the snapshot's, then the web search when the snapshot has it and the model has one. A drifted or
    vanished tool is left out of every later turn and a call to it is refused, never silently re-declared.

## 6. Secrets

Secrets never enter a Yjs document. They are of two kinds.

**Device-only** (local records, FORMAT.md section 11.3, never synced):

| Purpose | Content |
|---|---|
| `sync-credential` | credentials of a sync destination (a GitHub token, S3 keys) |
| `oauth-token` | OAuth tokens: MCP servers, Dropbox, OneDrive, GitLab. For an MCP server, the id is `mcp:<serverId>` and the value the UTF-8 JSON `{"kind": "mcp-auth", "server": "<serverId>", "auth": ...}`, where `auth` is `{"kind": "bearer", "token"}`, `{"kind": "headers", "headers": {name: value}}` or `{"kind": "oauth", "client": {clientId, clientSecret?, tokenAuth, issuer, authorizationEndpoint, tokenEndpoint, issParameter, resource?, scope?, redirectUri}, "tokens"?: {accessToken, tokenType, refreshToken?, expiresAt?, scope?}}` |
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
| tool snapshots, tool approvals | index document | yes |
| photos, files, artifacts, large parts | blobs | yes |
| API keys with `syncKey` | secret versions | yes, on opt-in |
| keyslots | `keys/*.json`, `meta` | yes (plaintext, by design) |
| API keys without `syncKey`, OAuth tokens, sync credentials | local records | no |
| `deviceId`, high-water marks, drafts, pending updates | local records | no |
| Secret Key | `meta`, wrapped | no (pairing only) |
| theme and other UI preferences | `localStorage` | no |
| unlocked keys | memory, non-extractable `CryptoKey` | no; dropped at lock |

## 8. Tools

The contract of the tools is `web/src/core/contracts/tools.ts` (F6). Every source plugs into it: built-in tools,
MCP servers, skills, the sandboxes' `run_js` and `run_python`, and the knowledge base's `search_knowledge`.

### 8.1 Definition

| Field | Meaning |
|---|---|
| `name` | `^[A-Za-z0-9_-]{1,64}$`, unique in the registry; `web_search` is reserved for the provider's own search |
| `title?` | what the interface calls it; never sent |
| `description` | what the model reads |
| `inputSchema` | a JSON Schema of `type: 'object'` |
| `annotations` | `{readOnly, destructive, openWorld}` booleans, MCP's tool annotations: it only reads; it may delete or overwrite; it reaches beyond this device |
| `source` | `builtin`, `mcp`, `skill` or `sandbox` |
| `origin?` | the MCP server, skill or sandbox that provides it |
| `autoApprove?` | the tool may run without asking; honoured only for a `builtin` that is read-only, not destructive and not open-world |

Running a tool returns `{content, details?, isError?}`: `content` is what the model reads (text, JSON values, images),
`details` what the interface shows beside it. A failure is a result with `isError`, never an exception.

### 8.2 Identity and fingerprint

A tool's **approval key** is `<source>:<origin>:<name>`, with `-` for no origin; it names the tool across versions. Its
**fingerprint** is the base64url (FORMAT.md section 3.2) SHA-256 of the RFC 8785 canonical JSON of `{name, description,
inputSchema, annotations}` (`annotations` with exactly its three booleans): any change of what the model reads or of
what decides approval is a new fingerprint. Canonical JSON here is the full RFC 8785 (finite numbers in ECMAScript
form), of which FORMAT.md section 3.3 uses the integer-only subset.

### 8.3 Approvals

A call runs only when its tool is declared in the conversation ([5](#5-provider-replay-rules), rule 13), and then:
without asking for an auto-approved built-in; with a stored approval of its current fingerprint, for the conversation
then "always" ([3.4](#34-tool-approvals)); otherwise after the user answers, with the arguments shown in full. The user
allows the call once, for the conversation, or always (the two last are stored), or declines it. A declined call gets
the error result `The user declined to run this tool.`.

### 8.4 The agent loop

A turn makes at most `stepBudget(effort)` model calls: `none` and `minimal` 2, `low` 4, `medium` 8, `high` 16, `xhigh`
24, `max` 32, and 8 for a model that takes no effort. An answer committed with `status: 'done'` and `tool-call` parts
starts a round: each call, in order, is decided ([8.3](#83-approvals)) and run, and the results are committed as one
`role: 'tool'` message, child of the answer, one `tool-result` part per call in call order. The next answer streams
as a child of that message. A call that does not run gets an error result and `details: {notRun: reason}`, with
reason `denied`, `stopped` (the user stopped the turn or the vault locked), `budget` (the last allowed call ended with
calls), `undeclared`, `drifted`, `missing` or `interrupted`. Provider-executed calls (the web search) are not rounds:
they are `provider` parts of the answer ([4.2](#42-parts)), and their sources are `source` parts.

