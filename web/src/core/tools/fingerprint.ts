/*
 * Tool identity (FingerprintModule in web/src/core/contracts/tools.ts): the approval key that names a tool across
 * versions, and the fingerprint that changes whenever its definition does.
 *
 * Invariants:
 * - The fingerprint is the base64url SHA-256 of RFC 8785 canonical JSON: object members sorted by UTF-16 code units,
 *   no whitespace, strings and numbers as ECMAScript serialises them. Two equal definitions written in a different
 *   member order give the same fingerprint; any changed character gives another one.
 * - Only `name`, `description`, `inputSchema` and `annotations` are hashed: what the model reads and what decides
 *   approval. The display title and the origin are not.
 */
import { InvalidInputError, type JsonValue } from '../contracts/crypto.ts'
import { type ToolSpec, WEB_SEARCH } from '../contracts/tools.ts'
import { base64urlEncode, isWellFormed, utf8 } from '../crypto/bytes.ts'
import { sha256 } from '../crypto/keys.ts'

/**
 * RFC 8785 canonical JSON of any JSON value (crypto/bytes.ts `canonicalJson` is the integer-only form the keyslots
 * use). InvalidInputError for a non-finite number, a lone surrogate or a value that is not JSON.
 */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) throw new InvalidInputError('The value is nested too deeply')
  if (value === null || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new InvalidInputError('Canonical JSON takes finite numbers only')
    // ECMAScript's Number serialisation is the one RFC 8785 prescribes (and it writes -0 as 0).
    return JSON.stringify(value)
  }
  if (typeof value === 'string') {
    if (!isWellFormed(value)) throw new InvalidInputError('Text holds a lone surrogate')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Readonly<Record<string, unknown>>
    const members = Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => {
        if (!isWellFormed(key)) throw new InvalidInputError('Text holds a lone surrogate')
        return `${JSON.stringify(key)}:${canonicalJson(object[key], depth + 1)}`
      })
    return `{${members.join(',')}}`
  }
  throw new InvalidInputError('The value is not JSON')
}

export function approvalKeyOf(spec: Pick<ToolSpec, 'source' | 'origin' | 'name'>): string {
  return `${spec.source}:${spec.origin ?? '-'}:${spec.name}`
}

async function hashOf(value: JsonValue): Promise<string> {
  return base64urlEncode(await sha256(utf8(canonicalJson(value))))
}

export function fingerprintOf(
  spec: Pick<ToolSpec, 'name' | 'description' | 'inputSchema' | 'annotations'>,
): Promise<string> {
  const { readOnly, destructive, openWorld } = spec.annotations
  return hashOf({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    annotations: { readOnly, destructive, openWorld },
  })
}

let webSearch: Promise<string> | null = null

export function webSearchFingerprint(): Promise<string> {
  webSearch ??= hashOf({ name: WEB_SEARCH, provider: true })
  return webSearch
}
