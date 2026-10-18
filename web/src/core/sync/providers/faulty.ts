/*
 * Faults a real store shows sooner or later, injected around any RemoteStore (ported from the cursus test harness):
 * - put-before: fails before storing; put-after: stores, then fails; put-lost: says OK, stores nothing;
 * - put-corrupt: stores damaged bytes; get-corrupt: returns damaged bytes once; get-fail: a network error;
 * - list-fail: the listing fails; rate-limit: 429 with Retry-After; auth: expired credentials; quota: storage full.
 * A listing never comes back partial: a store that loses part of a listing must fail it (spec/FORMAT.md section 10.3
 * judges complete listings only), so there is no "omit a page" fault.
 */

import type { Rng } from '../../contracts/crypto.ts'
import { RemoteError, type RemoteStore } from '../../contracts/sync.ts'

export type Fault =
  | 'put-before'
  | 'put-after'
  | 'put-lost'
  | 'put-corrupt'
  | 'get-corrupt'
  | 'get-fail'
  | 'list-fail'
  | 'flush-fail'
  | 'rate-limit'
  | 'auth'
  | 'quota'

type Op = 'put' | 'get' | 'list' | 'flush'

const APPLIES: Record<Op, readonly Fault[]> = {
  put: ['auth', 'rate-limit', 'quota', 'put-before', 'put-after', 'put-lost', 'put-corrupt'],
  get: ['auth', 'rate-limit', 'get-fail', 'get-corrupt'],
  list: ['auth', 'rate-limit', 'list-fail'],
  flush: ['rate-limit', 'flush-fail'],
}

export interface FaultyStore extends RemoteStore {
  readonly inner: RemoteStore
  /** The next `times` operations this fault applies to get it. */
  inject(fault: Fault, times?: number): void
  /** Each applicable operation gets a fault with probability p[fault], drawn from `rng` (deterministic in tests). */
  randomly(rng: Rng, p: Partial<Record<Fault, number>>): void
  offline: boolean
  /** Lifts every fault. */
  heal(): void
  /** Faults that fired, in order. */
  readonly fired: Fault[]
}

function damage(bytes: Uint8Array): Uint8Array {
  const out = bytes.length === 0 ? new Uint8Array(1) : bytes.slice()
  out[out.length - 1] = (out[out.length - 1] ?? 0) ^ 0x5a
  return out
}

export function faultyStore(inner: RemoteStore, options: { readonly retryAfterMs?: number } = {}): FaultyStore {
  const queued = new Map<Fault, number>()
  let random: { rng: Rng; p: Partial<Record<Fault, number>> } | null = null
  const fired: Fault[] = []
  const retryAfterMs = options.retryAfterMs ?? 2000

  const pick = (op: Op): Fault | null => {
    for (const f of APPLIES[op]) {
      const n = queued.get(f) ?? 0
      if (n > 0) {
        if (n === 1) queued.delete(f)
        else queued.set(f, n - 1)
        fired.push(f)
        return f
      }
    }
    if (random) {
      for (const f of APPLIES[op]) {
        const p = random.p[f] ?? 0
        const draw = random.rng.bytes(4)
        const u =
          ((draw[0] ?? 0) * 2 ** 24 + (draw[1] ?? 0) * 2 ** 16 + (draw[2] ?? 0) * 2 ** 8 + (draw[3] ?? 0)) / 2 ** 32
        if (p > 0 && u < p) {
          fired.push(f)
          return f
        }
      }
    }
    return null
  }

  const common = (op: Op): Fault | null => {
    if (self.offline) throw new RemoteError('network', 'offline')
    const f = pick(op)
    if (f === 'auth') throw new RemoteError('auth', 'credentials expired')
    if (f === 'rate-limit') throw new RemoteError('rate-limited', '429 Too Many Requests', { retryAfterMs })
    if (f === 'quota') throw new RemoteError('quota', 'storage full')
    if (f === 'get-fail' || f === 'list-fail' || f === 'put-before' || f === 'flush-fail') {
      throw new RemoteError('network', `${f} injected`)
    }
    return f
  }

  const self: FaultyStore = {
    inner,
    get id() {
      return inner.id
    },
    get kind() {
      return inner.kind
    },
    get keepsHistory() {
      return inner.keepsHistory
    },
    offline: false,
    fired,
    inject(fault, times = 1) {
      queued.set(fault, (queued.get(fault) ?? 0) + times)
    },
    randomly(rng, p) {
      random = { rng, p }
    },
    heal() {
      queued.clear()
      random = null
      self.offline = false
    },
    async list(prefix) {
      common('list')
      return inner.list(prefix)
    },
    async get(entry) {
      const f = common('get')
      const bytes = await inner.get(entry)
      if (bytes && f === 'get-corrupt') return damage(bytes) as typeof bytes
      return bytes
    },
    async put(name, bytes) {
      const f = common('put')
      if (f === 'put-lost') return
      if (f === 'put-corrupt') return inner.put(name, damage(bytes))
      await inner.put(name, bytes)
      if (f === 'put-after') throw new RemoteError('network', 'connection reset after upload')
    },
    async flush() {
      common('flush')
      return inner.flush()
    },
    delete: (name) => inner.delete(name),
  }
  return self
}
