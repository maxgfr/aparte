/*
 * What the sync layer needs of Yjs: merging a document's pending updates into the one update of a segment, and
 * finding the blob manifests an update references (the `blobs` member of a segment header, spec/FORMAT.md section
 * 9.1). Both work on encoded v2 updates only; no document is built here (web/src/core/workspace/workspace.ts holds
 * the documents).
 */

import * as Y from 'yjs'
import type { Bytes } from '../contracts/crypto.ts'

const ID26 = /^[a-z2-7]{26}$/
/** Values deeper than this are not walked: a part never nests so far, and a hostile update cannot make us recurse. */
const MAX_DEPTH = 32

/** One v2 update holding all of `updates`. */
export function mergeUpdates(updates: readonly Uint8Array[]): Bytes {
  if (updates.length === 1) return new Uint8Array(updates[0] as Uint8Array) as Bytes
  return new Uint8Array(Y.mergeUpdatesV2(updates as Uint8Array[])) as Bytes
}

/**
 * Manifest ids an update references: every string value of a `blob` member inside a JSON value the update writes
 * (image, file and artifact parts, `ref` parts, avatars, knowledge documents; spec/DATA-MODEL.md section 4.4).
 */
export function blobRefs(update: Uint8Array): Set<string> {
  const out = new Set<string>()
  const walk = (value: unknown, depth: number): void => {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object' || value instanceof Uint8Array) return
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === 'blob' && typeof item === 'string' && ID26.test(item)) out.add(item)
      else walk(item, depth + 1)
    }
  }
  const { structs } = Y.decodeUpdateV2(update)
  for (const struct of structs) {
    if (struct instanceof Y.Item && struct.content instanceof Y.ContentAny) {
      for (const value of struct.content.arr) walk(value, 0)
    }
  }
  return out
}
