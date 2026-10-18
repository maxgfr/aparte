import type { Rng } from '../core/contracts/crypto.ts'
import type { McpManager, McpSecrets } from '../core/contracts/mcp.ts'
import type { LocalStore } from '../core/contracts/store.ts'
import type { ToolRegistry } from '../core/contracts/tools.ts'
import type { Workspace } from '../core/contracts/workspace.ts'
import type { CallbackChannel } from '../core/mcp/callback.ts'
import { request } from '../security/net.ts'
import { BUILD } from './buildInfo.ts'

/*
 * The MCP client of a session, loaded on demand: its chunk (the MCP manager and `@ai-sdk/mcp`) is fetched once the
 * vault has an MCP server, or when a screen asks for it, never with the first paint or at unlock otherwise.
 *
 * Invariants:
 * - The manager's network requests go through web/src/security/net.ts `request` (purpose `mcp`).
 * - The OAuth popup comes back to `<base>oauth-callback.html` on this origin; its answer arrives on a
 *   BroadcastChannel named after the flow (web/src/core/mcp/callback.ts).
 * - Disposing (the vault locks) closes every connection, unregisters every MCP tool and cancels a pending sign-in.
 */

export interface McpLoaded {
  readonly manager: McpManager
  readonly secrets: McpSecrets
}

export interface McpHost {
  /** The loaded client, or null before it has loaded. */
  current(): McpLoaded | null
  /** Loads the client (once). */
  load(): Promise<McpLoaded>
  /** Calls `fn` when the client loads and on every status change of its servers. */
  subscribe(fn: () => void): () => void
  dispose(): Promise<void>
}

export function createMcpHost(deps: {
  readonly workspace: Workspace
  readonly registry: ToolRegistry
  readonly store: LocalStore
  readonly rng: Rng
}): McpHost {
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const fn of [...listeners]) fn()
  }
  let loaded: McpLoaded | null = null
  let loading: Promise<McpLoaded> | null = null
  let disposed = false
  let offManager: (() => void) | null = null

  const load = (): Promise<McpLoaded> => {
    loading ??= Promise.all([import('../core/mcp/manager.ts'), import('../core/mcp/secrets.ts')]).then(
      ([managerModule, secretsModule]) => {
        if (disposed) throw new Error('The session closed')
        const base = new URL(import.meta.env.BASE_URL, location.origin)
        const secrets = secretsModule.createMcpSecrets(deps.store)
        const manager = managerModule.createMcpManager({
          workspace: deps.workspace,
          registry: deps.registry,
          secrets,
          request: (url, init) => request(url, init),
          rng: deps.rng,
          clock: { now: () => Date.now() },
          redirectUri: new URL('oauth-callback.html', base).href,
          clientUri: base.href,
          clientName: 'Aparté',
          clientVersion: BUILD.version,
          openChannel: (name) => {
            const channel = new BroadcastChannel(name)
            const port: CallbackChannel = {
              onmessage: null,
              close: () => channel.close(),
            }
            channel.onmessage = (event) => port.onmessage?.({ data: event.data })
            return port
          },
        })
        offManager = manager.subscribe(notify)
        loaded = { manager, secrets }
        notify()
        return loaded
      },
    )
    loading.catch(() => {
      loading = null
    })
    return loading
  }

  // A vault with servers (here, or synced from another device) connects to them without waiting for a screen.
  const loadIfUsed = () => {
    if (!disposed && loaded === null && deps.workspace.mcp.list().length > 0) void load().catch(() => undefined)
  }
  const offWorkspace = deps.workspace.subscribe('mcp', loadIfUsed)
  loadIfUsed()

  return {
    current: () => loaded,
    load,
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      offWorkspace()
      offManager?.()
      listeners.clear()
      await loaded?.manager.dispose()
      loaded = null
    },
  }
}
