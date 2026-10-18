/*
 * An image turn of a conversation (ImageTurns in web/src/core/contracts/media.ts): the user's prompt is committed as a
 * user message, one image is asked of the provider's image model, prepared like a photo, stored as an encrypted blob
 * and committed as the assistant's answer. The turn holds the vault lock and the PWA reload while it runs, as a
 * stream does, so neither an auto-lock nor an update cuts it; its answer is committed exactly once, as `done`,
 * `error` or `stopped`.
 */

import { titleFrom } from '../chat/request.ts'
import { InvalidInputError, InvalidStateError, type Rng } from '../contracts/crypto.ts'
import { type ImageTurnDeps, type ImageTurnState, type ImageTurns, MediaError } from '../contracts/media.ts'
import type { Id, ModelRef, NewMessage, Part, Thread } from '../contracts/workspace.ts'
import { base32Encode } from '../crypto/bytes.ts'

const REASON = 'image-turn'

function newId(rng: Rng): Id {
  return base32Encode(rng.bytes(16))
}

interface Run {
  readonly state: ImageTurnState
  readonly abort: AbortController
  readonly done: Promise<void>
}

export function createImageTurns(deps: ImageTurnDeps): ImageTurns {
  const ws = deps.workspace
  const runs = new Map<Id, Run>()
  const listeners = new Set<(conversationId: Id) => void>()
  let disposed = false

  const notify = (conversationId: Id) => {
    for (const fn of [...listeners]) {
      try {
        fn(conversationId)
      } catch {
        // A failing listener must not break the turn or the other listeners.
      }
    }
  }

  function holds(): () => void {
    if (disposed) throw new InvalidStateError('The vault is locking')
    let lock: () => void
    try {
      lock = deps.holdLock(REASON)
    } catch (cause) {
      throw new InvalidStateError('The vault is locking', { cause })
    }
    let reload: () => void
    try {
      reload = deps.holdReload(REASON)
    } catch (error) {
      lock()
      throw error
    }
    let released = false
    return () => {
      if (released) return
      released = true
      try {
        reload()
      } finally {
        lock()
      }
    }
  }

  /** The answer as it is committed: the stored image, or why there is none. */
  async function answer(run: Run, model: ModelRef, prompt: string): Promise<Omit<NewMessage, 'id' | 'parent'>> {
    const base = { role: 'assistant' as const, model }
    try {
      const generated = await deps.generate(model, prompt, run.abort.signal)
      if (run.abort.signal.aborted) return { ...base, parts: [], status: 'stopped' }
      const prepared = await deps.prepare(generated)
      const blob = await deps.blobs.put(prepared.bytes, prepared.mediaType)
      const part: Part = {
        type: 'image',
        blob,
        mediaType: prepared.mediaType,
        width: prepared.width,
        height: prepared.height,
      }
      return { ...base, parts: [part], status: 'done', stop: 'end' }
    } catch (error) {
      if (run.abort.signal.aborted) return { ...base, parts: [], status: 'stopped' }
      const failure =
        error instanceof MediaError
          ? { code: error.error.code, message: error.error.message }
          : { code: 'image-unreadable', message: '' }
      return { ...base, parts: [], status: 'error', error: failure }
    }
  }

  async function execute(run: Run, thread: Thread, prompt: string, release: () => void): Promise<void> {
    const { state } = run
    try {
      const message = await answer(run, state.model, prompt)
      const committed: NewMessage = { id: state.messageId, parent: state.parentId, ...message }
      ws.batch(() => {
        thread.commit(committed)
        thread.setLeaf(state.messageId, { ifLeaf: state.parentId })
      })
      try {
        await ws.flush()
      } catch {
        // A failed save shows in the workspace's persistence status; the hold must not outlive it.
      }
    } finally {
      runs.delete(state.conversationId)
      release()
      notify(state.conversationId)
    }
  }

  return {
    async run(conversationId, prompt, model) {
      const text = prompt.trim()
      if (text === '') throw new InvalidInputError('An image needs a prompt')
      const conversation = ws.conversations.get(conversationId)
      if (conversation === undefined || conversation.purgedAt !== undefined) {
        throw new InvalidInputError('Unknown conversation')
      }
      if (runs.has(conversationId)) throw new InvalidStateError('An image is being made in this conversation')
      const release = holds()
      let run: Run
      let thread: Thread
      try {
        thread = await ws.thread(conversationId)
        if (runs.has(conversationId)) throw new InvalidStateError('An image is being made in this conversation')
        if (disposed) throw new InvalidStateError('The vault is locking')
        const userId = newId(deps.rng)
        const parts: Part[] = [{ type: 'text', text }]
        ws.batch(() => {
          thread.commit({ id: userId, parent: conversation.leaf, role: 'user', parts, model: null, status: 'done' })
          thread.setLeaf(userId)
          if (conversation.title === '') {
            const title = titleFrom(parts)
            if (title !== '') ws.conversations.update(conversationId, { title })
          }
        })
        const state: ImageTurnState = {
          conversationId,
          messageId: newId(deps.rng),
          parentId: userId,
          model,
          startedAt: deps.clock.now(),
        }
        let finish: () => void = () => undefined
        const done = new Promise<void>((resolve) => {
          finish = resolve
        })
        run = { state, abort: new AbortController(), done }
        runs.set(conversationId, run)
        notify(conversationId)
        void execute(run, thread, text, release).finally(finish)
      } catch (error) {
        release()
        throw error
      }
      await run.done
    },
    stop(conversationId) {
      runs.get(conversationId)?.abort.abort()
    },
    state(conversationId) {
      return runs.get(conversationId)?.state ?? null
    },
    running() {
      return [...runs.keys()]
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    async dispose() {
      disposed = true
      const all = [...runs.values()]
      for (const run of all) run.abort.abort()
      await Promise.all(all.map((run) => run.done))
    },
  }
}
