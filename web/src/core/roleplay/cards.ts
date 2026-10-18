/*
 * Character cards (SillyTavern's format): JSON cards V1 (flat fields), V2 (`spec: 'chara_card_v2'`) and V3
 * (`spec: 'chara_card_v3'`), and PNG cards, whose image carries the JSON base64-encoded in a text chunk (`chara` for
 * V2, `ccv3` for V3; V3 wins when both are there). The result is a Persona (contracts/extras.ts) and, when the card
 * embeds a `character_book`, a Lorebook.
 *
 * Invariants:
 * - A card is untrusted input: only the known fields are read, every string is capped, lists are capped, and nothing
 *   of the card is ever run or rendered as HTML. A PNG is walked chunk by chunk with every length and CRC checked.
 * - The system prompt a card gives is a pure function of its fields (`systemPromptOf`), with the `{{char}}` and
 *   `{{user}}` macros substituted. The greeting (`first_mes`) is folded into it as the opening line: Aparté never
 *   sends an assistant message the model did not write (no prefill, spec/DATA-MODEL.md section 5, rule 9).
 */

import { InvalidInputError } from '../contracts/crypto.ts'
import type { Lorebook, LoreEntry, Persona } from '../contracts/extras.ts'
import { base64urlDecode, fromUtf8, readU32be } from '../crypto/bytes.ts'
import { crc32 } from '../sync/providers/zip.ts'

/** Longest card file read (a PNG with a large image included). */
export const MAX_CARD_BYTES = 16 * 1024 * 1024
/** Longest text field kept. */
export const MAX_FIELD = 64 * 1024
const MAX_NAME = 200
const MAX_LIST = 200
const MAX_ENTRIES = 1000

/** What reading a card gives. */
export interface ParsedCard {
  readonly persona: Persona
  /** The card's embedded lorebook, if any; the importer stores it and links it from `persona.lorebook`. */
  readonly lorebook: Lorebook | null
}

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)

function text(value: unknown, max = MAX_FIELD): string {
  if (typeof value !== 'string') return ''
  return value.length > max ? value.slice(0, max) : value
}

function texts(value: unknown, max = MAX_FIELD): string[] {
  if (!Array.isArray(value)) return []
  return value
    .slice(0, MAX_LIST)
    .map((v) => text(v, max))
    .filter((v) => v.trim() !== '')
}

/** `{{char}}`, `{{user}}` and the older `<BOT>` / `<USER>` replaced (case-insensitive, as SillyTavern does). */
export function substituteMacros(value: string, char: string, user: string): string {
  return value.replace(/\{\{\s*char\s*\}\}|<BOT>/gi, () => char).replace(/\{\{\s*user\s*\}\}|<USER>/gi, () => user)
}

/** The user's name when none is chosen. */
export const DEFAULT_USER = 'User'

/**
 * The system prompt of a character, for a user named `user`: the card's own system prompt, then the description,
 * personality, scenario, the opening line and the example dialogue, each in a labelled block, macros substituted.
 */
export function systemPromptOf(
  card: Pick<
    Persona,
    'name' | 'systemPrompt' | 'description' | 'personality' | 'scenario' | 'firstMessage' | 'examples'
  >,
  user: string = DEFAULT_USER,
): string {
  const char = card.name.trim() === '' ? 'Character' : card.name.trim()
  const blocks: string[] = []
  const own = card.systemPrompt.trim()
  blocks.push(own === '' ? `You are ${char}. Stay in character and write ${char}'s replies.` : own)
  const add = (label: string, value: string | undefined) => {
    const v = value?.trim() ?? ''
    if (v !== '') blocks.push(`${label}:\n${v}`)
  }
  add(`${char}'s description`, card.description)
  add(`${char}'s personality`, card.personality)
  add('Scenario', card.scenario)
  add(`${char}'s opening line (already shown to ${user})`, card.firstMessage)
  add('Example dialogue', card.examples)
  return substituteMacros(blocks.join('\n\n'), char, user)
}

function standardBase64(value: string): Uint8Array {
  const clean = value.replace(/\s+/g, '').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  return base64urlDecode(clean)
}

function lorebookOf(book: unknown, fallbackName: string): Lorebook | null {
  if (!isObject(book) || !Array.isArray(book.entries)) return null
  const entries: LoreEntry[] = []
  for (const [i, raw] of book.entries.slice(0, MAX_ENTRIES).entries()) {
    if (!isObject(raw)) continue
    const content = text(raw.content)
    if (content.trim() === '') continue
    const triggers = texts(raw.keys, MAX_NAME)
    const selective = raw.selective === true
    const secondary = selective ? texts(raw.secondary_keys, MAX_NAME) : []
    const order =
      typeof raw.insertion_order === 'number' && Number.isFinite(raw.insertion_order) ? raw.insertion_order : i
    const comment = text(raw.comment ?? raw.name, MAX_NAME)
    const entry: LoreEntry = {
      triggers,
      content,
      enabled: raw.enabled !== false,
      order: Math.round(order),
      ...(secondary.length > 0 ? { secondary } : {}),
      ...(raw.constant === true ? { constant: true } : {}),
      ...(raw.case_sensitive === true ? { caseSensitive: true } : {}),
      ...(comment !== '' ? { comment } : {}),
    }
    entries.push(entry)
  }
  const depth = typeof book.scan_depth === 'number' && Number.isFinite(book.scan_depth) ? book.scan_depth : 4
  const budget =
    typeof book.token_budget === 'number' && Number.isFinite(book.token_budget) ? book.token_budget * 4 : 4000
  const name = text(book.name, MAX_NAME).trim()
  const description = text(book.description).trim()
  return {
    name: name === '' ? fallbackName : name,
    entries,
    scanDepth: Math.max(1, Math.min(100, Math.round(depth))),
    budget: Math.max(100, Math.min(100_000, Math.round(budget))),
    ...(description !== '' ? { description } : {}),
  }
}

/** A card from its parsed JSON; InvalidInputError when it is not one. */
export function cardFromJson(value: unknown): ParsedCard {
  if (!isObject(value)) throw new InvalidInputError('A character card is a JSON object')
  let data: Json
  let source: Persona['source']
  if (value.spec === 'chara_card_v3' && isObject(value.data)) {
    data = value.data
    source = 'card-v3'
  } else if (value.spec === 'chara_card_v2' && isObject(value.data)) {
    data = value.data
    source = 'card-v2'
  } else if (typeof value.name === 'string' || typeof value.char_name === 'string') {
    // V1: the fields at the top level (some exporters named them char_*).
    data = {
      name: value.name ?? value.char_name,
      description: value.description ?? value.char_persona,
      personality: value.personality,
      scenario: value.scenario ?? value.world_scenario,
      first_mes: value.first_mes ?? value.char_greeting,
      mes_example: value.mes_example ?? value.example_dialogue,
    }
    source = 'card-v2'
  } else {
    throw new InvalidInputError('Not a character card')
  }
  const name = text(data.name, MAX_NAME).trim()
  if (name === '') throw new InvalidInputError('The card has no name')
  const fields = {
    description: text(data.description).trim(),
    personality: text(data.personality).trim(),
    scenario: text(data.scenario).trim(),
    firstMessage: text(data.first_mes).trim(),
    examples: text(data.mes_example).trim(),
    creator: text(data.creator, MAX_NAME).trim(),
    creatorNotes: text(data.creator_notes).trim(),
  }
  const own = text(data.system_prompt).trim()
  const greetings = texts(data.alternate_greetings)
  const tags = texts(data.tags, MAX_NAME)
  const persona: Persona = {
    name,
    systemPrompt: '',
    ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== '')),
    ...(greetings.length > 0 ? { alternateGreetings: greetings } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    source,
  }
  // The stored prompt is the card's own (with `{{original}}`, SillyTavern's placeholder for the default, dropped); the
  // full prompt is built from every field when the character is used, for the user's name then.
  const stored = own.replace(/\{\{\s*original\s*\}\}/gi, '').trim()
  return {
    persona: { ...persona, systemPrompt: stored },
    lorebook: lorebookOf(data.character_book, `${name}`),
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}

const latin1 = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += String.fromCharCode(b)
  return out
}

/** The uncompressed text chunks of a PNG, by keyword; InvalidInputError for a damaged file. */
export function pngTexts(bytes: Uint8Array): Map<string, string> {
  if (bytes.length > MAX_CARD_BYTES) throw new InvalidInputError('The card is too large')
  if (!isPng(bytes)) throw new InvalidInputError('Not a PNG image')
  const out = new Map<string, string>()
  let at = 8
  let ended = false
  while (at < bytes.length) {
    if (at + 12 > bytes.length) throw new InvalidInputError('A PNG chunk is cut short')
    const length = readU32be(bytes, at)
    if (length > bytes.length - at - 12) throw new InvalidInputError('A PNG chunk is longer than the file')
    const typeAndData = bytes.subarray(at + 4, at + 8 + length)
    const type = latin1(bytes.subarray(at + 4, at + 8))
    const crc = readU32be(bytes, at + 8 + length)
    if (crc32(typeAndData) !== crc) throw new InvalidInputError(`The PNG chunk ${type} is damaged`)
    const data = bytes.subarray(at + 8, at + 8 + length)
    if (type === 'tEXt') {
      const nul = data.indexOf(0)
      if (nul > 0) out.set(latin1(data.subarray(0, nul)), latin1(data.subarray(nul + 1)))
    } else if (type === 'iTXt') {
      const nul = data.indexOf(0)
      // keyword \0 compression-flag compression-method language \0 translated \0 text; compressed text is skipped.
      if (nul > 0 && data[nul + 1] === 0) {
        const lang = data.indexOf(0, nul + 3)
        const translated = lang < 0 ? -1 : data.indexOf(0, lang + 1)
        if (translated >= 0) out.set(latin1(data.subarray(0, nul)), fromUtf8(data.subarray(translated + 1)))
      }
    } else if (type === 'IEND') {
      ended = true
      break
    }
    at += 12 + length
  }
  if (!ended) throw new InvalidInputError('The PNG has no end')
  return out
}

/** A card from a PNG image (`ccv3` preferred over `chara`). */
export function cardFromPng(bytes: Uint8Array): ParsedCard {
  const chunks = pngTexts(bytes)
  const raw = chunks.get('ccv3') ?? chunks.get('chara')
  if (raw === undefined) throw new InvalidInputError('This image holds no character card')
  let json: unknown
  try {
    json = JSON.parse(fromUtf8(standardBase64(raw)))
  } catch (cause) {
    throw new InvalidInputError('The card in this image is not readable', { cause })
  }
  return cardFromJson(json)
}

/** A card from a file's bytes, PNG or JSON. */
export function readCard(bytes: Uint8Array): ParsedCard {
  if (bytes.length > MAX_CARD_BYTES) throw new InvalidInputError('The card is too large')
  if (isPng(bytes)) return cardFromPng(bytes)
  let json: unknown
  try {
    json = JSON.parse(fromUtf8(bytes))
  } catch (cause) {
    throw new InvalidInputError('Not a JSON or PNG character card', { cause })
  }
  return cardFromJson(json)
}

/** A character as a V2 JSON card, its lorebook embedded when given. */
export function toCardV2(persona: Persona, lorebook?: Lorebook | null): Json {
  const data: Json = {
    name: persona.name,
    description: persona.description ?? '',
    personality: persona.personality ?? '',
    scenario: persona.scenario ?? '',
    first_mes: persona.firstMessage ?? '',
    mes_example: persona.examples ?? '',
    creator_notes: persona.creatorNotes ?? '',
    system_prompt: persona.systemPrompt,
    post_history_instructions: '',
    alternate_greetings: [...(persona.alternateGreetings ?? [])],
    tags: [...(persona.tags ?? [])],
    creator: persona.creator ?? '',
    character_version: '',
    extensions: {},
  }
  if (lorebook) {
    data.character_book = {
      name: lorebook.name,
      scan_depth: lorebook.scanDepth,
      token_budget: Math.round(lorebook.budget / 4),
      extensions: {},
      entries: lorebook.entries.map((e, i) => ({
        keys: [...e.triggers],
        secondary_keys: [...(e.secondary ?? [])],
        selective: (e.secondary?.length ?? 0) > 0,
        content: e.content,
        enabled: e.enabled,
        constant: e.constant === true,
        case_sensitive: e.caseSensitive === true,
        insertion_order: e.order,
        id: i,
        comment: e.comment ?? '',
        extensions: {},
      })),
    }
  }
  return { spec: 'chara_card_v2', spec_version: '2.0', data }
}
