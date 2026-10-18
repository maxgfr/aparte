/*
 * The service worker's side of the share inbox: a share target POST (multipart form data with `title`, `text`, `url`
 * and `files`) becomes one sealed item in the inbox database, encrypted to this device's inbox public key as it
 * arrives. Nothing of the share is written in clear, and nothing is decrypted here: the worker holds no secret.
 */
import type { Rng } from '../contracts/crypto.ts'
import type { InboxStore, SharedContent, SharedFileInfo } from '../contracts/inbox.ts'
import {
  encodeShare,
  MAX_FILES,
  MAX_ITEM_PAYLOAD,
  MAX_ITEMS,
  newItemId,
  parseInboxKey,
  recipientOf,
  sealItem,
} from './inbox.ts'

/** What became of a share: stored, or refused and why (the page says so; nothing was kept). */
export type ReceiveOutcome = 'stored' | 'no-key' | 'full' | 'too-large' | 'empty' | 'invalid'

export const RECEIVE_OUTCOMES: readonly ReceiveOutcome[] = ['stored', 'no-key', 'full', 'too-large', 'empty', 'invalid']

/** The part of FormData read here (a test passes a plain one). */
export interface FormLike {
  get(name: string): unknown
  getAll(name: string): unknown[]
}

/** A file of the form, as FormData hands it: a Blob with a name. */
interface FileLike {
  readonly name?: string
  readonly type: string
  readonly size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

const isFile = (v: unknown): v is FileLike =>
  typeof v === 'object' && v !== null && typeof (v as FileLike).arrayBuffer === 'function'

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/
/** Characters a file name never keeps: controls, and the path separators a sharing app could slip in. */
const UNSAFE_NAME = /[\p{Cc}\p{Cf}/\\]/gu
/** Lone surrogates, which the format refuses: replaced by U+FFFD, as a text decoder would. */
const LONE_SURROGATE = /\p{Cs}/gu

const wellFormed = (s: string): string => s.replace(LONE_SURROGATE, '\uFFFD')

function text(form: FormLike, name: string): string | undefined {
  const value = form.get(name)
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : wellFormed(trimmed)
}

function fileInfo(file: FileLike, index: number): SharedFileInfo {
  const type = file.type.toLowerCase().split(';')[0]?.trim() ?? ''
  const cleaned = wellFormed((file.name ?? '').replace(UNSAFE_NAME, '').trim().slice(0, 255))
  return {
    name: cleaned === '' ? `shared-${index + 1}` : cleaned,
    type: MEDIA_TYPE.test(type) && type.length <= 127 ? type : 'application/octet-stream',
    size: file.size,
  }
}

/** The share as the item payload carries it; null when it holds nothing. RangeError when it is too large. */
export async function shareContent(form: FormLike, now: number): Promise<SharedContent | null> {
  const files = form
    .getAll('files')
    .filter(isFile)
    .filter((f) => f.size > 0)
  if (files.length > MAX_FILES) throw new RangeError(`A share holds at most ${MAX_FILES} files`)
  const total = files.reduce((sum, f) => sum + f.size, 0)
  if (total > MAX_ITEM_PAYLOAD) throw new RangeError('The share is above 64 MiB')
  const title = text(form, 'title')
  const body = text(form, 'text')
  const url = text(form, 'url')
  if (files.length === 0 && title === undefined && body === undefined && url === undefined) return null
  const bytes = await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer())))
  return {
    header: {
      v: 1,
      time: now,
      ...(title === undefined ? {} : { title }),
      ...(body === undefined ? {} : { text: body }),
      ...(url === undefined ? {} : { url }),
      files: files.map(fileInfo),
    },
    files: bytes,
  }
}

/** Seals the share of `form` into the inbox. Never throws: the outcome says what happened. */
export async function receiveShare(input: {
  readonly store: InboxStore | null
  readonly form: FormLike
  readonly rng: Rng
  readonly now: number
}): Promise<ReceiveOutcome> {
  const { store } = input
  if (store === null) return 'no-key'
  let content: SharedContent | null
  try {
    content = await shareContent(input.form, input.now)
  } catch (error) {
    return error instanceof RangeError ? 'too-large' : 'invalid'
  }
  if (content === null) return 'empty'
  try {
    const file = await store.keyFile()
    if (file === null) return 'no-key'
    const recipient = recipientOf(parseInboxKey(file))
    if ((await store.count()) >= MAX_ITEMS) return 'full'
    let payload: Uint8Array
    try {
      payload = encodeShare(content)
    } catch {
      return 'too-large'
    }
    const sealed = await sealItem(recipient, payload, input.rng)
    payload.fill(0)
    for (const bytes of content.files) bytes.fill(0)
    await store.addItem({ id: newItemId(input.rng), bytes: sealed })
    return 'stored'
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === 'invalid-state' ? 'full' : 'invalid'
  }
}
