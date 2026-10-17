/*
 * Ordered capture of a document's local updates into its pending queue (spec/DATA-MODEL.md section 4.5), after the
 * cursus local log. One queue per document: an update is appended only once every earlier one was acknowledged, so a
 * later change is never persisted without the one before it. Updates waiting behind an append are merged and written
 * by the next one. A failed append keeps that update and every later one in memory, retries with backoff, and reports
 * `blocked()` and `unsaved()` until the queue has acknowledged everything.
 */

import * as Y from 'yjs'
import type { Origin } from '../contracts/workspace.ts'

/** Transactions from these origins already exist in a queue or on the remote: they are never captured again. */
const IGNORED: ReadonlySet<unknown> = new Set<Origin>(['replay', 'remote'])

export function shouldCapture(origin: unknown): boolean {
  return !IGNORED.has(origin)
}

export interface CaptureOptions {
  /** The unsaved count or the blocked state changed. */
  readonly onChange?: () => void
  /** Every failed append, with the update kept in memory and retried. */
  readonly onError?: (error: unknown) => void
  /** Backoff before retry `attempt` (1, 2, ...). */
  readonly retryDelayMs?: (attempt: number) => number
}

export interface Capture {
  /** Updates captured but not yet acknowledged (in flight, failed or waiting behind). */
  unsaved(): number
  /** An append failed and is waiting for its retry. */
  blocked(): boolean
  /** The error of the last failed append while blocked. */
  lastError(): unknown
  /** Resolves once nothing is being appended: everything is acknowledged, or the queue is blocked on a failure. */
  settled(): Promise<void>
  /** Retries now, without waiting for the backoff. */
  retry(): void
  /** Stops capturing; what is still unacknowledged is never written. Idempotent. */
  stop(): void
}

export const RETRY_MAX_MS = 60_000

export const defaultRetryDelay = (attempt: number): number => Math.min(RETRY_MAX_MS, 1000 * 2 ** (attempt - 1))

export function captureUpdates(
  doc: Y.Doc,
  append: (update: Uint8Array) => Promise<void>,
  options: CaptureOptions = {},
): Capture {
  const delay = options.retryDelayMs ?? defaultRetryDelay
  const queue: Uint8Array[] = []
  let running = false
  let stopped = false
  let isBlocked = false
  let attempt = 0
  let error: unknown
  let timer: ReturnType<typeof setTimeout> | null = null
  let waiters: (() => void)[] = []

  const changed = (): void => options.onChange?.()
  const wake = (): void => {
    const pending = waiters
    waiters = []
    for (const resolve of pending) resolve()
  }

  const pump = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      while (queue.length > 0 && !stopped) {
        const count = queue.length
        const update = count === 1 ? (queue[0] as Uint8Array) : Y.mergeUpdatesV2(queue.slice(0, count))
        try {
          await append(update)
        } catch (cause) {
          if (stopped) return
          attempt++
          error = cause
          isBlocked = true
          options.onError?.(cause)
          changed()
          timer = setTimeout(() => {
            timer = null
            void pump()
          }, delay(attempt))
          return
        }
        if (stopped) return
        queue.splice(0, count)
        attempt = 0
        error = undefined
        isBlocked = false
        changed()
      }
    } finally {
      running = false
      wake()
    }
  }

  const handler = (update: Uint8Array, origin: unknown): void => {
    if (stopped || !shouldCapture(origin)) return
    queue.push(update)
    changed()
    // While blocked, the update waits behind the failed one until the scheduled retry.
    if (timer === null) void pump()
  }
  doc.on('updateV2', handler)

  return {
    unsaved: () => queue.length,
    blocked: () => isBlocked,
    lastError: () => error,
    settled: () => (running ? new Promise<void>((resolve) => waiters.push(resolve)) : Promise.resolve()),
    retry: () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      void pump()
    },
    stop: () => {
      if (stopped) return
      stopped = true
      doc.off('updateV2', handler)
      if (timer !== null) clearTimeout(timer)
      timer = null
      queue.length = 0
      wake()
    },
  }
}
