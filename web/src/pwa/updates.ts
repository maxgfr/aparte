/**
 * The update state machine behind `updates` and `holdReload` (src/pwa/register.ts), free of workbox-window and the
 * DOM so it is tested in Bun.
 *
 * A new version installs in the background and waits (`registerType: 'prompt'`). Applying it activates the waiting
 * worker and reloads the page. Neither step may happen while work the reload would cut is running: a response
 * still streaming, an encryption or a write in flight. Such work takes a hold; `apply()` waits until every hold is
 * released before asking the worker to activate (activation alone already swaps the cache the page's lazy chunks
 * come from), and again before reloading.
 */

export interface UpdateSnapshot {
  /** A new version is installed and waiting (or was activated by another tab): `apply()` loads it. */
  needRefresh: boolean
  /** The first install finished: the app now opens offline. */
  offlineReady: boolean
  /** A service worker of this app controls the page: its verified precache and headers apply. */
  active: boolean
}

/** The side effects the machine drives; register.ts binds them to workbox-window and `location`. */
export interface UpdateDriver {
  /** Asks the waiting worker to activate (workbox-window's `messageSkipWaiting()`). */
  skipWaiting(): void
  /** Reloads into the new version. */
  reload(): void
}

export interface Updates {
  subscribe(cb: () => void): () => void
  /** The current state; the same object until it changes (safe for `useSyncExternalStore`). */
  snapshot(): UpdateSnapshot
  /** Waits for every hold, activates the waiting version and reloads; a no-op when nothing is waiting. */
  apply(): Promise<void>
}

export interface UpdateMachine {
  updates: Updates
  holdReload(reason: string): () => void
  /** What currently holds the reload back, for diagnostics. */
  holds(): string[]
  /** Binds the side effects (once the worker is registered). */
  bind(driver: UpdateDriver): void
  /** Workbox events, as register.ts forwards them. */
  events: {
    /** A new worker is installed and waiting. */
    waiting(): void
    /** The first worker finished installing (not an update). */
    offlineReady(): void
    /**
     * A worker of this app took control of the page; `update` when it replaced another one (not the first install
     * claiming the page). Unasked for, an update means another tab applied it.
     */
    controlling(update: boolean): void
    /** This page is controlled by the app's worker (at registration, without an event). */
    active(): void
  }
}

type Phase = 'idle' | 'draining' | 'activating' | 'reloading'

export function createUpdateMachine(): UpdateMachine {
  let state: UpdateSnapshot = { needRefresh: false, offlineReady: false, active: false }
  let driver: UpdateDriver | null = null
  let phase: Phase = 'idle'
  /** The waiting worker already took over (another tab applied it): only the reload is left. */
  let activated = false
  let applying: Promise<void> | null = null
  const watchers = new Set<() => void>()
  const held = new Map<symbol, string>()
  let released: (() => void)[] = []
  let controlled: (() => void) | null = null

  const set = (patch: Partial<UpdateSnapshot>) => {
    const next = { ...state, ...patch }
    if (
      next.needRefresh === state.needRefresh &&
      next.offlineReady === state.offlineReady &&
      next.active === state.active
    )
      return
    state = next
    for (const cb of watchers) cb()
  }

  /** Resolves once no hold is active (at once when none is). */
  const idle = () => (held.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => void released.push(resolve)))

  async function run(): Promise<void> {
    phase = 'draining'
    await idle()
    if (!activated) {
      phase = 'activating'
      const takeover = new Promise<void>((resolve) => {
        controlled = resolve
      })
      driver?.skipWaiting()
      await takeover
    }
    // Work may have started while the worker activated: the reload waits for it too.
    await idle()
    phase = 'reloading'
    driver?.reload()
  }

  return {
    updates: {
      subscribe(cb) {
        watchers.add(cb)
        return () => {
          watchers.delete(cb)
        }
      },
      snapshot: () => state,
      apply() {
        if (!state.needRefresh || !driver) return Promise.resolve()
        applying ??= run()
        return applying
      },
    },

    holdReload(reason) {
      const token = Symbol(reason)
      held.set(token, reason)
      let done = false
      return () => {
        if (done) return
        done = true
        held.delete(token)
        if (held.size > 0) return
        const waiters = released
        released = []
        for (const resolve of waiters) resolve()
      }
    },

    holds: () => [...held.values()],

    bind(d) {
      driver = d
    },

    events: {
      waiting() {
        set({ needRefresh: true })
        // A newer version replaced the one being activated: ask the new one too, or the takeover never comes.
        if (phase === 'activating') driver?.skipWaiting()
      },
      offlineReady() {
        set({ offlineReady: true })
      },
      controlling(update) {
        set({ active: true })
        if (controlled) {
          const resolve = controlled
          controlled = null
          resolve()
          return
        }
        // Another tab activated the update: this page now runs old code under the new worker, whose precache no
        // longer has the old lazy chunks. Offer the reload rather than force it.
        if (update) {
          activated = true
          set({ needRefresh: true })
        }
      },
      active() {
        set({ active: true })
      },
    },
  }
}
