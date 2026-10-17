/*
 * Full-text search over the decrypted conversation titles and message text of an open workspace.
 *
 * Invariants:
 * - The index lives in memory only: nothing it holds is ever written anywhere, and `dispose()` (on lock) drops it.
 *   It is rebuilt from the documents after each unlock.
 * - It reads the workspace and never writes to it. Trashed and purged conversations, and deleted messages, are left
 *   out; archived conversations stay searchable (spec/DATA-MODEL.md section 3.2).
 * - The engine (minisearch) is loaded on first use, so it is no part of the first screen's code.
 * - Results carry plain text and character ranges, never markup: the view highlights them with text nodes.
 */

import type MiniSearch from 'minisearch'
import type { SearchResult } from 'minisearch'
import { LockedError } from '../contracts/crypto.ts'
import type { Conversation, Id, Message, Thread, Workspace } from '../contracts/workspace.ts'

/** A piece of a message around its first match; `highlights` are [start, end) offsets into `text`. */
export interface Snippet {
  readonly text: string
  readonly highlights: readonly (readonly [number, number])[]
}

export interface SearchHit {
  readonly conversation: Id
  readonly title: string
  /** Best score among the conversation's matches. */
  readonly score: number
  /** Whether the title matched. */
  readonly titleMatch: boolean
  /** Matching messages, best first, at most `messagesPerHit`. */
  readonly messages: readonly { readonly id: Id; readonly snippet: Snippet }[]
}

export interface SearchOptions {
  /** Conversations returned; default 50. */
  readonly limit?: number
  /** Messages per conversation; default 3. */
  readonly messagesPerHit?: number
}

export interface SearchIndex {
  /** Resolves once every conversation's messages are indexed (loading every shard that holds one). */
  ready(): Promise<void>
  /** Whether the first full indexing is still running. */
  indexing(): boolean
  /** Hits for `query`, best first; an empty query gives none. Rejects with LockedError once disposed. */
  search(query: string, options?: SearchOptions): Promise<readonly SearchHit[]>
  /** Calls `fn` when the indexed content changes (to re-run a query); returns the unsubscribe function. */
  subscribe(fn: () => void): () => void
  /** Drops the index and every text it holds; later searches reject with LockedError. Idempotent. */
  dispose(): void
}

export interface SearchDeps {
  readonly workspace: Workspace
  /** Registers a cleanup run when the vault locks (`vault.onLock`); the index disposes itself then. */
  readonly onLock?: (cleanup: () => void) => () => void
  /** Loads the engine; defaults to a dynamic import of minisearch. */
  readonly engine?: () => Promise<typeof MiniSearch>
}

interface Doc {
  readonly id: string
  readonly conv: Id
  readonly kind: 'title' | 'message'
  readonly message?: Id
  readonly title?: string
  readonly text?: string
}

const SNIPPET_BEFORE = 40
const SNIPPET_LENGTH = 180

/** Lowercase and strip diacritics: "Élève" -> "eleve". */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
}

/** The folded text and, for each of its code units, the offset of the original code unit it came from. */
function foldWithOffsets(text: string): { readonly folded: string; readonly offsets: readonly number[] } {
  let folded = ''
  const offsets: number[] = []
  let i = 0
  for (const char of text) {
    const f = fold(char)
    folded += f
    for (let k = 0; k < f.length; k++) offsets.push(i)
    i += char.length
  }
  offsets.push(text.length)
  return { folded, offsets }
}

/** The searchable text of a message: its text parts, in order. */
export function messageText(message: Message): string {
  const out: string[] = []
  for (const part of message.parts) if (part.type === 'text' && part.text.trim() !== '') out.push(part.text)
  return out.join('\n\n')
}

/** A window of `text` around the first occurrence of one of `terms` (folded), with every occurrence in it. */
export function snippetOf(text: string, terms: readonly string[]): Snippet {
  const { folded, offsets } = foldWithOffsets(text)
  const ranges: [number, number][] = []
  for (const term of terms) {
    if (term === '') continue
    for (let at = folded.indexOf(term); at >= 0; at = folded.indexOf(term, at + term.length)) {
      const start = offsets[at] ?? 0
      const end = offsets[at + term.length] ?? text.length
      ranges.push([start, end])
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const first = ranges[0]?.[0] ?? 0
  let start = Math.max(0, first - SNIPPET_BEFORE)
  // Starts at a word boundary when one is close, so the snippet does not open mid-word.
  if (start > 0) {
    const space = text.lastIndexOf(' ', start)
    if (space >= 0 && start - space < 15) start = space + 1
  }
  let end = Math.min(text.length, start + SNIPPET_LENGTH)
  // Never cuts a surrogate pair in two.
  if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--
  const prefix = start > 0 ? '…' : ''
  const suffix = end < text.length ? '…' : ''
  const body = text.slice(start, end).replace(/\s+/g, ' ')
  // Whitespace runs collapse to one space: offsets are recomputed on the collapsed body.
  const window = `${prefix}${body}${suffix}`
  const highlights: [number, number][] = []
  const foldedWindow = foldWithOffsets(window)
  for (const term of terms) {
    if (term === '') continue
    for (
      let at = foldedWindow.folded.indexOf(term);
      at >= 0;
      at = foldedWindow.folded.indexOf(term, at + term.length)
    ) {
      highlights.push([foldedWindow.offsets[at] ?? 0, foldedWindow.offsets[at + term.length] ?? window.length])
    }
  }
  highlights.sort((a, b) => a[0] - b[0] || b[1] - a[1])
  const merged: [number, number][] = []
  for (const range of highlights) {
    const last = merged.at(-1)
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([range[0], range[1]])
  }
  return Object.freeze({ text: window, highlights: Object.freeze(merged.map((r) => Object.freeze(r))) })
}

const defaultEngine = async (): Promise<typeof MiniSearch> => (await import('minisearch')).default

export function createSearch(deps: SearchDeps): SearchIndex {
  const { workspace } = deps
  let disposed = false
  let engine: MiniSearch<Doc> | null = null
  let engineLoad: Promise<MiniSearch<Doc>> | null = null
  /** Indexed title per conversation, to skip a re-index when it did not change. */
  const titles = new Map<Id, string>()
  /** Indexed message texts, by message id, kept for the snippets. */
  const texts = new Map<Id, { readonly conv: Id; readonly text: string }>()
  const messagesOf = new Map<Id, Set<Id>>()
  const watches = new Map<Id, () => void>()
  const listeners = new Set<() => void>()
  const unsubscribers: (() => void)[] = []
  let building = true
  let resolveReady: () => void = () => {}
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  const changed = (): void => {
    for (const fn of [...listeners]) fn()
  }

  const load = (): Promise<MiniSearch<Doc>> => {
    engineLoad ??= (deps.engine ?? defaultEngine)().then((Engine) => {
      if (disposed) throw new LockedError('The search index was disposed')
      engine = new Engine<Doc>({
        fields: ['title', 'text'],
        storeFields: ['conv', 'kind', 'message'],
        processTerm: (term) => fold(term),
        searchOptions: { prefix: true, fuzzy: 0.2, boost: { title: 2 }, combineWith: 'AND' },
      })
      return engine
    })
    return engineLoad
  }

  const visible = (): Conversation[] => [
    ...workspace.conversations.list(),
    ...workspace.conversations.list({ archived: true }),
  ]

  const dropConversation = (ms: MiniSearch<Doc>, conv: Id): void => {
    if (titles.delete(conv) && ms.has(`t:${conv}`)) ms.discard(`t:${conv}`)
    for (const id of messagesOf.get(conv) ?? []) {
      texts.delete(id)
      if (ms.has(`m:${id}`)) ms.discard(`m:${id}`)
    }
    messagesOf.delete(conv)
    watches.get(conv)?.()
    watches.delete(conv)
  }

  const syncMessages = (ms: MiniSearch<Doc>, conv: Id, thread: Thread): boolean => {
    let set = messagesOf.get(conv)
    if (!set) {
      set = new Set()
      messagesOf.set(conv, set)
    }
    const current = new Map<Id, string>()
    for (const message of thread.all()) {
      if (message.deletedAt !== undefined || (message.role !== 'user' && message.role !== 'assistant')) continue
      const text = messageText(message)
      if (text !== '') current.set(message.id, text)
    }
    let dirty = false
    for (const id of [...set]) {
      if (current.has(id)) continue
      set.delete(id)
      texts.delete(id)
      if (ms.has(`m:${id}`)) ms.discard(`m:${id}`)
      dirty = true
    }
    // Messages are immutable once committed, so an indexed message never needs re-indexing.
    for (const [id, text] of current) {
      if (set.has(id)) continue
      set.add(id)
      texts.set(id, { conv, text })
      ms.add({ id: `m:${id}`, conv, kind: 'message', message: id, text })
      dirty = true
    }
    return dirty
  }

  const watch = async (ms: MiniSearch<Doc>, conv: Id): Promise<void> => {
    if (watches.has(conv)) return
    let thread: Thread | null = null
    const off = workspace.subscribe({ conversation: conv }, () => {
      if (!disposed && thread && watches.has(conv) && syncMessages(ms, conv, thread)) changed()
    })
    watches.set(conv, off)
    try {
      thread = await workspace.thread(conv)
    } catch {
      // Purged or locked meanwhile: the next conversations sync drops it.
      return
    }
    if (disposed || !watches.has(conv)) return
    if (syncMessages(ms, conv, thread)) changed()
  }

  const syncConversations = (ms: MiniSearch<Doc>): Id[] => {
    const now = new Map(visible().map((c) => [c.id, c]))
    let dirty = false
    for (const conv of [...titles.keys()]) {
      if (now.has(conv)) continue
      dropConversation(ms, conv)
      dirty = true
    }
    const added: Id[] = []
    for (const [conv, c] of now) {
      const before = titles.get(conv)
      if (before === c.title) continue
      if (before !== undefined && ms.has(`t:${conv}`)) ms.discard(`t:${conv}`)
      if (before === undefined) added.push(conv)
      titles.set(conv, c.title)
      ms.add({ id: `t:${conv}`, conv, kind: 'title', title: c.title })
      dirty = true
    }
    if (dirty) changed()
    return added
  }

  const build = async (): Promise<void> => {
    try {
      const ms = await load()
      if (disposed) return
      unsubscribers.push(
        workspace.subscribe('conversations', () => {
          if (disposed) return
          for (const conv of syncConversations(ms)) void watch(ms, conv)
        }),
      )
      const added = syncConversations(ms)
      // One conversation at a time: each first visit to a shard decrypts it, and the UI stays responsive meanwhile.
      for (const conv of added) {
        if (disposed) return
        await watch(ms, conv)
      }
    } catch {
      // Locked (or disposed) during the build: there is nothing left to index.
    } finally {
      building = false
      resolveReady()
    }
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const off of [...unsubscribers, ...watches.values()]) {
      try {
        off()
      } catch {
        // The workspace may already be closed.
      }
    }
    unsubscribers.length = 0
    watches.clear()
    engine?.removeAll()
    engine = null
    titles.clear()
    texts.clear()
    messagesOf.clear()
    listeners.clear()
    building = false
    resolveReady()
  }

  if (deps.onLock) {
    const off = deps.onLock(dispose)
    unsubscribers.push(off)
  }
  void build()

  return {
    ready: () => readyPromise,
    indexing: () => building,
    async search(query, options = {}) {
      if (disposed) throw new LockedError('The search index was disposed')
      const ms = await load()
      if (disposed) throw new LockedError('The search index was disposed')
      if (query.trim() === '') return []
      const limit = options.limit ?? 50
      const perHit = options.messagesPerHit ?? 3
      const groups = new Map<Id, { score: number; titleMatch: boolean; results: SearchResult[] }>()
      for (const result of ms.search(query)) {
        const conv = result.conv as Id
        if (!titles.has(conv)) continue
        let group = groups.get(conv)
        if (!group) {
          group = { score: result.score, titleMatch: false, results: [] }
          groups.set(conv, group)
        }
        group.score = Math.max(group.score, result.score)
        if (result.kind === 'title') group.titleMatch = true
        else group.results.push(result)
      }
      const hits: SearchHit[] = []
      for (const [conv, group] of groups) {
        const messages = group.results.slice(0, perHit).flatMap((result) => {
          const id = result.message as Id
          const entry = texts.get(id)
          return entry ? [Object.freeze({ id, snippet: snippetOf(entry.text, result.terms) })] : []
        })
        hits.push(
          Object.freeze({
            conversation: conv,
            title: titles.get(conv) ?? '',
            score: group.score,
            titleMatch: group.titleMatch,
            messages: Object.freeze(messages),
          }),
        )
      }
      hits.sort((a, b) => b.score - a.score || (a.conversation < b.conversation ? -1 : 1))
      return Object.freeze(hits.slice(0, limit))
    },
    subscribe(fn) {
      if (disposed) return () => {}
      const entry = (): void => fn()
      listeners.add(entry)
      return () => {
        listeners.delete(entry)
      }
    },
    dispose,
  }
}
