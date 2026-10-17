/*
 * Yjs `Any` values (spec/DATA-MODEL.md section 2): null, booleans, finite numbers, well-formed strings, byte arrays,
 * and arrays or plain objects of those. Every value the workspace writes goes through `toAny`, which validates and
 * copies it, so a caller mutating its input afterwards cannot change what the document holds; every value it hands
 * out goes through `frozenCopy`, so a reader cannot change the document either.
 */

import { InvalidInputError } from '../contracts/crypto.ts'

/** Whether `text` has no lone surrogate (String.prototype.isWellFormed, which ES2023 typings lack). */
export function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      i++
    } else if (c >= 0xdc00 && c <= 0xdfff) return false
  }
  return true
}

const isPlainObject = (value: object): boolean => {
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * A validated deep copy of `value`; InvalidInputError naming the offending path otherwise. Object keys whose value is
 * `undefined` are refused, not dropped: an absent field is not set, and silently dropping one would hide a caller bug.
 */
export function toAny(value: unknown, path = 'value', depth = 0): unknown {
  if (depth > 64) throw new InvalidInputError(`${path} is nested too deeply`)
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new InvalidInputError(`${path} is not a finite number`)
    return value
  }
  if (typeof value === 'string') {
    if (!wellFormed(value)) throw new InvalidInputError(`${path} is not well-formed Unicode`)
    return value
  }
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) throw new InvalidInputError(`${path}[${i}] is a hole`)
      out.push(toAny(value[i], `${path}[${i}]`, depth + 1))
    }
    return out
  }
  if (typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (!wellFormed(key)) throw new InvalidInputError(`${path} has a key that is not well-formed Unicode`)
      if (item === undefined) throw new InvalidInputError(`${path}.${key} is undefined`)
      out[key] = toAny(item, `${path}.${key}`, depth + 1)
    }
    return out
  }
  throw new InvalidInputError(`${path} is not a Yjs Any value (${typeof value})`)
}

/** Freezes `value` in place, deeply; typed arrays cannot be frozen and are left as they are. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value) || Object.isFrozen(value)) return value
  for (const item of Object.values(value)) deepFreeze(item)
  return Object.freeze(value)
}

/**
 * A frozen deep copy of a value read from a document. Values decoded by Yjs are owned by the document, so they are
 * copied before freezing; anything that is not `Any` (a shared type nested by a foreign writer) reads as its JSON.
 */
export function frozenCopy<T = unknown>(value: unknown): T {
  const copy = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    if (v instanceof Uint8Array) return new Uint8Array(v)
    if (Array.isArray(v)) return v.map(copy)
    if ('toJSON' in v && typeof v.toJSON === 'function' && !isPlainObject(v)) return copy(v.toJSON())
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(v)) if (item !== undefined) out[key] = copy(item)
    return out
  }
  return deepFreeze(copy(value)) as T
}
