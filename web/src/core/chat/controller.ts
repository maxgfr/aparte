/*
 * The chat controller (ControllerModule in web/src/core/contracts/chat.ts): turns a conversation path into a provider
 * request, streams the answer into memory and commits it once.
 *
 * Invariants:
 * - An answer exists only in memory while it streams. It is committed once, when the stream finishes, is stopped,
 *   fails or is refused; a refusal is committed with no parts. Nothing is written while it streams.
 * - Each turn owns one `chat-stream` hold of the vault lock and one of the PWA reload, taken before anything is written
 *   (a turn that cannot take them is refused with nothing written) and released only after its answer is committed
 *   and the workspace has flushed, or once the turn is cancelled. A queued turn takes its holds when it is queued, so a
 *   lock waits for the whole queue instead of cutting it.
 * - A turn that cannot start (no model, an unknown model or provider, no key where one is needed, empty parts, a
 *   locking vault) rejects before anything is written.
 * - Committing an answer moves the leaf to it only when the leaf is still what it was when the stream started: a
 *   branch switch made during the stream wins.
 * - A part whose JSON is longer than LARGE_PART_BYTES is stored as a blob and committed as a `ref` part; requests
 *   substitute it back, so the provider always sees the same bytes.
 * - The decrypted contents this module keeps (streams, the ref cache) are dropped by `dispose`, which runs on lock.
 * - A turn is an agent loop (contracts/chat.ts): each answer is committed once; when it ends with tool calls, each call
 *   is decided by the approval policy (contracts/tools.ts), runs only once allowed, and every call gets exactly one
 *   result, committed together as one `tool` message before the next answer streams. A stop, a lock or the step
 *   budget answers the calls left with fixed error results instead of leaving them open.
 * - A call runs only when the conversation declares its tool with the fingerprint it froze; arguments and results are
 *   handled as data and never interpreted here.
 */

import { needsKey } from '../ai/endpoints.ts'
import type {
  ChatEvent,
  ChatRequest,
  Effort,
  ModelDescriptor,
  PromptMessage,
  PromptPart,
  ProviderConfig,
  StopReason,
  Usage,
} from '../contracts/ai.ts'
import type { ChatController, ChatDeps, ChatEventName, StreamState, ToolCallState, Turn } from '../contracts/chat.ts'
import { InvalidInputError, InvalidStateError } from '../contracts/crypto.ts'
import type { ApprovalDecision, NotRunReason, RegisteredTool, ResolvedTools, ToolResult } from '../contracts/tools.ts'
import { WEB_SEARCH } from '../contracts/tools.ts'
import type {
  Conversation,
  Id,
  Message,
  MessageError,
  MessageStatus,
  ModelRef,
  NewMessage,
  Part,
  Thread,
  ToolSnapshotEntry,
} from '../contracts/workspace.ts'
import { base32Encode, fromUtf8, utf8 } from '../crypto/bytes.ts'
import { resultPart, stepBudget, unansweredResult } from '../tools/loop.ts'
import { decideApproval, recordDecision } from '../tools/policy.ts'
import { LARGE_PART_BYTES, pickEffort, planPrompt, titleFrom } from './request.ts'

const REASON = 'chat-stream'
/** The media type of a part stored as a blob (spec/DATA-MODEL.md section 4.3). */
const PART_MEDIA_TYPE = 'application/vnd.aparte.part+json'

/** What a turn needs to start, checked before anything is written. */
interface Prepared {
  readonly descriptor: ModelDescriptor
  readonly provider: ProviderConfig
  readonly apiKey: string | null
}

type Settle<T> = { readonly resolve: (value: T) => void; readonly reject: (error: unknown) => void }

/** Something waiting for the conversation's stream to commit. */
type Pending =
  | {
      readonly kind: 'user'
      readonly id: Id
      readonly parts: readonly Part[]
      readonly prepared: Prepared
      readonly release: () => void
      readonly settle: Settle<Message | null>
    }
  | { readonly kind: 'system'; readonly id: Id; readonly text: string; readonly settle: Settle<Id> }

/** How a stream ended. */
interface Outcome {
  readonly status: MessageStatus
  readonly stop?: StopReason
  readonly error?: MessageError
  readonly refusal?: { readonly category: string | null; readonly explanation?: string }
}

/** One call of the tool round being run. */
interface CallRun {
  state: ToolCallState
  readonly tool: RegisteredTool | null
  /** Set while the call waits for the user; called with null when the turn stops first. */
  answer: ((decision: ApprovalDecision | null) => void) | null
}

const NO_TOOLS: ResolvedTools = Object.freeze({ declared: [], webSearch: false, drifted: [], missing: [] })

interface Run {
  readonly conversationId: Id
  /** The answer streaming now, or (in the tools phase) the id the next answer will take. */
  messageId: Id
  /** What the streaming answer answers: the user message, or the tool message of the previous round. */
  parentId: Id
  readonly model: ModelRef
  readonly effort: Effort | null
  startedAt: number
  /** The leaf when this step started: a commit moves the leaf only from there. */
  leafAtStart: Id | null
  readonly prepared: Prepared
  /** Model calls made so far in this turn. */
  step: number
  phase: 'model' | 'tools'
  calls: CallRun[]
  /** The conversation's tools as the current step declared them. */
  resolved: ResolvedTools
  readonly abort: AbortController
  readonly release: () => void
  readonly settle: Settle<Message | null>
  readonly queue: Pending[]
  parts: Part[]
  usage: Usage | undefined
  /** Null once the answer is committed (the run then only waits for the flush and its queue). */
  snapshot: StreamState | null
  /** Set by `stop` and `dispose`: queued turns are cancelled instead of started. */
  cancelled: boolean
  /** Resolves once the run is over and its successor, if any, has started. */
  finished: Promise<void>
}

/** A blob a message refers to is not on this device (yet). */
class BlobMissing extends Error {}

function settled<T>(): { promise: Promise<T>; settle: Settle<T> } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // A caller that never looks at the outcome must not cause an unhandled rejection.
  promise.catch(() => undefined)
  return { promise, settle: { resolve, reject } }
}

/** A copy without `undefined` members, which a Yjs `Any` value cannot hold. */
function defined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => defined(v)) as T
  if (value !== null && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = defined(v)
    return out as T
  }
  return value
}

export function createChatController(deps: ChatDeps): ChatController {
  const { workspace: ws } = deps
  const runs = new Map<Id, Run>()
  const listeners = new Set<(event: ChatEventName, conversationId: Id) => void>()
  /** Parts substituted for `ref` parts, by blob id: they are immutable, so reading one once is enough. */
  const refs = new Map<string, Part>()
  let disposed = false

  const newId = (): Id => base32Encode(deps.rng.bytes(16))

  function notify(event: ChatEventName, conversationId: Id): void {
    for (const fn of [...listeners]) {
      try {
        fn(event, conversationId)
      } catch {
        // A failing listener must not break the stream or the other listeners.
      }
    }
  }

  function locking(cause?: unknown): InvalidStateError {
    return new InvalidStateError('The vault is locking', cause === undefined ? undefined : { cause })
  }

  /** Takes the lock and reload holds of one turn; InvalidStateError while the vault is locking. */
  function takeHolds(): () => void {
    if (disposed) throw locking()
    let lock: () => void
    try {
      lock = deps.holdLock(REASON)
    } catch (error) {
      throw locking(error)
    }
    let reload: () => void
    try {
      reload = deps.holdReload(REASON)
    } catch (error) {
      lock()
      throw error
    }
    let released = false
    return () => {
      if (released) return
      released = true
      try {
        reload()
      } finally {
        lock()
      }
    }
  }

  function conversationOf(conversationId: Id): Conversation {
    const conversation = ws.conversations.get(conversationId)
    if (conversation === undefined || conversation.purgedAt !== undefined) {
      throw new InvalidInputError('Unknown conversation')
    }
    return conversation
  }

  /** Checks that a turn of the conversation can start, and gathers what it needs. */
  async function prepare(conversation: Conversation): Promise<Prepared> {
    if (disposed) throw locking()
    const ref = conversation.model
    if (ref === null) throw new InvalidStateError('The conversation has no model')
    const descriptor = deps.resolveModel(ref)
    if (descriptor === null) throw new InvalidInputError('Unknown model or provider')
    const provider: ProviderConfig = ws.providers.get(ref.provider) ?? {
      // The descriptor vouches for the model; a provider the index does not list is called with its kind's defaults.
      id: ref.provider,
      kind: descriptor.kind,
      label: descriptor.kind,
      syncKey: false,
      createdAt: 0,
      updatedAt: 0,
    }
    const apiKey = await deps.keys.get(provider.id)
    if (apiKey === null && needsKey(provider)) throw new InvalidInputError('The provider needs a key')
    if (disposed) throw locking()
    return { descriptor, provider, apiKey }
  }

  function validParts(parts: readonly Part[]): void {
    if (parts.length === 0) throw new InvalidInputError('A message needs at least one part')
  }

  /** Parts as committed: any whose JSON is over LARGE_PART_BYTES goes to a blob and is replaced by a `ref`. */
  async function storable(parts: readonly Part[]): Promise<Part[]> {
    const out: Part[] = []
    for (const part of parts) {
      const clean = defined(part)
      const bytes = utf8(JSON.stringify(clean))
      if (bytes.length > LARGE_PART_BYTES && part.type !== 'ref') {
        const blob = await deps.blobs.put(bytes, PART_MEDIA_TYPE)
        refs.set(blob, clean)
        out.push({ type: 'ref', partType: part.type, blob, size: bytes.length })
      } else {
        out.push(clean)
      }
    }
    return out
  }

  async function resolveRef(part: Extract<Part, { readonly type: 'ref' }>): Promise<Part> {
    const known = refs.get(part.blob)
    if (known !== undefined) return known
    const bytes = await deps.blobs.get(part.blob)
    if (bytes === null) throw new BlobMissing(`Blob ${part.blob} is not on this device`)
    const parsed = JSON.parse(fromUtf8(bytes)) as Part
    refs.set(part.blob, parsed)
    return parsed
  }

  /** The path with every `ref` part substituted (spec/DATA-MODEL.md section 4.3). */
  async function substituted(path: readonly Message[]): Promise<Message[]> {
    const out: Message[] = []
    for (const message of path) {
      if (!message.parts.some((p) => p.type === 'ref')) {
        out.push(message)
        continue
      }
      const parts: Part[] = []
      for (const part of message.parts) parts.push(part.type === 'ref' ? await resolveRef(part) : part)
      out.push({ ...message, parts })
    }
    return out
  }

  /** A planned part with its blob bytes, as the adapter sends it. */
  async function promptPart(part: Part): Promise<PromptPart | null> {
    if (part.type === 'image' || part.type === 'file') {
      const data = await deps.blobs.get(part.blob)
      if (data === null) throw new BlobMissing(`Blob ${part.blob} is not on this device`)
      return { ...part, data }
    }
    if (part.type === 'ref') return null
    return part
  }

  /** The conversation's tools that are still what it froze (drift detection), or none without a registry. */
  function resolveTools(conversation: Conversation): ResolvedTools {
    return deps.tools ? deps.tools.registry.resolve(conversation.tools) : NO_TOOLS
  }

  /** Whether a provider keeps the arguments valid against a schema it is told is strict, and this one qualifies. */
  function strictFor(kind: ProviderConfig['kind'], schema: RegisteredTool['tool']['inputSchema']): boolean {
    if (kind !== 'anthropic' && kind !== 'openai') return false
    const properties = schema.properties
    const required = schema.required
    if (schema.additionalProperties !== false || properties === null || typeof properties !== 'object') return false
    const names = Object.keys(properties as object)
    return Array.isArray(required) && names.every((n) => required.includes(n))
  }

  async function buildRequest(run: Run, thread: Thread): Promise<ChatRequest> {
    const conversation = conversationOf(run.conversationId)
    const path = await substituted(thread.path(run.parentId))
    const plan = planPrompt({
      conversation,
      path,
      kind: run.prepared.descriptor.kind,
      capabilities: run.prepared.descriptor.capabilities,
    })
    const messages: PromptMessage[] = []
    for (const planned of plan.messages) {
      const parts: PromptPart[] = []
      for (const part of planned.parts) {
        const p = await promptPart(part)
        if (p !== null) parts.push(p)
      }
      messages.push({ role: planned.role, parts })
    }
    const caps = run.prepared.descriptor.capabilities
    const kind = run.prepared.descriptor.kind
    run.resolved = resolveTools(conversation)
    // A model without tools gets none (the same way on every turn); the others get the snapshot, minus what drifted.
    const tools = caps.tools
      ? run.resolved.declared.map((r) => ({
          name: r.tool.name,
          description: r.tool.description,
          inputSchema: r.tool.inputSchema,
          ...(strictFor(kind, r.tool.inputSchema) ? { strict: true } : {}),
        }))
      : []
    const webSearch = run.resolved.webSearch && caps.webSearch !== null
    return {
      provider: run.prepared.provider,
      model: run.prepared.descriptor,
      apiKey: run.prepared.apiKey,
      system: plan.system,
      messages,
      tools,
      ...(webSearch ? { webSearch: true } : {}),
      effort: run.effort,
      signal: run.abort.signal,
    }
  }

  function snapshotOf(run: Run): StreamState {
    const state: StreamState = {
      conversationId: run.conversationId,
      messageId: run.messageId,
      parentId: run.parentId,
      model: run.model,
      effort: run.effort,
      parts: Object.freeze([...run.parts]),
      ...(run.usage === undefined ? {} : { usage: run.usage }),
      startedAt: run.startedAt,
      queued: run.queue.filter((p) => p.kind === 'user').length,
      step: run.step,
      phase: run.phase,
      tools: Object.freeze(run.calls.map((c) => c.state)),
    }
    return Object.freeze(state)
  }

  function changed(run: Run): void {
    if (run.snapshot === null) return
    run.snapshot = snapshotOf(run)
    notify('stream', run.conversationId)
  }

  /** Applies one event to the parts in memory; returns the outcome when the event ends the stream. */
  function apply(run: Run, open: Map<string, number>, event: ChatEvent): Outcome | null {
    const textIn = (p: Part) => (p.type === 'text' || p.type === 'reasoning' ? p.text : '')
    /** Appends `delta` to the open text or reasoning part `key`, opening it first when needed. */
    const grow = (key: string, delta: string, make: (text: string, before: Part | undefined) => Part) => {
      const at = open.get(key)
      if (at === undefined) {
        open.set(key, run.parts.length)
        run.parts.push(make(delta, undefined))
      } else {
        const before = run.parts[at] as Part
        run.parts[at] = make(textIn(before) + delta, before)
      }
    }
    switch (event.type) {
      case 'text-delta':
        grow(`t:${event.id}`, event.text, (text) => ({ type: 'text', text }))
        return null
      case 'reasoning-delta':
        grow(`r:${event.id}`, event.text, (text, before) => {
          const meta = before?.type === 'reasoning' ? before.providerMeta : undefined
          return { type: 'reasoning', text, ...(meta === undefined ? {} : { providerMeta: meta }) }
        })
        return null
      case 'reasoning-end': {
        const key = `r:${event.id}`
        const at = open.get(key)
        const meta = event.providerMeta === undefined ? {} : { providerMeta: event.providerMeta }
        if (at === undefined) run.parts.push({ type: 'reasoning', text: '', ...meta })
        else run.parts[at] = { type: 'reasoning', text: textIn(run.parts[at] as Part), ...meta }
        open.delete(key)
        return null
      }
      case 'tool-call':
        run.parts.push({
          type: 'tool-call',
          callId: event.callId,
          name: event.name,
          input: event.input,
          ...(event.providerMeta === undefined ? {} : { providerMeta: event.providerMeta }),
        })
        return null
      case 'source':
        run.parts.push(event.part)
        return null
      case 'provider-block':
        run.parts.push({ type: 'provider', provider: event.provider, block: event.block })
        return null
      case 'usage':
        run.usage = event.usage
        return null
      case 'finish':
        if (event.stop === 'refusal') {
          // The partial output of a refusal is discarded, as the provider requires.
          run.parts = []
          return {
            status: 'refused',
            stop: 'refusal',
            refusal: event.refusal ?? { category: null },
          }
        }
        return { status: 'done', stop: event.stop }
      case 'error':
        return { status: 'error', error: { code: event.error.code, message: event.error.message } }
      default:
        return null
    }
  }

  /** Streams the answer in memory; never throws. */
  async function consume(run: Run, thread: Thread): Promise<Outcome> {
    const signal = run.abort.signal
    const stoppedOutcome: Outcome = { status: 'stopped' }
    try {
      const request = await buildRequest(run, thread)
      if (signal.aborted) return stoppedOutcome
      const open = new Map<string, number>()
      for await (const event of deps.adapter(run.prepared.descriptor.kind).stream(request)) {
        if (signal.aborted) break
        const outcome = apply(run, open, event)
        if (outcome !== null) return outcome
        changed(run)
      }
      if (signal.aborted) return stoppedOutcome
      return { status: 'error', error: { code: 'truncated', message: '' } }
    } catch (error) {
      if (signal.aborted) return stoppedOutcome
      if (error instanceof BlobMissing) return { status: 'error', error: { code: 'blob-missing', message: '' } }
      const message = error instanceof Error ? error.message : String(error)
      return { status: 'error', error: { code: 'invalid-request', message } }
    }
  }

  async function commitAnswer(run: Run, thread: Thread, outcome: Outcome): Promise<Message> {
    const parts = outcome.status === 'refused' ? [] : await storable(run.parts)
    const usage = run.usage === undefined ? undefined : defined(run.usage)
    const message: NewMessage = {
      id: run.messageId,
      parent: run.parentId,
      role: 'assistant',
      parts,
      model: run.model,
      status: outcome.status,
      ...(usage === undefined ? {} : { usage }),
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      ...(outcome.stop === undefined ? {} : { stop: outcome.stop }),
      ...(outcome.refusal === undefined ? {} : { refusal: defined(outcome.refusal) }),
      ...(run.effort === null ? {} : { effort: run.effort }),
    }
    ws.batch(() => {
      thread.commit(message)
      thread.setLeaf(run.messageId, { ifLeaf: run.leafAtStart })
    })
    run.snapshot = null
    const committed = thread.get(run.messageId)
    if (committed === undefined) throw new InvalidStateError('The committed answer is missing')
    return committed
  }

  /**
   * The snapshot a conversation's first message freezes: its chosen tools with the fingerprints registered now (names
   * the registry no longer has are dropped). Null once the conversation has started, or without a registry.
   */
  async function freshSnapshot(conversation: Conversation): Promise<readonly ToolSnapshotEntry[] | null> {
    if (conversation.startedAt !== undefined || !deps.tools) return null
    const names = conversation.tools.filter((t) => t.source !== 'provider').map((t) => t.name)
    const webSearch = conversation.tools.some((t) => t.source === 'provider' && t.name === WEB_SEARCH)
    return deps.tools.registry.snapshot(names, { webSearch })
  }

  /**
   * Commits a user message as a child of the leaf and moves the leaf to it; the first one also names the chat and
   * freezes its tool snapshot (`tools`), in the same write.
   */
  function commitUser(
    thread: Thread,
    conversationId: Id,
    id: Id,
    parts: readonly Part[],
    parent: Id | null,
    tools: readonly ToolSnapshotEntry[] | null = null,
  ): void {
    const conversation = conversationOf(conversationId)
    ws.batch(() => {
      if (tools !== null && conversation.startedAt === undefined) ws.conversations.update(conversationId, { tools })
      thread.commit({ id, parent, role: 'user', parts, model: null, status: 'done' })
      thread.setLeaf(id)
      if (conversation.title === '') {
        const title = titleFrom(parts)
        if (title !== '') ws.conversations.update(conversationId, { title })
      }
    })
  }

  function commitSystem(thread: Thread, conversationId: Id, id: Id, text: string): void {
    const parent = conversationOf(conversationId).leaf
    ws.batch(() => {
      thread.commit({ id, parent, role: 'system', parts: [{ type: 'text', text }], model: null, status: 'done' })
      thread.setLeaf(id)
    })
  }

  /** Starts streaming an answer to `parentId`; the run takes over `release` and `queue`. */
  function start(
    thread: Thread,
    conversationId: Id,
    parentId: Id,
    prepared: Prepared,
    release: () => void,
    settle: Settle<Message | null>,
    queue: Pending[],
  ): Run {
    const conversation = conversationOf(conversationId)
    const effort = pickEffort(
      conversation,
      { defaultEffort: ws.settings.get('defaultEffort') },
      prepared.descriptor.capabilities,
    )
    const run: Run = {
      conversationId,
      messageId: newId(),
      parentId,
      model: prepared.descriptor.ref,
      effort,
      startedAt: deps.clock.now(),
      leafAtStart: conversation.leaf,
      prepared,
      step: 1,
      phase: 'model',
      calls: [],
      resolved: NO_TOOLS,
      abort: new AbortController(),
      release,
      settle,
      queue,
      parts: [],
      usage: undefined,
      snapshot: null,
      cancelled: false,
      finished: Promise.resolve(),
    }
    run.snapshot = snapshotOf(run)
    runs.set(conversationId, run)
    run.finished = execute(run, thread)
    notify('stream', conversationId)
    return run
  }

  /**
   * The calls an answer that ended `done` asks the client to run: its `tool-call` parts, in order, read from the parts
   * in memory (a large call is committed as a `ref` part, but runs all the same).
   */
  function callsOf(outcome: Outcome, parts: readonly Part[]): Extract<Part, { readonly type: 'tool-call' }>[] {
    if (outcome.status !== 'done') return []
    return parts.filter((p): p is Extract<Part, { readonly type: 'tool-call' }> => p.type === 'tool-call')
  }

  function callState(
    call: Extract<Part, { readonly type: 'tool-call' }>,
    tool: RegisteredTool | null,
    status: ToolCallState['status'],
  ): ToolCallState {
    const spec = tool?.tool
    return Object.freeze({
      callId: call.callId,
      name: call.name,
      input: call.input,
      title: spec?.title ?? call.name,
      source: spec?.source ?? null,
      ...(spec?.origin === undefined ? {} : { origin: spec.origin }),
      annotations: spec?.annotations ?? null,
      status,
    })
  }

  function setStatus(run: Run, call: CallRun, status: ToolCallState['status']): void {
    call.state = Object.freeze({ ...call.state, status })
    changed(run)
  }

  /** What a tool's result becomes as a stored part: images go to blobs first. */
  async function storedResult(
    call: { readonly callId: string; readonly name: string },
    result: ToolResult,
  ): Promise<Extract<Part, { readonly type: 'tool-result' }>> {
    const images: Extract<Part, { readonly type: 'image' }>[] = []
    for (const c of result.content) {
      if (c.type !== 'image') continue
      const blob = await deps.blobs.put(c.data, c.mediaType)
      images.push({ type: 'image', blob, mediaType: c.mediaType, width: 0, height: 0 })
    }
    return resultPart(call, result, images)
  }

  /** Waits for the user's answer to a call, or null when the turn stops first. */
  function ask(run: Run, call: CallRun): Promise<ApprovalDecision | null> {
    return new Promise((resolve) => {
      if (run.abort.signal.aborted) {
        resolve(null)
        return
      }
      const onAbort = () => done(null)
      const done = (decision: ApprovalDecision | null) => {
        run.abort.signal.removeEventListener('abort', onAbort)
        call.answer = null
        resolve(decision)
      }
      call.answer = done
      run.abort.signal.addEventListener('abort', onAbort, { once: true })
      setStatus(run, call, 'approval')
    })
  }

  /** Runs one call to its result part; never throws. */
  async function runCall(run: Run, call: CallRun, part: Extract<Part, { readonly type: 'tool-call' }>) {
    const notRun = (reason: NotRunReason, status: ToolCallState['status']) => {
      setStatus(run, call, status)
      return unansweredResult(part, reason)
    }
    if (run.abort.signal.aborted) return notRun('stopped', 'skipped')
    const verdict = decideApproval({
      name: part.name,
      resolved: run.resolved,
      approvals: deps.tools?.approvals ?? { get: () => undefined },
      conversationId: run.conversationId,
    })
    if (verdict.kind === 'refuse') return notRun(verdict.reason, 'refused')
    const tool = call.tool
    if (tool === null) return notRun('undeclared', 'refused')
    if (verdict.kind === 'ask') {
      const decision = await ask(run, call)
      if (decision === null) return notRun('stopped', 'skipped')
      if (decision === 'deny') return notRun('denied', 'denied')
      if (deps.tools) {
        try {
          recordDecision({ decision, tool, approvals: deps.tools.approvals, conversationId: run.conversationId })
        } catch {
          // Storing the approval failed (a locking vault): this call was still approved by the user.
        }
      }
    }
    setStatus(run, call, 'running')
    let result: ToolResult
    try {
      result = await tool.tool.execute(part.input, {
        conversationId: run.conversationId,
        callId: part.callId,
        signal: run.abort.signal,
      })
    } catch (error) {
      if (run.abort.signal.aborted) return notRun('stopped', 'skipped')
      const message = error instanceof Error ? error.message : String(error)
      result = { content: [{ type: 'text', text: `The tool failed: ${message}` }], isError: true }
    }
    setStatus(run, call, result.isError ? 'failed' : 'done')
    try {
      return await storedResult(part, result)
    } catch {
      setStatus(run, call, 'failed')
      return unansweredResult(part, 'interrupted')
    }
  }

  /**
   * The tool round after answer `answer`: every call decided, run or answered with why not, then the results
   * committed as one `tool` message. Returns that message's id.
   */
  async function round(
    run: Run,
    thread: Thread,
    answer: Message,
    parts: readonly Extract<Part, { readonly type: 'tool-call' }>[],
  ): Promise<Id> {
    const overBudget = run.step >= stepBudget(run.effort)
    run.phase = 'tools'
    run.parentId = answer.id
    run.messageId = newId()
    run.parts = []
    run.usage = undefined
    run.calls = parts.map((part) => {
      const tool = run.resolved.declared.find((r) => r.tool.name === part.name) ?? null
      return { state: callState(part, tool, 'running'), tool, answer: null }
    })
    run.snapshot = snapshotOf(run)
    notify('stream', run.conversationId)
    const results: Part[] = []
    for (const [i, part] of parts.entries()) {
      const call = run.calls[i] as CallRun
      if (overBudget) {
        setStatus(run, call, 'skipped')
        results.push(unansweredResult(part, 'budget'))
      } else {
        results.push(await runCall(run, call, part))
      }
    }
    const id = newId()
    const stored = await storable(results)
    ws.batch(() => {
      thread.commit({ id, parent: answer.id, role: 'tool', parts: stored, model: null, status: 'done' })
      thread.setLeaf(id, { ifLeaf: answer.id })
    })
    notify('commit', run.conversationId)
    return id
  }

  async function execute(run: Run, thread: Thread): Promise<void> {
    let committed: Message | null = null
    let failure: unknown = null
    try {
      for (;;) {
        const outcome = await consume(run, thread)
        const made = callsOf(outcome, run.parts)
        committed = await commitAnswer(run, thread, outcome)
        notify('commit', run.conversationId)
        if (made.length === 0) break
        const overBudget = run.step >= stepBudget(run.effort)
        const toolMessage = await round(run, thread, committed, made)
        if (run.abort.signal.aborted || overBudget || disposed) break
        // The next answer streams as a child of the results, from where the leaf now is.
        run.step += 1
        run.phase = 'model'
        run.calls = []
        run.parentId = toolMessage
        run.leafAtStart = toolMessage
        run.startedAt = deps.clock.now()
        run.snapshot = snapshotOf(run)
        notify('stream', run.conversationId)
      }
    } catch (error) {
      failure = error
    }
    run.snapshot = null
    notify('commit', run.conversationId)
    try {
      await ws.flush()
    } catch {
      // A failed save is reported by the workspace's persistence status; the hold must not outlive it.
    }
    const next = advance(run, thread)
    run.release()
    if (failure === null) run.settle.resolve(committed)
    else run.settle.reject(failure)
    if (next === null) {
      if (runs.get(run.conversationId) === run) runs.delete(run.conversationId)
      notify('stream', run.conversationId)
    }
  }

  /** Works through the queue after a commit: system messages are committed, the first user turn starts. */
  function advance(run: Run, thread: Thread): Run | null {
    const queue = run.queue
    while (queue.length > 0) {
      const item = queue.shift() as Pending
      if (item.kind === 'system') {
        try {
          commitSystem(thread, run.conversationId, item.id, item.text)
          item.settle.resolve(item.id)
        } catch (error) {
          item.settle.reject(error)
        }
        continue
      }
      if (run.cancelled || disposed) {
        item.release()
        item.settle.resolve(null)
        continue
      }
      try {
        const parent = conversationOf(run.conversationId).leaf
        commitUser(thread, run.conversationId, item.id, item.parts, parent)
        return start(thread, run.conversationId, item.id, item.prepared, item.release, item.settle, queue.splice(0))
      } catch (error) {
        item.release()
        item.settle.reject(error)
      }
    }
    return null
  }

  /** Cancels the queued user turns of a run at once: they resolve with null and give their holds back. */
  function cancelQueue(run: Run): void {
    run.cancelled = true
    for (let i = run.queue.length - 1; i >= 0; i--) {
      const item = run.queue[i] as Pending
      if (item.kind !== 'user') continue
      run.queue.splice(i, 1)
      item.release()
      item.settle.resolve(null)
    }
    changed(run)
  }

  function busy(conversationId: Id): void {
    if (runs.has(conversationId)) throw new InvalidStateError('A response is streaming in this conversation')
  }

  return {
    async send(conversationId, parts) {
      validParts(parts)
      const prepared = await prepare(conversationOf(conversationId))
      const thread = await ws.thread(conversationId)
      const stored = await storable(parts)
      const tools = await freshSnapshot(conversationOf(conversationId))
      if (disposed) throw locking()
      const release = takeHolds()
      const id = newId()
      const { promise, settle } = settled<Message | null>()
      const running = runs.get(conversationId)
      if (running !== undefined) {
        running.queue.push({ kind: 'user', id, parts: stored, prepared, release, settle })
        changed(running)
        return { userMessageId: id, done: promise }
      }
      try {
        commitUser(thread, conversationId, id, stored, conversationOf(conversationId).leaf, tools)
      } catch (error) {
        release()
        throw error
      }
      start(thread, conversationId, id, prepared, release, settle, [])
      return { userMessageId: id, done: promise }
    },

    async regenerate(conversationId, messageId) {
      busy(conversationId)
      const prepared = await prepare(conversationOf(conversationId))
      const thread = await ws.thread(conversationId)
      const message = thread.get(messageId)
      if (message === undefined) throw new InvalidInputError('Unknown message')
      const parentId = message.role === 'assistant' ? message.parent : messageId
      if (parentId === null) throw new InvalidStateError('An answer needs a message to answer')
      // The path must give a request at all, or nothing is started.
      planPrompt({
        conversation: conversationOf(conversationId),
        path: thread.path(parentId),
        kind: prepared.descriptor.kind,
        capabilities: prepared.descriptor.capabilities,
      })
      busy(conversationId)
      const release = takeHolds()
      const { promise, settle } = settled<Message | null>()
      start(thread, conversationId, parentId, prepared, release, settle, [])
      return { userMessageId: null, done: promise } satisfies Turn
    },

    async edit(conversationId, messageId, parts) {
      validParts(parts)
      busy(conversationId)
      const prepared = await prepare(conversationOf(conversationId))
      const thread = await ws.thread(conversationId)
      const original = thread.get(messageId)
      if (original === undefined || original.role !== 'user')
        throw new InvalidInputError('Only a user message is edited')
      const stored = await storable(parts)
      busy(conversationId)
      if (disposed) throw locking()
      const release = takeHolds()
      const id = newId()
      try {
        commitUser(thread, conversationId, id, stored, original.parent)
      } catch (error) {
        release()
        throw error
      }
      const { promise, settle } = settled<Message | null>()
      start(thread, conversationId, id, prepared, release, settle, [])
      return { userMessageId: id, done: promise }
    },

    async appendSystem(conversationId, text) {
      if (disposed) throw locking()
      const conversation = conversationOf(conversationId)
      if (conversation.startedAt === undefined) {
        ws.conversations.update(conversationId, { system: text })
        return null
      }
      if (text.trim() === '') throw new InvalidInputError('A system message needs text')
      const thread = await ws.thread(conversationId)
      const id = newId()
      const running = runs.get(conversationId)
      if (running !== undefined) {
        // It takes effect after the answer streaming now, which was asked for under the previous instructions.
        const { promise, settle } = settled<Id>()
        running.queue.push({ kind: 'system', id, text, settle })
        return promise
      }
      commitSystem(thread, conversationId, id, text)
      return id
    },

    approve(conversationId, callId, decision) {
      const run = runs.get(conversationId)
      const call = run?.phase === 'tools' ? run.calls.find((c) => c.state.callId === callId) : undefined
      if (call?.answer == null) throw new InvalidStateError('No call waits for this approval')
      if (!['once', 'conversation', 'always', 'deny'].includes(decision)) {
        throw new InvalidInputError('Unknown approval decision')
      }
      call.answer(decision)
    },

    stop(conversationId) {
      const run = runs.get(conversationId)
      if (run === undefined) return
      cancelQueue(run)
      run.abort.abort()
    },

    stream(conversationId) {
      return runs.get(conversationId)?.snapshot ?? null
    },

    streaming() {
      return Object.freeze([...runs.values()].filter((r) => r.snapshot !== null).map((r) => r.conversationId))
    },

    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },

    async dispose() {
      disposed = true
      for (const run of runs.values()) {
        cancelQueue(run)
        run.abort.abort()
      }
      while (runs.size > 0) await Promise.all([...runs.values()].map((r) => r.finished.catch(() => undefined)))
      refs.clear()
    },
  }
}
