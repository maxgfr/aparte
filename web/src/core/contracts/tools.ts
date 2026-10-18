/*
 * Contract of the tools (F6): what a tool declares, how it is identified, fingerprinted and approved, what running it
 * returns, and the registry the chat reads its tools from. Every tool source plugs in here: the built-in tools
 * (web/src/core/tools/builtins.ts), MCP servers (M5b), skills (M5c), the sandboxes' `run_js` and `run_python` (M6) and
 * the knowledge base's `search_knowledge` (M7). Implemented by web/src/core/tools/*.ts:
 *
 *   fingerprint.ts  fingerprintOf, approvalKeyOf, canonicalJson         (FingerprintModule)
 *   registry.ts     createToolRegistry                                  (RegistryModule)
 *   policy.ts       decideApproval, recordDecision                      (PolicyModule)
 *   loop.ts         stepBudget, resultPart, unansweredResult            (LoopModule)
 *
 * Invariants:
 * - A tool is known by its approval key, `<source>:<origin>:<name>` (origin `-` when it has none): the key stays the
 *   same when the definition changes. Its fingerprint is the base64url SHA-256 of the canonical JSON (RFC 8785) of
 *   `{name, description, inputSchema, annotations}`: any change of what the model reads or of what decides approval
 *   gives a new fingerprint.
 * - A conversation's tool set is its frozen snapshot (spec/DATA-MODEL.md section 3.2): every turn declares the
 *   snapshot's tools whose registered fingerprint still equals the snapshot's, in the snapshot's order. A tool that
 *   drifted (same key, new fingerprint) or disappeared is never declared again in that conversation and a call to it
 *   is refused: it is never silently re-declared.
 * - An approval holds for one fingerprint only. "Always" and "for this conversation" approvals are stored encrypted
 *   in the workspace index (`toolApprovals`, spec/DATA-MODEL.md section 3.4); a changed definition asks again.
 * - Nothing runs without approval except a built-in tool that declares `autoApprove` and is read-only, not
 *   destructive and not open-world. Every MCP, skill and sandbox tool, and every tool that reaches the network or
 *   changes anything, asks until the user approves it.
 * - Tool input comes from the model and tool output from the world: both are untrusted. Arguments are shown in full
 *   before approval, as text; results are rendered as text and never followed as instructions by the app.
 * - A tool reaches the network only through web/src/security/net.ts (purpose `tool`, or `mcp` for MCP servers).
 */

import type { Effort } from './ai.ts'
import type { Bytes, JsonValue } from './crypto.ts'
import type { Id, Part } from './workspace.ts'

/** Where a tool comes from. Provider-native tools (web search) are not tools of the registry (see `WEB_SEARCH`). */
export type ToolSource = 'builtin' | 'mcp' | 'skill' | 'sandbox'

/**
 * What a tool does to the world, as MCP's tool annotations say it (`readOnlyHint`, `destructiveHint`,
 * `openWorldHint`). For an MCP tool they are the server's claim; they decide how often the app asks, never whether a
 * tool may skip asking when it is not a built-in.
 */
export interface ToolAnnotations {
  /** It only reads; it changes nothing anywhere. */
  readonly readOnly: boolean
  /** It may delete or overwrite something. */
  readonly destructive: boolean
  /** It reaches beyond this device: the network, another service, other people. */
  readonly openWorld: boolean
}

/** A JSON Schema of `type: 'object'`: the input a tool takes. */
export type InputSchema = { readonly type: 'object' } & { readonly [key: string]: JsonValue }

/** What a tool declares. Everything but `title`, `source`, `origin` and `autoApprove` is fingerprinted. */
export interface ToolSpec {
  /** `^[A-Za-z0-9_-]{1,64}$`, unique in the registry; `web_search` is reserved for the provider's own search. */
  readonly name: string
  /** What the interface calls it; defaults to `name`. Never sent. */
  readonly title?: string
  /** What the model reads to decide when to call it. */
  readonly description: string
  readonly inputSchema: InputSchema
  readonly annotations: ToolAnnotations
  readonly source: ToolSource
  /** Which server, skill or sandbox provides it (an MCP server id, a skill id...); absent for built-ins. */
  readonly origin?: string
  /**
   * The tool may run without asking. Honoured only for a `builtin` that is read-only, not destructive and not
   * open-world; ignored otherwise.
   */
  readonly autoApprove?: boolean
}

/** One piece of what a tool returns to the model. */
export type ToolContent =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'json'; readonly value: JsonValue }
  /** Stored as an image blob; sent to models that read images in tool results (from M6 on). */
  | { readonly type: 'image'; readonly data: Bytes; readonly mediaType: string }

export interface ToolResult {
  /** What the model reads, in order. */
  readonly content: readonly ToolContent[]
  /** What the interface may show beside it (a status, a URL fetched, counts); never sent to the model. */
  readonly details?: JsonValue
  /** The call failed; `content` says why, for the model. */
  readonly isError?: boolean
}

export interface ToolContext {
  readonly conversationId: Id
  readonly callId: string
  /** Aborted when the user stops the turn or the vault locks; a tool stops its work then. */
  readonly signal: AbortSignal
}

/** A tool the registry can run. `execute` rejects only on abort; every other failure is a result with `isError`. */
export interface Tool extends ToolSpec {
  execute(input: unknown, context: ToolContext): Promise<ToolResult>
}

/** A tool once registered: its spec, its identity and its fingerprint. */
export interface RegisteredTool {
  readonly tool: Tool
  readonly approvalKey: string
  readonly fingerprint: string
}

/** The provider's own web search, toggled per conversation as a snapshot entry of source `provider`. */
export const WEB_SEARCH = 'web_search' as const

/**
 * The snapshot's tools as a turn may declare them, after drift detection: `declared` in snapshot order, `webSearch`
 * when the snapshot has the provider entry, and the names left out because their definition changed (`drifted`) or
 * their tool is gone (`missing`).
 */
export interface ResolvedTools {
  readonly declared: readonly RegisteredTool[]
  readonly webSearch: boolean
  readonly drifted: readonly string[]
  readonly missing: readonly string[]
}

export interface ToolRegistry {
  /** Registered tools, by name. */
  list(): readonly RegisteredTool[]
  get(name: string): RegisteredTool | undefined
  /**
   * Adds a tool, fingerprinting its definition. InvalidInputError for a malformed spec, a reserved or duplicate name,
   * or an input schema that is not an object schema.
   */
  register(tool: Tool): Promise<RegisteredTool>
  unregister(name: string): void
  /**
   * The snapshot of these tools as a conversation freezes it (spec/DATA-MODEL.md section 3.2): one entry per
   * registered name, plus the `web_search` provider entry when asked, sorted by name. Unknown names are skipped.
   */
  snapshot(names: readonly string[], options?: { readonly webSearch?: boolean }): Promise<readonly SnapshotEntry[]>
  /** Drift detection of a frozen snapshot against what is registered now. */
  resolve(snapshot: readonly SnapshotEntry[]): ResolvedTools
  /** Calls `fn` when a tool is registered or unregistered; returns the unsubscribe function. */
  subscribe(fn: () => void): () => void
}

/** A conversation's snapshot entry, as contracts/workspace.ts `ToolSnapshotEntry` stores it. */
export interface SnapshotEntry {
  readonly name: string
  readonly source: ToolSource | 'provider'
  readonly origin?: string
  readonly fingerprint: string
}

export interface RegistryModule {
  createToolRegistry(): ToolRegistry
}

export interface FingerprintModule {
  /** `<source>:<origin or ->:<name>`. */
  approvalKeyOf(spec: Pick<ToolSpec, 'source' | 'origin' | 'name'>): string
  /** base64url SHA-256 of the canonical JSON of `{name, description, inputSchema, annotations}`. */
  fingerprintOf(spec: Pick<ToolSpec, 'name' | 'description' | 'inputSchema' | 'annotations'>): Promise<string>
  /** The fingerprint of the provider web search entry (a constant: its definition is the provider's). */
  webSearchFingerprint(): Promise<string>
}

// Approvals

/** How long an approval holds: this call, this conversation, or always (for this fingerprint). */
export type ApprovalScope = 'once' | 'conversation' | 'always'

/** What the user answered to an approval request. */
export type ApprovalDecision = ApprovalScope | 'deny'

/** Why a call runs, waits or is refused. */
export type ApprovalVerdict =
  | { readonly kind: 'run'; readonly by: 'auto' | 'conversation' | 'always' }
  | { readonly kind: 'ask' }
  /** Not declared in this conversation: unknown, drifted, missing, or the provider's own tool. */
  | { readonly kind: 'refuse'; readonly reason: 'undeclared' | 'drifted' | 'missing' }

/** A stored approval (spec/DATA-MODEL.md section 3.4). */
export interface ToolApproval {
  readonly approvalKey: string
  readonly fingerprint: string
  /** The conversation it is limited to; null for "always". */
  readonly conversation: Id | null
  readonly grantedAt: number
}

/** The stored approvals of the workspace (the `toolApprovals` map of the index document). */
export interface ToolApprovals {
  /** Every stored approval, "always" ones first, then by key. */
  list(): readonly ToolApproval[]
  /** The approval of `approvalKey` in that scope, whatever its fingerprint. */
  get(approvalKey: string, conversation: Id | null): ToolApproval | undefined
  /** Stores (or replaces) the approval of `approvalKey` for `fingerprint` in that scope. */
  grant(input: { readonly approvalKey: string; readonly fingerprint: string; readonly conversation: Id | null }): void
  /** Removes it; no-op when absent. */
  revoke(approvalKey: string, conversation: Id | null): void
}

export interface PolicyModule {
  /** Whether a built-in may run without asking (`autoApprove` honoured). */
  autoApproved(spec: ToolSpec): boolean
  /**
   * The verdict for a call of `name` in a conversation whose resolved tools are `resolved`: refuse unless declared;
   * run when auto-approved or approved for this fingerprint (conversation, then always); ask otherwise.
   */
  decideApproval(input: {
    readonly name: string
    readonly resolved: ResolvedTools
    readonly approvals: Pick<ToolApprovals, 'get'>
    readonly conversationId: Id
  }): ApprovalVerdict
  /** Stores what a `conversation` or `always` decision grants; `once` and `deny` store nothing. */
  recordDecision(input: {
    readonly decision: ApprovalDecision
    readonly tool: RegisteredTool
    readonly approvals: Pick<ToolApprovals, 'grant'>
    readonly conversationId: Id
  }): void
}

// The agent loop

export interface LoopModule {
  /**
   * How many model calls one turn may make, tool rounds included, by the effort it runs at: `none`/`minimal` 2,
   * `low` 4, `medium` 8, `high` 16, `xhigh` 24, `max` 32; a model that takes no effort gets 8.
   */
  stepBudget(effort: Effort | null): number
  /** The stored `tool-result` part of a result (images become image parts with their blob ids). */
  resultPart(
    call: { readonly callId: string; readonly name: string },
    result: ToolResult,
    images?: readonly Extract<Part, { readonly type: 'image' }>[],
  ): Extract<Part, { readonly type: 'tool-result' }>
  /** The error result a call gets when it did not run (`reason` says why, for the model and the interface). */
  unansweredResult(
    call: { readonly callId: string; readonly name: string },
    reason: NotRunReason,
  ): Extract<Part, { readonly type: 'tool-result' }>
}

/** Why a call got no real result. */
export type NotRunReason = 'denied' | 'stopped' | 'budget' | 'undeclared' | 'drifted' | 'missing' | 'interrupted'
