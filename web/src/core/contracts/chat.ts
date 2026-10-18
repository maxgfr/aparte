/*
 * Contract of the chat: turning a conversation path into a provider request that keeps the history append-only, and
 * the controller that streams a response into memory and commits it once. Implemented by
 * web/src/core/chat/request.ts (RequestModule, pure) and web/src/core/chat/controller.ts (ControllerModule).
 *
 * Invariants:
 * - A request is a function of the conversation's frozen `system`, its frozen `tools`, the committed messages of the
 *   path and the target model: the same path sent to the same model gives the same request, and appending a turn only
 *   appends to it (spec/DATA-MODEL.md section 5). Nothing earlier is rewritten, reordered or trimmed client-side.
 * - A request never ends with an assistant message (no prefill): regenerating sends the path up to the parent of the
 *   answer, and "continue" is a new user turn.
 * - A response streams in memory only. The assistant message is committed once, when the stream finishes (`done`),
 *   is stopped (`stopped`, with the parts received so far), fails (`error`) or is refused (`refused`, with no parts:
 *   a refusal's partial output is discarded). A reload mid-stream loses only that uncommitted message.
 * - While a stream runs, the controller holds the vault lock (`holdLock`) and the PWA reload (`holdReload`), both
 *   with the reason `chat-stream`, one hold per stream. Both are released once the message is committed and the
 *   workspace has flushed (or failed to), never before.
 * - Nothing is written for a turn that cannot start (no model, no key, an unknown provider): `send` rejects first.
 * - A turn is an agent loop of at most `stepBudget(effort)` model calls. An answer that ends with tool calls
 *   (`stop: 'tool-calls'`) is committed, its calls are approved (contracts/tools.ts) and run, their results are
 *   committed as one `role: 'tool'` message (one `tool-result` part per call, in call order, an error result for a call
 *   that did not run), and the next answer streams as its child. Every call gets a result, so the history is always a
 *   valid request; nothing earlier is rewritten. `Turn.done` resolves with the last answer.
 * - The tool set is the conversation's snapshot (`tools`), chosen before the first message and frozen by it: the
 *   first `send` refreshes the snapshot's fingerprints from the registry (dropping names it no longer has) in the same
 *   write that commits the first message, and from then on it never changes. Each turn declares the snapshot's tools
 *   that have not drifted (`ToolRegistry.resolve`).
 */

import type { Capabilities, ChatAdapter, Effort, ModelDescriptor, ProviderKeys, ProviderKind, Usage } from './ai.ts'
import type { Rng } from './crypto.ts'
import type { ApprovalDecision, ToolAnnotations, ToolApprovals, ToolRegistry, ToolSource } from './tools.ts'
import type { Clock } from './vault.ts'
import type { BlobPort, Conversation, Id, Message, ModelRef, Part, Role, Settings, Workspace } from './workspace.ts'

// Request planning (pure)

/** A message of the plan: committed parts, blob references not yet resolved to bytes. */
export interface PlannedMessage {
  readonly role: Role
  readonly parts: readonly Part[]
  /** The committed message it comes from. */
  readonly from: Id
}

export interface PromptPlan {
  /** The conversation's `system`, as frozen. */
  readonly system: string
  readonly messages: readonly PlannedMessage[]
}

export interface PlanInput {
  readonly conversation: Conversation
  /** `thread.path(...)` up to and including the last message to send, `ref` parts already substituted. */
  readonly path: readonly Message[]
  readonly kind: ProviderKind
  readonly capabilities: Capabilities
}

export interface RequestModule {
  /**
   * The messages a path sends, by these rules, in this order (spec/DATA-MODEL.md section 5):
   * 1. Assistant messages with status `error` or `refused` are left out, and so are deleted messages.
   * 2. A message created before a deleted message of the path that precedes it was deleted (`createdAt <=
   *    deletedAt`) loses its `reasoning` parts: its reasoning was signed over a prefix that no longer exists. Text,
   *    tool calls and other parts stay.
   * 3. A `reasoning` part is sent only with a `providerMeta` entry for `kind`; a `provider` part only when its
   *    `provider` is `kind`. Everything else is left out of the request (never shown to another provider).
   * 4. A `stopped` assistant message loses its `tool-call` parts (they never ran); a message left with no part is
   *    left out.
   * 5. A `role: 'system'` message stays a system message when `capabilities.midConversationSystem`; otherwise it
   *    becomes a user message whose only part is the text `<system-update>\n${text}\n</system-update>`.
   * 6. Without `capabilities.vision`, an image part becomes the text part `[image omitted: ${name ?? 'image'}]`;
   *    without `capabilities.pdf`, an `application/pdf` file part becomes `[document omitted: ${name}]`.
   *    A `knowledge` part of a user message becomes the text part `knowledgeText(part)` (core/knowledge/context.ts):
   *    the retrieved passages between their delimiters; anywhere else it is left out.
   * 7. A `role: 'tool'` message keeps only the `tool-result` parts that answer a `tool-call` of the planned message right
   *    before it (the first result of each call, in stored order); with nothing left it is left out.
   * 8. A `tool-call` of a planned assistant message that has no result there gets the fixed error result
   *    `unansweredResult(call, 'interrupted')` (contracts/tools.ts), appended to the tool message that follows, or in a
   *    tool message inserted right after it when the next message is not one.
   * InvalidStateError when the result is empty or ends with an assistant message.
   */
  planPrompt(input: PlanInput): PromptPlan
  /**
   * The effort a turn is sent with: the conversation's, else the synced default, else the model's default; when the
   * model does not take that level, the highest accepted level below it, else its lowest level. Null when the model
   * takes no effort.
   */
  pickEffort(
    conversation: Pick<Conversation, 'effort'>,
    settings: Pick<Settings, 'defaultEffort'>,
    capabilities: Capabilities,
  ): Effort | null
  /** A title from the first user message: its first non-empty line, whitespace collapsed, at most 60 characters (an ellipsis replaces the rest). */
  titleFrom(parts: readonly Part[]): string
  /** Parts whose JSON (spec/FORMAT.md section 3.4) is longer than this many bytes are stored as blobs (`ref` parts). */
  readonly LARGE_PART_BYTES: 16384
}

// Controller

/** One tool call of the round the controller is running. */
export interface ToolCallState {
  readonly callId: string
  readonly name: string
  /** The arguments as the model wrote them: untrusted, shown in full before approval. */
  readonly input: unknown
  readonly title: string
  readonly source: ToolSource | null
  readonly origin?: string
  readonly annotations: ToolAnnotations | null
  /**
   * `approval`: waiting for the user; `running`; `done` or `failed` once it returned; `denied` by the user; `refused`
   * because the conversation does not declare it (or its definition changed); `skipped` when the turn stopped first.
   */
  readonly status: 'approval' | 'running' | 'done' | 'failed' | 'denied' | 'refused' | 'skipped'
}

/** A response streaming in memory. */
export interface StreamState {
  readonly conversationId: Id
  /** The id the assistant message will be committed under. */
  readonly messageId: Id
  readonly parentId: Id
  readonly model: ModelRef
  readonly effort: Effort | null
  /** Parts received so far, in arrival order; a reasoning or text part grows as deltas arrive. */
  readonly parts: readonly Part[]
  readonly usage?: Usage
  readonly startedAt: number
  /** User messages sent during this stream, waiting for it to commit. */
  readonly queued: number
  /** Model calls of this turn so far, this one included (1 for a turn without tools). */
  readonly step: number
  /**
   * `model` while the model answers (`messageId` streams); `tools` while the calls of the committed answer `parentId`
   * are approved and run (`messageId` is the id the next answer will take).
   */
  readonly phase: 'model' | 'tools'
  /** The calls of the current tool round, in the order the model made them; empty in the `model` phase. */
  readonly tools: readonly ToolCallState[]
}

/** A turn that was started or queued. */
export interface Turn {
  /** The user message of the turn (null for a regeneration, which adds none); allocated even while queued. */
  readonly userMessageId: Id | null
  /** Resolves with the committed assistant message, or null when a queued turn was cancelled before it started. */
  readonly done: Promise<Message | null>
}

export type ChatEventName = 'stream' | 'commit'

export interface ChatDeps {
  readonly workspace: Workspace
  /** The vault's `holdLock` (web/src/core/contracts/vault.ts); InvalidStateError while locking. */
  readonly holdLock: (reason: string) => () => void
  /** web/src/pwa/register.ts `holdReload`. */
  readonly holdReload: (reason: string) => () => void
  readonly adapter: (kind: ProviderKind) => ChatAdapter
  readonly keys: ProviderKeys
  /** The model descriptor for a reference (provider config, catalog, capabilities), or null when unknown. */
  readonly resolveModel: (ref: ModelRef) => ModelDescriptor | null
  readonly blobs: BlobPort
  readonly rng: Rng
  readonly clock: Clock
  /**
   * The tools turns may declare and run, and the stored approvals. Without it no tool is declared, and a call the
   * model makes anyway gets an error result.
   */
  readonly tools?: { readonly registry: ToolRegistry; readonly approvals: ToolApprovals }
}

export interface ChatController {
  /**
   * Appends a user message as a child of the leaf, moves the leaf to it and streams the answer. During a stream in
   * the same conversation, the message is queued and sent (as a child of the leaf then) once the stream commits.
   * Rejects, having written nothing, with InvalidStateError when the conversation has no model or the vault is
   * locking, and InvalidInputError when the model is unknown, the provider needs a key and none is stored, or
   * `parts` is empty.
   */
  send(conversationId: Id, parts: readonly Part[]): Promise<Turn>
  /**
   * Streams a new answer as a sibling of `messageId` (an assistant message) or as a new child of it (a user message),
   * with the conversation's current model and effort. InvalidStateError while a stream runs in that conversation.
   */
  regenerate(conversationId: Id, messageId: Id): Promise<Turn>
  /** Creates a sibling of user message `messageId` with `parts`, moves the leaf to it and streams the answer. */
  edit(conversationId: Id, messageId: Id, parts: readonly Part[]): Promise<Turn>
  /**
   * Appends a committed `role: 'system'` message (a persona or system prompt change) as a child of the leaf and moves
   * the leaf to it. Before the first message it updates `system` instead and returns null.
   */
  appendSystem(conversationId: Id, text: string): Promise<Id | null>
  /**
   * Answers the approval request of call `callId` in the conversation's current tool round. `conversation` and
   * `always` decisions are stored for the tool's current fingerprint. InvalidStateError when no such call waits.
   */
  approve(conversationId: Id, callId: string, decision: ApprovalDecision): void
  /**
   * Stops the conversation's stream (committed as `stopped`) and cancels its queued turns. During a tool round, the
   * calls not yet answered get an error result (`stopped`) so the history stays valid. No-op without a stream.
   */
  stop(conversationId: Id): void
  /** The conversation's stream, or null. */
  stream(conversationId: Id): StreamState | null
  /** Conversations with a stream running. */
  streaming(): readonly Id[]
  /** Calls `fn` on every stream change and every commit; returns the unsubscribe function. */
  subscribe(fn: (event: ChatEventName, conversationId: Id) => void): () => void
  /** Stops every stream (each committed as `stopped`), for the vault's `onLock`. Resolves once all are committed. */
  dispose(): Promise<void>
}

export interface ControllerModule {
  createChatController(deps: ChatDeps): ChatController
}
