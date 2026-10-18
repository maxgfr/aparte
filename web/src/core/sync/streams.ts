/*
 * Segments and checkpoints as objects (spec/FORMAT.md sections 8.4, 8.5, 9.1 and 9.2): opening one checks its
 * envelope and then that its header names the object it was read under, and the object mirror of this device is
 * read back as the updates a document is made of.
 */

import { type Bytes, CorruptError, type DocId, type ParsedName, type Subkeys } from '../contracts/crypto.ts'
import type { ObjectMirror } from '../contracts/store.ts'
import { openEnvelope } from '../crypto/envelope.ts'
import { docTag, parseName } from '../crypto/names.ts'
import { decodeStreamPayload, type StreamPayload } from './framing.ts'

export const DOC_IDS: readonly DocId[] = [
  'index',
  ...Array.from({ length: 16 }, (_, i) => `c${String(i).padStart(2, '0')}` as DocId),
]

/** The `stag` of every document, both ways. */
export interface DocTags {
  readonly byDoc: ReadonlyMap<DocId, string>
  readonly byTag: ReadonlyMap<string, DocId>
}

const tagCache = new WeakMap<Subkeys, Promise<DocTags>>()

export function docTags(subkeys: Subkeys): Promise<DocTags> {
  let tags = tagCache.get(subkeys)
  if (!tags) {
    tags = (async () => {
      const pairs = await Promise.all(DOC_IDS.map(async (d) => [d, await docTag(subkeys, d)] as const))
      return { byDoc: new Map(pairs), byTag: new Map(pairs.map(([d, t]) => [t, d])) }
    })()
    tagCache.set(subkeys, tags)
  }
  return tags
}

export type StreamName = Extract<ParsedName, { type: 'segment' | 'checkpoint' }>

/** The parsed name when `name` is a segment or a checkpoint, else null. */
export function streamName(name: string): StreamName | null {
  const parsed = parseName(name)
  return parsed !== null && (parsed.type === 'segment' || parsed.type === 'checkpoint') ? parsed : null
}

/**
 * Opens a segment or checkpoint read under `name`: the envelope of the kind the name implies, the strict payload,
 * then the header against the name (`doc` hashes to `stag`, `device` is `dtag`, `seq` is the name's). CorruptError,
 * TamperedError or UnsupportedFormatError otherwise.
 */
export async function openStream(
  subkeys: Subkeys,
  tags: DocTags,
  name: string,
  parsed: StreamName,
  bytes: Uint8Array,
): Promise<StreamPayload> {
  const payload = await openEnvelope(subkeys, { kind: parsed.type === 'segment' ? 1 : 2, name, bytes })
  const decoded = decodeStreamPayload(parsed.type, payload)
  const { header } = decoded
  if (tags.byDoc.get(header.doc) !== parsed.stag) throw new CorruptError('A stream header names another document')
  if (header.device !== parsed.dtag) throw new CorruptError('A stream header names another device')
  if (header.seq !== parsed.seq) throw new CorruptError('A stream header carries another seq')
  return decoded
}

/**
 * The updates of a document held in the object mirror: every checkpoint, then every segment a checkpoint does not
 * cover. Applying all the checkpoints covers, for each device, the highest `covers` among them, so the segments at
 * or below it add nothing. An object that does not open is skipped (the mirror only holds authenticated objects;
 * this keeps one damaged entry from closing a whole document).
 */
export async function mirroredUpdates(objects: ObjectMirror, subkeys: Subkeys, docId: DocId): Promise<Bytes[]> {
  const tags = await docTags(subkeys)
  const stag = tags.byDoc.get(docId) as string
  const names = await objects.names(`d/${stag}/`)
  const covered = new Map<string, number>()
  const out: Bytes[] = []
  const streams = names.map((name) => ({ name, parsed: streamName(name) }))
  for (const pass of ['checkpoint', 'segment'] as const) {
    for (const { name, parsed } of streams) {
      if (parsed === null || parsed.type !== pass) continue
      if (pass === 'segment' && parsed.seq <= (covered.get(parsed.dtag) ?? 0)) continue
      const bytes = await objects.get(name)
      if (bytes === null) continue
      let opened: StreamPayload
      try {
        opened = await openStream(subkeys, tags, name, parsed, bytes)
      } catch {
        continue
      }
      out.push(opened.update)
      for (const [dtag, seq] of Object.entries(opened.header.covers ?? {})) {
        if (seq > (covered.get(dtag) ?? 0)) covered.set(dtag, seq)
      }
    }
  }
  return out
}
