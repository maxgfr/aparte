/*
 * Beam and the Arena: one user message answered by several models at once (up to MAX_BEAM), compared side by side,
 * then one answer kept or the answers merged by a model the user chooses. Every answer is an ordinary assistant
 * message, a sibling under the same user message (spec/DATA-MODEL.md section 4.1), so "keep this one" only moves the
 * leaf and the other answers stay as `< 2/3 >` versions.
 *
 * Invariants:
 * - Each candidate is requested exactly as the chat controller would request a regeneration with that model: the
 *   conversation's frozen `system` and tool snapshot, the stored path up to the user message (planPrompt), the
 *   model's own effort. So its reasoning is signed over the prefix it is stored under, and replaying it later is valid
 *   (spec/DATA-MODEL.md section 5, rules 3 and 5). Beam never runs the tools a candidate calls: a candidate that ends
 *   with calls keeps them, and the request builder answers them as interrupted if the branch is continued (rule 12).
 * - A merged answer is requested over the same path with the candidates appended to the last user turn, which is not
 *   what is stored. Its reasoning and tool calls are therefore never committed: only its text and sources are, so
 *   nothing signed over another prefix is ever replayed.
 * - Like the controller, an answer exists only in memory while it streams and is committed once; the beam holds the
 *   vault lock and the PWA reload (`chat-beam`) from its first write until every answer is committed and flushed.
 * - The user message is committed as the controller commits one: a child of the leaf, the first message naming the
 *   chat and freezing its tool snapshot.
 * - Decrypted content kept here (the streams) is dropped by `dispose`, which runs on lock.
 */

import { needsKey } from '../ai/endpoints.ts'
import { LARGE_PART_BYTES, pickEffort, planPrompt, titleFrom } from '../chat/request.ts'
import type {
  ChatAdapter,
  ChatEvent,
  ChatRequest,
  Effort,
  ModelDescriptor,
  PromptMessage,
  PromptPart,
  ProviderConfig,
  ProviderKeys,
  ProviderKind,
  Usage,
} from '../contracts/ai.ts'
import { InvalidInputError, InvalidStateError, type Rng } from '../contracts/crypto.ts'
import type { ResolvedTools, ToolRegistry } from '../contracts/tools.ts'
import { WEB_SEARCH } from '../contracts/tools.ts'
import type { Clock } from '../contracts/vault.ts'
import type {
  BlobPort,
  Conversation,
  Id,
  Message,
  MessageError,
  MessageStatus,
  ModelRef,
  NewMessage,
  Part,
  Thread,
  Workspace,
} from '../contracts/workspace.ts'
import { base32Encode, fromUtf8, utf8 } from '../crypto/bytes.ts'

/** At most this many models answer one Beam. */
export const MAX_BEAM = 4
const REASON = 'chat-beam'
const PART_MEDIA_TYPE = 'application/vnd.aparte.part+json'

/**
 * What a merge asks of the chosen model, appended to the last user turn of the request (never stored). English on
 * purpose: it is an instruction to a model, like `<system-update>`, not interface text.
 */
export function fusionPrompt(answers: readonly string[]): string {
  const blocks = answers.map((text, i) => `<answer index="${i + 1}">\n${text}\n</answer>`).join('\n\n')
  return [
    `Several assistants answered the message above. Their ${answers.length} answers follow.`,
    'Write the single best answer to the message: keep what is correct and useful in each, resolve their',
    'disagreements, fix their mistakes and drop repetition. Reply with that answer only, without mentioning the',
    'other answers.',
    '',
    blocks,
  ].join('\n')
}

export type CandidateStatus = 'streaming' | MessageStatus

/** One answer of a beam, streaming or committed. */
export interface Candidate {
  readonly model: ModelRef
  /** The id it is (or will be) committed under. */
  readonly messageId: Id
  /** Parts received so far; once committed, the committed parts (a `ref` stays unresolved here). */
  readonly parts: readonly Part[]
  readonly status: CandidateStatus
  readonly usage?: Usage
  readonly error?: MessageError
}

export interface BeamState {
  readonly conversationId: Id
  /** The user message every candidate answers. */
  readonly userMessageId: Id
  /** `arena`: the interface keeps the models' names hidden until the vote. */
  readonly mode: 'beam' | 'arena'
  readonly candidates: readonly Candidate[]
  /** The merged answer, while it streams and once committed; null before a merge. */
  readonly fusion: Candidate | null
  /** Whether any answer (a candidate or the merge) is still streaming. */
  readonly running: boolean
}

export interface BeamDeps {
  readonly workspace: Workspace
  readonly holdLock: (reason: string) => () => void
  readonly holdReload: (reason: string) => () => void
  readonly adapter: (kind: ProviderKind) => ChatAdapter
  readonly keys: ProviderKeys
  readonly resolveModel: (ref: ModelRef) => ModelDescriptor | null
  readonly blobs: BlobPort
  readonly rng: Rng
  readonly clock: Clock
  /** The registry the conversation's tool snapshot resolves against; without it no tool is declared. */
  readonly tools?: { readonly registry: ToolRegistry }
}

export interface BeamEngine {
  /**
   * Commits `parts` as a user message (a child of the leaf, as a send does) and streams one answer per model. Rejects,
   * having written nothing, with InvalidInputError for no model, more than MAX_BEAM, a duplicate, an unknown model or
   * a missing key, and InvalidStateError while a beam runs in the conversation or the vault is locking.
   */
  start(
    conversationId: Id,
    parts: readonly Part[],
    models: readonly ModelRef[],
    options?: { readonly mode?: 'beam' | 'arena' },
  ): Promise<BeamState>
  /** Streams more answers to an existing user message, as siblings of the answers it has. */
  answer(
    conversationId: Id,
    userMessageId: Id,
    models: readonly ModelRef[],
    options?: { readonly mode?: 'beam' | 'arena' },
  ): Promise<BeamState>
  /**
   * Streams a merge of the committed candidates `from` (default: every candidate that finished with text) by
   * `model`, committed as one more sibling, and moves the leaf to it. InvalidStateError while answers stream or with
   * fewer than two answers to merge.
   */
  fuse(conversationId: Id, model: ModelRef, from?: readonly Id[]): Promise<Message>
  /** Keeps candidate `messageId`: the branch view switches to it (its latest descendant). */
  pick(conversationId: Id, messageId: Id): Promise<void>
  /** Stops every stream of the conversation's beam; each is committed as `stopped`. */
  stop(conversationId: Id): void
  /** Forgets the comparison of a conversation once nothing streams (its messages stay). */
  close(conversationId: Id): void
  state(conversationId: Id): BeamState | null
  subscribe(fn: (conversationId: Id) => void): () => void
  /** Stops everything and resolves once every answer is committed; for the vault's `onLock`. */
  dispose(): Promise<void>
}

interface Prepared {
  readonly descriptor: ModelDescriptor
  readonly provider: ProviderConfig
  readonly apiKey: string | null
}

interface Stream {
  readonly model: ModelRef
  readonly prepared: Prepared
  readonly messageId: Id
  parts: Part[]
  usage: Usage | undefined
  status: CandidateStatus
  error?: MessageError
  readonly abort: AbortController
  done: Promise<Message | null>
}

interface Beam {
  readonly conversationId: Id
  readonly userMessageId: Id
  readonly mode: 'beam' | 'arena'
  readonly streams: Stream[]
  fusion: Stream | null
  /** The leaf when the beam started: the first commit moves the leaf only from there. */
  leafAtStart: Id | null
  snapshot: BeamState | null
}

interface Outcome {
  readonly status: MessageStatus
  readonly stop?: Message['stop']
  readonly error?: MessageError
  readonly refusal?: Message['refusal']
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

const textOfParts = (parts: readonly Part[]): string =>
  parts
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
    .trim()

/** Whether a provider keeps arguments valid against a schema it is told is strict (as the controller decides). */
function strictFor(kind: ProviderKind, schema: Record<string, unknown>): boolean {
  if (kind !== 'anthropic' && kind !== 'openai') return false
  const properties = schema.properties
  const required = schema.required
  if (schema.additionalProperties !== false || properties === null || typeof properties !== 'object') return false
  return Array.isArray(required) && Object.keys(properties as object).every((n) => required.includes(n))
}

const sameRef = (a: ModelRef, b: ModelRef): boolean => a.provider === b.provider && a.id === b.id

export function createBeamEngine(deps: BeamDeps): BeamEngine {
  const ws = deps.workspace
  const beams = new Map<Id, Beam>()
  const listeners = new Set<(conversationId: Id) => void>()
  const refs = new Map<string, Part>()
  let disposed = false

  const newId = (): Id => base32Encode(deps.rng.bytes(16))

  const notify = (conversationId: Id): void => {
    for (const fn of [...listeners]) {
      try {
        fn(conversationId)
      } catch {
        // A failing listener must not break a stream or the other listeners.
      }
    }
  }

  const candidateOf = (s: Stream): Candidate =>
    Object.freeze({
      model: s.model,
      messageId: s.messageId,
      parts: Object.freeze([...s.parts]),
      status: s.status,
      ...(s.usage === undefined ? {} : { usage: s.usage }),
      ...(s.error === undefined ? {} : { error: s.error }),
    })

  const changed = (beam: Beam): void => {
    const all = beam.fusion === null ? beam.streams : [...beam.streams, beam.fusion]
    beam.snapshot = Object.freeze({
      conversationId: beam.conversationId,
      userMessageId: beam.userMessageId,
      mode: beam.mode,
      candidates: Object.freeze(beam.streams.map(candidateOf)),
      fusion: beam.fusion === null ? null : candidateOf(beam.fusion),
      running: all.some((s) => s.status === 'streaming'),
    })
    notify(beam.conversationId)
  }

  const locking = (cause?: unknown) =>
    new InvalidStateError('The vault is locking', cause === undefined ? undefined : { cause })

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

  function conversationOf(id: Id): Conversation {
    const c = ws.conversations.get(id)
    if (c === undefined || c.purgedAt !== undefined) throw new InvalidInputError('Unknown conversation')
    return c
  }

  async function prepare(ref: ModelRef): Promise<Prepared> {
    const descriptor = deps.resolveModel(ref)
    if (descriptor === null) throw new InvalidInputError('Unknown model or provider')
    const provider: ProviderConfig = ws.providers.get(ref.provider) ?? {
      id: ref.provider,
      kind: descriptor.kind,
      label: descriptor.kind,
      syncKey: false,
      createdAt: 0,
      updatedAt: 0,
    }
    const apiKey = await deps.keys.get(provider.id)
    if (apiKey === null && needsKey(provider)) throw new InvalidInputError('The provider needs a key')
    return { descriptor, provider, apiKey }
  }

  function checkModels(models: readonly ModelRef[], min = 1): void {
    if (models.length < min || models.length > MAX_BEAM) {
      throw new InvalidInputError(`A beam takes ${min} to ${MAX_BEAM} models`)
    }
    for (const [i, m] of models.entries()) {
      if (models.findIndex((o) => sameRef(o, m)) !== i) throw new InvalidInputError('A model appears twice')
    }
  }

  async function storable(parts: readonly Part[]): Promise<Part[]> {
    const out: Part[] = []
    for (const part of parts) {
      const clean = defined(part)
      const bytes = utf8(JSON.stringify(clean))
      if (bytes.length > LARGE_PART_BYTES && part.type !== 'ref') {
        const blob = await deps.blobs.put(bytes, PART_MEDIA_TYPE)
        refs.set(blob, clean)
        out.push({ type: 'ref', partType: part.type, blob, size: bytes.length })
      } else out.push(clean)
    }
    return out
  }

  async function resolveRef(part: Extract<Part, { type: 'ref' }>): Promise<Part> {
    const known = refs.get(part.blob)
    if (known !== undefined) return known
    const bytes = await deps.blobs.get(part.blob)
    if (bytes === null) throw new InvalidStateError(`Blob ${part.blob} is not on this device`)
    const parsed = JSON.parse(fromUtf8(bytes)) as Part
    refs.set(part.blob, parsed)
    return parsed
  }

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

  async function promptMessages(plan: ReturnType<typeof planPrompt>): Promise<PromptMessage[]> {
    const messages: PromptMessage[] = []
    for (const planned of plan.messages) {
      const parts: PromptPart[] = []
      for (const part of planned.parts) {
        if (part.type === 'image' || part.type === 'file') {
          const data = await deps.blobs.get(part.blob)
          if (data === null) throw new InvalidStateError(`Blob ${part.blob} is not on this device`)
          parts.push({ ...part, data })
        } else if (part.type !== 'ref') parts.push(part)
      }
      messages.push({ role: planned.role, parts })
    }
    return messages
  }

  function resolveTools(conversation: Conversation): ResolvedTools {
    return deps.tools
      ? deps.tools.registry.resolve(conversation.tools)
      : { declared: [], webSearch: false, drifted: [], missing: [] }
  }

  function effortFor(conversation: Conversation, prepared: Prepared): Effort | null {
    return pickEffort(
      conversation,
      { defaultEffort: ws.settings.get('defaultEffort') },
      prepared.descriptor.capabilities,
    )
  }

  /** The request a regeneration with this model would send (see the invariants), or the merge request. */
  async function buildRequest(
    beam: Beam,
    thread: Thread,
    stream: Stream,
    fusion: readonly string[] | null,
  ): Promise<ChatRequest> {
    const conversation = conversationOf(beam.conversationId)
    const { descriptor } = stream.prepared
    const caps = descriptor.capabilities
    const path = await substituted(thread.path(beam.userMessageId))
    const plan = planPrompt({ conversation, path, kind: descriptor.kind, capabilities: caps })
    const messages = await promptMessages(plan)
    if (fusion !== null) {
      const last = messages.at(-1) as PromptMessage
      messages[messages.length - 1] = { ...last, parts: [...last.parts, { type: 'text', text: fusionPrompt(fusion) }] }
    }
    const resolved = fusion === null ? resolveTools(conversation) : null
    const tools =
      resolved !== null && caps.tools
        ? resolved.declared.map((r) => ({
            name: r.tool.name,
            description: r.tool.description,
            inputSchema: r.tool.inputSchema,
            ...(strictFor(descriptor.kind, r.tool.inputSchema as Record<string, unknown>) ? { strict: true } : {}),
          }))
        : []
    const webSearch = resolved?.webSearch === true && caps.webSearch !== null
    return {
      provider: stream.prepared.provider,
      model: descriptor,
      apiKey: stream.prepared.apiKey,
      system: plan.system,
      messages,
      tools,
      ...(webSearch ? { webSearch: true } : {}),
      effort: effortFor(conversation, stream.prepared),
      signal: stream.abort.signal,
    }
  }

  /** Applies one event to a stream's parts; returns the outcome when it ends the stream. */
  function apply(stream: Stream, open: Map<string, number>, event: ChatEvent): Outcome | null {
    const textIn = (p: Part) => (p.type === 'text' || p.type === 'reasoning' ? p.text : '')
    const grow = (key: string, delta: string, make: (text: string, before: Part | undefined) => Part) => {
      const at = open.get(key)
      if (at === undefined) {
        open.set(key, stream.parts.length)
        stream.parts.push(make(delta, undefined))
      } else {
        const before = stream.parts[at] as Part
        stream.parts[at] = make(textIn(before) + delta, before)
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
        if (at === undefined) stream.parts.push({ type: 'reasoning', text: '', ...meta })
        else stream.parts[at] = { type: 'reasoning', text: textIn(stream.parts[at] as Part), ...meta }
        open.delete(key)
        return null
      }
      case 'tool-call':
        stream.parts.push({
          type: 'tool-call',
          callId: event.callId,
          name: event.name,
          input: event.input,
          ...(event.providerMeta === undefined ? {} : { providerMeta: event.providerMeta }),
        })
        return null
      case 'source':
        stream.parts.push(event.part)
        return null
      case 'provider-block':
        stream.parts.push({ type: 'provider', provider: event.provider, block: event.block })
        return null
      case 'usage':
        stream.usage = event.usage
        return null
      case 'finish':
        if (event.stop === 'refusal') {
          stream.parts = []
          return { status: 'refused', stop: 'refusal', refusal: event.refusal ?? { category: null } }
        }
        return { status: 'done', stop: event.stop }
      case 'error':
        return { status: 'error', error: { code: event.error.code, message: event.error.message } }
      default:
        return null
    }
  }

  async function consume(beam: Beam, thread: Thread, stream: Stream, fusion: readonly string[] | null) {
    const signal = stream.abort.signal
    const stopped: Outcome = { status: 'stopped' }
    try {
      const request = await buildRequest(beam, thread, stream, fusion)
      if (signal.aborted) return stopped
      const open = new Map<string, number>()
      for await (const event of deps.adapter(stream.prepared.descriptor.kind).stream(request)) {
        if (signal.aborted) break
        const outcome = apply(stream, open, event)
        if (outcome !== null) return outcome
        changed(beam)
      }
      if (signal.aborted) return stopped
      return { status: 'error', error: { code: 'truncated', message: '' } } satisfies Outcome
    } catch (error) {
      if (signal.aborted) return stopped
      const message = error instanceof Error ? error.message : String(error)
      return { status: 'error', error: { code: 'invalid-request', message } } satisfies Outcome
    }
  }

  /** Streams one answer and commits it; resolves with the committed message, never rejects. */
  async function run(beam: Beam, thread: Thread, stream: Stream, fusion: readonly string[] | null) {
    const outcome = await consume(beam, thread, stream, fusion)
    try {
      // A merge keeps only what is valid under the stored path: its text and sources (see the invariants).
      const kept =
        outcome.status === 'refused'
          ? []
          : fusion === null
            ? stream.parts
            : stream.parts.filter((p) => p.type === 'text' || p.type === 'source')
      const parts = await storable(kept)
      const usage = stream.usage === undefined ? undefined : defined(stream.usage)
      const effort = effortFor(conversationOf(beam.conversationId), stream.prepared)
      const message: NewMessage = {
        id: stream.messageId,
        parent: beam.userMessageId,
        role: 'assistant',
        parts,
        model: stream.model,
        status: outcome.status,
        ...(usage === undefined ? {} : { usage }),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        ...(outcome.stop === undefined ? {} : { stop: outcome.stop }),
        ...(outcome.refusal === undefined ? {} : { refusal: defined(outcome.refusal) }),
        ...(effort === null ? {} : { effort }),
      }
      ws.batch(() => {
        thread.commit(message)
        if (fusion !== null) thread.setLeaf(stream.messageId)
        else if (beam.leafAtStart !== null && thread.setLeaf(stream.messageId, { ifLeaf: beam.leafAtStart })) {
          // The first answer to arrive becomes the branch shown; the others are its `< 2/3 >` siblings.
          beam.leafAtStart = null
        }
      })
      stream.parts = [...parts]
      stream.status = outcome.status
      if (outcome.error !== undefined) stream.error = outcome.error
      changed(beam)
      return thread.get(stream.messageId) ?? null
    } catch {
      // The workspace closed under the commit (a lock): nothing more to do, the answer is lost with the memory.
      stream.status = 'error'
      changed(beam)
      return null
    }
  }

  function newStream(model: ModelRef, prepared: Prepared): Stream {
    return {
      model,
      prepared,
      messageId: newId(),
      parts: [],
      usage: undefined,
      status: 'streaming',
      abort: new AbortController(),
      done: Promise.resolve(null),
    }
  }

  /** Starts streaming `streams` for `beam`; the holds are released once all are committed and flushed. */
  function launch(beam: Beam, thread: Thread, streams: Stream[], release: () => void): void {
    for (const s of streams) s.done = run(beam, thread, s, null)
    changed(beam)
    void Promise.all(streams.map((s) => s.done)).then(async () => {
      try {
        await ws.flush()
      } catch {
        // A failed save is reported by the workspace's persistence status; the hold must not outlive it.
      } finally {
        release()
      }
    })
  }

  function busy(conversationId: Id): void {
    if (beams.get(conversationId)?.snapshot?.running) throw new InvalidStateError('A beam runs in this conversation')
  }

  async function answer(
    conversationId: Id,
    userMessageId: Id,
    models: readonly ModelRef[],
    mode: 'beam' | 'arena',
    commitUser: ((thread: Thread) => void) | null,
  ): Promise<BeamState> {
    checkModels(models)
    busy(conversationId)
    if (disposed) throw locking()
    conversationOf(conversationId)
    const prepared = await Promise.all(models.map((m) => prepare(m)))
    const thread = await ws.thread(conversationId)
    busy(conversationId)
    if (disposed) throw locking()
    const release = takeHolds()
    try {
      if (commitUser !== null) commitUser(thread)
      else {
        const user = thread.get(userMessageId)
        if (user === undefined || user.role !== 'user') throw new InvalidInputError('Beam answers a user message')
      }
      // The path must give a request at all, or nothing is started.
      planPrompt({
        conversation: conversationOf(conversationId),
        path: thread.path(userMessageId),
        kind: (prepared[0] as Prepared).descriptor.kind,
        capabilities: (prepared[0] as Prepared).descriptor.capabilities,
      })
    } catch (error) {
      release()
      throw error
    }
    const streams = models.map((m, i) => newStream(m, prepared[i] as Prepared))
    const previous = beams.get(conversationId)
    const keep =
      previous !== undefined && previous.userMessageId === userMessageId && previous.mode === mode
        ? previous.streams
        : []
    const beam: Beam = {
      conversationId,
      userMessageId,
      mode,
      streams: [...keep, ...streams],
      fusion: null,
      leafAtStart: conversationOf(conversationId).leaf,
      snapshot: null,
    }
    beams.set(conversationId, beam)
    launch(beam, thread, streams, release)
    return beam.snapshot as BeamState
  }

  return {
    async start(conversationId, parts, models, options = {}) {
      if (parts.length === 0) throw new InvalidInputError('A message needs at least one part')
      checkModels(models)
      busy(conversationId)
      const conversation = conversationOf(conversationId)
      const stored = await storable(parts)
      let snapshot: Conversation['tools'] | null = null
      if (conversation.startedAt === undefined && deps.tools) {
        const names = conversation.tools.filter((t) => t.source !== 'provider').map((t) => t.name)
        const webSearch = conversation.tools.some((t) => t.source === 'provider' && t.name === WEB_SEARCH)
        snapshot = await deps.tools.registry.snapshot(names, { webSearch })
      }
      const id = newId()
      return answer(conversationId, id, models, options.mode ?? 'beam', (thread) => {
        const c = conversationOf(conversationId)
        ws.batch(() => {
          if (snapshot !== null && c.startedAt === undefined)
            ws.conversations.update(conversationId, { tools: snapshot })
          thread.commit({ id, parent: c.leaf, role: 'user', parts: stored, model: null, status: 'done' })
          thread.setLeaf(id)
          if (c.title === '') {
            const title = titleFrom(stored)
            if (title !== '') ws.conversations.update(conversationId, { title })
          }
        })
      })
    },

    answer(conversationId, userMessageId, models, options = {}) {
      return answer(conversationId, userMessageId, models, options.mode ?? 'beam', null)
    },

    async fuse(conversationId, model, from) {
      const beam = beams.get(conversationId)
      if (beam === undefined) throw new InvalidStateError('No beam in this conversation')
      busy(conversationId)
      if (disposed) throw locking()
      const thread = await ws.thread(conversationId)
      const chosen = (from ?? beam.streams.map((s) => s.messageId))
        .map((id) => thread.get(id))
        .filter((m): m is Message => m !== undefined && m.parent === beam.userMessageId && m.role === 'assistant')
      const texts: string[] = []
      for (const m of chosen) {
        if (m.status !== 'done' && m.status !== 'stopped') continue
        const text = textOfParts(await Promise.all(m.parts.map((p) => (p.type === 'ref' ? resolveRef(p) : p))))
        if (text !== '') texts.push(text)
      }
      if (texts.length < 2) throw new InvalidStateError('A merge needs at least two answers with text')
      const prepared = await prepare(model)
      busy(conversationId)
      if (disposed) throw locking()
      const release = takeHolds()
      const stream = newStream(model, prepared)
      beam.fusion = stream
      changed(beam)
      stream.done = run(beam, thread, stream, texts)
      const committed = await stream.done
      try {
        await ws.flush()
      } catch {
        // Reported by the persistence status.
      } finally {
        release()
      }
      if (committed === null) throw new InvalidStateError('The merge was not saved')
      return committed
    },

    async pick(conversationId, messageId) {
      const thread = await ws.thread(conversationId)
      const message = thread.get(messageId)
      if (message === undefined) throw new InvalidInputError('Unknown message')
      thread.setLeaf(thread.descend(messageId))
    },

    stop(conversationId) {
      const beam = beams.get(conversationId)
      if (beam === undefined) return
      for (const s of beam.streams) s.abort.abort()
      beam.fusion?.abort.abort()
    },

    close(conversationId) {
      const beam = beams.get(conversationId)
      if (beam === undefined || beam.snapshot?.running) return
      beams.delete(conversationId)
      notify(conversationId)
    },

    state(conversationId) {
      return beams.get(conversationId)?.snapshot ?? null
    },

    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },

    async dispose() {
      disposed = true
      const pending: Promise<unknown>[] = []
      for (const beam of beams.values()) {
        for (const s of beam.streams) {
          s.abort.abort()
          pending.push(s.done)
        }
        if (beam.fusion !== null) {
          beam.fusion.abort.abort()
          pending.push(beam.fusion.done)
        }
      }
      await Promise.all(pending)
      beams.clear()
      refs.clear()
    },
  }
}
