/*
 * Contract of the collections milestone M9 adds to the index document (spec/DATA-MODEL.md section 3.6): characters,
 * lorebooks, quick replies, regex rules, per-chat roleplay options and Arena votes. They are entities like the others
 * (`id`, `createdAt`, `updatedAt`, trash fields), stored as one `Y.Map` per entity in a top-level map named after the
 * collection, and read through `Workspace.collection(name)` (contracts/workspace.ts).
 *
 * Invariants:
 * - Every field is a Yjs `Any` value; an optional field that is absent is not set. A value that looks like an API key
 *   or a field whose name says it holds a secret is refused, as for providers: nothing here is a secret.
 * - Field names never contain `key`, `token`, `secret`, `password`, `auth` or `credential` (the workspace's secret
 *   guard refuses them), which is why a lorebook entry has `triggers`, a budget is `budget` and the Author's Note
 *   is `note`.
 * - Nothing here rewrites a conversation: what a character, a lorebook or an Author's Note adds to a request is
 *   committed with the user message it goes with (`injected` text parts), and a persona switch is a `system` message
 *   (spec/DATA-MODEL.md section 5, rules 1 and 4).
 * - Arena ratings are not stored: they are recomputed from the votes, so two devices voting at once never conflict.
 */

import type { Skill } from './skills.ts'
import type { Id, ModelRef } from './workspace.ts'

/**
 * A character (SillyTavern character card V2 or V3, or written by hand), in the `personas` map the data model already
 * names. `systemPrompt` is what the conversation's system prompt (or a mid-conversation system message) becomes when
 * the character is chosen; the card's other fields are kept so the card can be shown and exported again.
 */
export interface Persona {
  readonly name: string
  readonly systemPrompt: string
  readonly description?: string
  readonly personality?: string
  readonly scenario?: string
  /** The card's `first_mes`: shown as the character's opening line, never sent as an assistant message. */
  readonly firstMessage?: string
  readonly alternateGreetings?: readonly string[]
  /** The card's `mes_example`. */
  readonly examples?: string
  readonly creator?: string
  readonly creatorNotes?: string
  readonly tags?: readonly string[]
  /** The card's embedded lorebook, imported as a lorebook of its own. */
  readonly lorebook?: Id
  /** Manifest id of the card's image (a PNG card), stored as an encrypted blob. */
  readonly avatar?: string
  /** Where it came from. */
  readonly source?: 'card-v2' | 'card-v3' | 'manual'
  readonly model?: ModelRef
}

/** One entry of a lorebook: injected when one of its triggers appears in the recent messages. */
export interface LoreEntry {
  /** Words or phrases; an entry with none never triggers (unless `constant`). */
  readonly triggers: readonly string[]
  /** When set, at least one of these must also appear (SillyTavern's secondary keys, AND logic). */
  readonly secondary?: readonly string[]
  readonly content: string
  readonly enabled: boolean
  /** Always injected, triggers or not. */
  readonly constant?: boolean
  readonly caseSensitive?: boolean
  /** Match whole words only (default true). */
  readonly wholeWord?: boolean
  /** Lower first; ties keep the entry order. */
  readonly order: number
  readonly comment?: string
}

export interface Lorebook {
  readonly name: string
  readonly description?: string
  readonly entries: readonly LoreEntry[]
  /** How many of the latest messages (the new user message included) are scanned for triggers. */
  readonly scanDepth: number
  /** At most this many characters of entries are injected per turn (the lowest `order` first). */
  readonly budget: number
}

/** A canned message the user sends with one tap, above the composer. */
export interface QuickReply {
  readonly label: string
  readonly text: string
  /** Fractional index (core/workspace/order.ts) among the quick replies. */
  readonly order: string
}

/**
 * A find-and-replace rule (SillyTavern's regex scripts). `input` rules rewrite what the user typed before it is
 * committed; `display` rules change how answers are shown, never what is stored or sent.
 */
export interface RegexRule {
  readonly name: string
  /** A JavaScript regular expression source. */
  readonly find: string
  /** Flags among `gimsu`. */
  readonly flags: string
  /** The replacement, with `$1`-style groups and `{{char}}` / `{{user}}`. */
  readonly replace: string
  readonly placement: 'input' | 'display'
  readonly enabled: boolean
}

/**
 * Roleplay options of one conversation, stored under the conversation's own id. What they add to a turn is computed
 * when the user message is sent and committed with it.
 */
export interface ChatOptions {
  /** The character the conversation plays now; switching appends a `system` message. */
  readonly character?: Id
  /** Who the user is, for `{{user}}`. */
  readonly userName?: string
  readonly lorebooks?: readonly Id[]
  /** Author's Note (named `note`: the secret guard refuses any field name containing "auth"). */
  readonly note?: string
  /** The note is injected into every `noteEvery`-th user turn (default 1: every turn). */
  readonly noteEvery?: number
}

/** The outcome of an Arena round. `bad`: both answers were poor; rated as a tie (as LMSYS Chatbot Arena does). */
export type ArenaWinner = 'a' | 'b' | 'tie' | 'bad'

/** One Arena vote: two models answered the same prompt blind, the user chose. */
export interface ArenaVote {
  readonly a: ModelRef
  readonly b: ModelRef
  readonly winner: ArenaWinner
  /** The conversation the round was played in (its two answers are siblings). */
  readonly conversation: Id
}

/** The collections and the shape of their entities. */
export interface CollectionTypes {
  readonly personas: Persona
  readonly lorebooks: Lorebook
  readonly quickReplies: QuickReply
  readonly regexRules: RegexRule
  readonly chatOptions: ChatOptions
  readonly arenaVotes: ArenaVote
  /** The skills map the data model names in its section 3 (contracts/skills.ts), stored like the collections. */
  readonly skills: Skill
}

export type CollectionName = keyof CollectionTypes

export const COLLECTIONS: readonly CollectionName[] = [
  'personas',
  'lorebooks',
  'quickReplies',
  'regexRules',
  'chatOptions',
  'arenaVotes',
  'skills',
]

/**
 * The `injected` member of a text part a feature added to a user message (spec/DATA-MODEL.md section 3.6): roleplay
 * context, the list of available skills (contracts/skills.ts) and the Deep research playbook (contracts/research.ts).
 */
export type Injected = 'lorebook' | 'authors-note' | 'character' | 'skills' | 'research'
