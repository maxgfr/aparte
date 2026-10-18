/*
 * Readers of other apps' conversation exports, each to ImportedConversation (tree.ts). The input is untrusted JSON:
 * every field is checked for its type, anything unexpected is skipped, and a conversation that cannot be read is
 * left out rather than failing the whole file.
 *
 * - ChatGPT (`conversations.json` of the data export): `mapping` is the message tree (`parent`, `children`),
 *   `current_node` the branch on screen. Tool calls (`recipient` other than `all`), tool output, hidden context and
 *   reasoning summaries are dropped; images become the text `[image]`.
 * - Claude (`conversations.json` of the data export): `chat_messages`, `sender` `human` or `assistant`, text in
 *   `content[]` (or `text`); a tree through `parent_message_uuid` when present, else in order. Attachments become
 *   `[attachment: <name>]`.
 * - Open WebUI (the chats export): `chat.history.messages` is the tree (`parentId`), `chat.history.currentId` the
 *   branch on screen, timestamps in seconds; older exports only have the `chat.messages` list.
 */

import { buildTree, cleanTitle, type ImportedConversation, millis, type RawNode } from './tree.ts'

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** The conversations of a ChatGPT export. */
export function fromChatGpt(data: unknown): ImportedConversation[] {
  const out: ImportedConversation[] = []
  for (const conv of list(data)) {
    if (!isObject(conv) || !isObject(conv.mapping)) continue
    const createdAt = millis(conv.create_time, 'seconds') ?? 0
    const raw: RawNode[] = []
    for (const [id, value] of Object.entries(conv.mapping)) {
      if (!isObject(value)) continue
      const parent = str(value.parent)
      const message = isObject(value.message) ? value.message : null
      const role = message !== null && isObject(message.author) ? (str(message.author.role) ?? '') : ''
      const meta = message !== null && isObject(message.metadata) ? message.metadata : {}
      const content = message !== null && isObject(message.content) ? message.content : {}
      const type = str(content.content_type) ?? ''
      const recipient = message === null ? 'all' : (str(message.recipient) ?? 'all')
      const hidden = meta.is_visually_hidden_from_conversation === true || recipient !== 'all'
      let text = ''
      if (!hidden && (type === 'text' || type === 'multimodal_text')) {
        const pieces: string[] = []
        for (const part of list(content.parts)) {
          if (typeof part === 'string') pieces.push(part)
          else if (isObject(part) && str(part.content_type) === 'image_asset_pointer') pieces.push('[image]')
        }
        text = pieces.filter((p) => p.trim() !== '').join('\n\n')
      }
      raw.push({
        key: str(value.id) ?? id,
        parent,
        role,
        text,
        createdAt: millis(message?.create_time, 'seconds'),
      })
    }
    out.push(buildTree(raw, str(conv.current_node), { title: cleanTitle(conv.title), createdAt }))
  }
  return out
}

/** The conversations of a Claude export. */
export function fromClaude(data: unknown): ImportedConversation[] {
  const out: ImportedConversation[] = []
  for (const conv of list(data)) {
    if (!isObject(conv) || !Array.isArray(conv.chat_messages)) continue
    const createdAt = millis(conv.created_at, 'iso') ?? 0
    const messages = conv.chat_messages.filter(isObject)
    const keys = new Set(messages.map((m) => str(m.uuid)).filter((k): k is string => k !== null))
    const tree = messages.some((m) => typeof m.parent_message_uuid === 'string')
    const raw: RawNode[] = []
    let previous: string | null = null
    for (const [i, m] of messages.entries()) {
      const key = str(m.uuid) ?? `m${i}`
      const sender = str(m.sender)
      const role = sender === 'human' ? 'user' : sender === 'assistant' ? 'assistant' : ''
      const pieces: string[] = []
      const content = list(m.content)
      for (const c of content) if (isObject(c) && c.type === 'text' && typeof c.text === 'string') pieces.push(c.text)
      if (content.length === 0 && typeof m.text === 'string') pieces.push(m.text)
      for (const f of [...list(m.attachments), ...list(m.files)]) {
        const name = isObject(f) ? str(f.file_name) : null
        if (name !== null && name !== '') pieces.push(`[attachment: ${name}]`)
      }
      const parentUuid = str(m.parent_message_uuid)
      // The root's parent is a fixed placeholder uuid, which no message has.
      const parent = tree ? (parentUuid !== null && keys.has(parentUuid) ? parentUuid : null) : previous
      raw.push({
        key,
        parent,
        role,
        text: pieces.filter((p) => p.trim() !== '').join('\n\n'),
        createdAt: millis(m.created_at, 'iso'),
      })
      previous = key
    }
    const leaf = str(conv.current_leaf_message_uuid) ?? (tree ? null : previous)
    out.push(buildTree(raw, leaf, { title: cleanTitle(conv.name), createdAt }))
  }
  return out
}

/** The text of an Open WebUI message (a string, or a list of OpenAI-style content parts). */
function webUiText(content: unknown): string {
  if (typeof content === 'string') return content
  return list(content)
    .map((c) => (isObject(c) && c.type === 'text' && typeof c.text === 'string' ? c.text : ''))
    .filter((t) => t !== '')
    .join('\n\n')
}

/** The conversations of an Open WebUI export (an array of chats, or a single one). */
export function fromOpenWebUi(data: unknown): ImportedConversation[] {
  const out: ImportedConversation[] = []
  for (const item of Array.isArray(data) ? data : [data]) {
    if (!isObject(item)) continue
    const chat = isObject(item.chat) ? item.chat : item
    const createdAt = millis(item.created_at ?? chat.timestamp, 'seconds') ?? 0
    const title = cleanTitle(item.title ?? chat.title)
    const history = isObject(chat.history) ? chat.history : null
    const raw: RawNode[] = []
    let leaf: string | null = null
    if (history !== null && isObject(history.messages)) {
      for (const [id, m] of Object.entries(history.messages)) {
        if (!isObject(m)) continue
        raw.push({
          key: str(m.id) ?? id,
          parent: str(m.parentId),
          role: str(m.role) ?? '',
          text: webUiText(m.content),
          createdAt: millis(m.timestamp, 'auto'),
        })
      }
      leaf = str(history.currentId)
    } else {
      let previous: string | null = null
      for (const [i, m] of list(chat.messages).entries()) {
        if (!isObject(m)) continue
        const key = str(m.id) ?? `m${i}`
        raw.push({
          key,
          parent: previous,
          role: str(m.role) ?? '',
          text: webUiText(m.content),
          createdAt: millis(m.timestamp, 'auto'),
        })
        previous = key
      }
      leaf = previous
    }
    out.push(buildTree(raw, leaf, { title, createdAt }))
  }
  return out
}
