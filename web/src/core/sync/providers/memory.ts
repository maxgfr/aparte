/*
 * An in-memory store: the fake every engine test and simulation runs against, and the staging store of a zip export.
 * Several devices share one MemoryBucket (the "server"); each device talks to it through its own MemoryStore, which
 * counts its calls. The bucket exposes what a hostile or broken server can do (drop, damage, roll back, hide), so the
 * tests can play one.
 */

import type { Bytes } from '../../contracts/crypto.ts'
import type { DestinationKind, RemoteEntry, RemoteStore } from '../../contracts/sync.ts'

const bytewise = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export class MemoryBucket {
  private readonly objects = new Map<string, Bytes>()

  /** Every name, sorted. */
  names(prefix = ''): string[] {
    return [...this.objects.keys()].filter((n) => n.startsWith(prefix)).sort(bytewise)
  }

  read(name: string): Bytes | null {
    const v = this.objects.get(name)
    return v === undefined ? null : new Uint8Array(v)
  }

  write(name: string, bytes: Uint8Array): void {
    this.objects.set(name, new Uint8Array(bytes))
  }

  remove(name: string): boolean {
    return this.objects.delete(name)
  }

  get size(): number {
    return this.objects.size
  }

  /** Flips one byte of a stored object (bit rot, a broken upload, a tampering server). */
  corrupt(name: string, at = -1): boolean {
    const v = this.objects.get(name)
    if (!v) return false
    const copy = new Uint8Array(v)
    const i = at < 0 ? copy.length + at : at
    copy[i] = (copy[i] ?? 0) ^ 0x5a
    this.objects.set(name, copy)
    return true
  }

  /** The whole content, to roll back to later. */
  snapshot(): Map<string, Bytes> {
    return new Map([...this.objects].map(([k, v]) => [k, new Uint8Array(v)]))
  }

  /** Replaces the whole content (a force push, a restored backup). */
  restore(snapshot: ReadonlyMap<string, Uint8Array>): void {
    this.objects.clear()
    for (const [k, v] of snapshot) this.objects.set(k, new Uint8Array(v))
  }

  /** Total bytes stored. */
  bytes(): number {
    let n = 0
    for (const v of this.objects.values()) n += v.length
    return n
  }
}

export interface MemoryStore extends RemoteStore {
  readonly bucket: MemoryBucket
  readonly calls: { list: number; get: number; put: number; delete: number; flush: number }
  /** Names this store hides from its listings and reads (a server withholding objects from one device). */
  hide(predicate: ((name: string) => boolean) | null): void
}

export function memoryStore(
  bucket: MemoryBucket,
  options: { readonly id?: string; readonly kind?: DestinationKind; readonly keepsHistory?: boolean } = {},
): MemoryStore {
  const calls = { list: 0, get: 0, put: 0, delete: 0, flush: 0 }
  let hidden: ((name: string) => boolean) | null = null
  const visible = (name: string): boolean => hidden === null || !hidden(name)
  return {
    id: options.id ?? 'memory',
    kind: options.kind ?? 'memory',
    keepsHistory: options.keepsHistory ?? false,
    bucket,
    calls,
    hide(predicate) {
      hidden = predicate
    },
    async list(prefix = '') {
      calls.list++
      return bucket
        .names(prefix)
        .filter(visible)
        .map((name): RemoteEntry => ({ name, size: bucket.read(name)?.length ?? 0 }))
    },
    async get(entry) {
      calls.get++
      return visible(entry.name) ? bucket.read(entry.name) : null
    },
    async put(name, bytes) {
      calls.put++
      bucket.write(name, bytes)
    },
    async flush() {
      calls.flush++
    },
    async delete(name) {
      calls.delete++
      bucket.remove(name)
    },
  }
}
