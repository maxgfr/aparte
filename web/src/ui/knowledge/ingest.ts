import { useSyncExternalStore } from 'react'
import type { IngestProgress, IngestResult, KnowledgeService } from '../../core/contracts/knowledge.ts'
import type { Id } from '../../core/contracts/workspace.ts'

/*
 * The documents being added to knowledge bases, one at a time, for the whole page: a queue that outlives the screen
 * it was started from (leaving the screen does not stop it), with the progress of the current file and a Stop that
 * aborts it and drops the files still waiting. While it runs it holds the vault lock (`knowledge-ingest`), so an
 * auto-lock waits for the file being saved instead of cutting it in half.
 */

export interface IngestJob {
  /** Unique for the page's lifetime. */
  readonly id: number
  readonly base: Id
  readonly name: string
}

export interface IngestState {
  readonly current: (IngestJob & { readonly progress: IngestProgress | null }) | null
  readonly queued: readonly IngestJob[]
}

export interface IngestOutcome {
  readonly job: IngestJob
  readonly result?: IngestResult
  readonly error?: unknown
}

interface Pending extends IngestJob {
  readonly file: File
}

const IDLE: IngestState = { current: null, queued: [] }

let state: IngestState = IDLE
let queue: Pending[] = []
let controller: AbortController | null = null
let running = false
let nextJob = 1
const listeners = new Set<() => void>()

function set(next: IngestState): void {
  state = next
  for (const fn of [...listeners]) fn()
}

function publish(current: IngestState['current']): void {
  set({ current, queued: queue.map(({ id, base, name }) => ({ id, base, name })) })
}

export interface IngestDeps {
  readonly knowledge: KnowledgeService
  readonly holdLock: (reason: string) => () => void
  /** Told of every file once it is added or refused. */
  readonly onDone: (outcome: IngestOutcome) => void
}

/** Queues files for a base and starts the queue if it is idle. */
export function addFiles(deps: IngestDeps, base: Id, files: readonly File[]): void {
  for (const file of files) queue.push({ id: nextJob++, base, name: file.name, file })
  publish(state.current)
  if (!running) void run(deps)
}

async function run(deps: IngestDeps): Promise<void> {
  running = true
  let release: (() => void) | null = null
  try {
    release = deps.holdLock('knowledge-ingest')
  } catch {
    // The vault is locking: nothing can be added now; the queue is dropped below.
    queue = []
  }
  try {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      const current = job
      controller = new AbortController()
      const signal = controller.signal
      publish({ id: current.id, base: current.base, name: current.name, progress: null })
      try {
        const bytes = new Uint8Array(await current.file.arrayBuffer())
        const result = await deps.knowledge.ingest(
          current.base,
          { bytes, name: current.name, mediaType: current.file.type },
          {
            signal,
            onProgress: (progress) => publish({ id: current.id, base: current.base, name: current.name, progress }),
          },
        )
        deps.onDone({ job: current, result })
      } catch (error) {
        if (signal.aborted) {
          queue = []
          deps.onDone({ job: current, error: signal.reason ?? error })
          break
        }
        deps.onDone({ job: current, error })
      }
    }
  } finally {
    controller = null
    running = false
    release?.()
    publish(null)
  }
}

/** Stops the file being added and drops the ones waiting. */
export function stopIngest(): void {
  queue = []
  controller?.abort(new DOMException('Stopped', 'AbortError'))
  publish(state.current)
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

const read = (): IngestState => state

/** The queue's state, re-rendered on every change. */
export function useIngest(): IngestState {
  return useSyncExternalStore(subscribe, read, read)
}
