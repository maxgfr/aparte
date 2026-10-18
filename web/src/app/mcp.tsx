import { useCallback, useEffect, useMemo } from 'react'
import type { McpServerConfig, McpStatus } from '../core/contracts/mcp.ts'
import { useExternal, useSession } from './chat.tsx'
import type { McpLoaded } from './mcpHost.ts'

/*
 * The MCP servers for the interface: their synced configuration (the workspace's `mcp` map), the client of the
 * session (loaded by the first screen that needs it) and the live status of each server.
 */

const EMPTY: readonly McpServerConfig[] = []
const OFF: McpStatus = Object.freeze({ state: 'off' })

/** The MCP client of the session, loading it on first use; null until it has loaded. */
export function useMcp(): McpLoaded | null {
  const session = useSession()
  const host = session?.mcp ?? null
  useEffect(() => {
    void host?.load().catch(() => undefined)
  }, [host])
  const subscribe = useMemo(() => (host === null ? null : (fn: () => void) => host.subscribe(fn)), [host])
  const read = useCallback(() => host?.current() ?? null, [host])
  return useExternal(subscribe, read)
}

/** The MCP servers that are not trashed, by name. */
export function useMcpServers(): readonly McpServerConfig[] {
  const session = useSession()
  const ws = session?.workspace ?? null
  const subscribe = useMemo(() => (ws === null ? null : (fn: () => void) => ws.subscribe('mcp', fn)), [ws])
  const read = useCallback(() => (ws === null ? EMPTY : ws.mcp.list()), [ws])
  return useExternal(subscribe, read)
}

/** One server's configuration, or undefined. */
export function useMcpServer(id: string): McpServerConfig | undefined {
  const session = useSession()
  const ws = session?.workspace ?? null
  const subscribe = useMemo(() => (ws === null ? null : (fn: () => void) => ws.subscribe('mcp', fn)), [ws])
  const read = useCallback(() => ws?.mcp.get(id), [ws, id])
  return useExternal(subscribe, read)
}

/** The live status of a server (`off` until the client has loaded). */
export function useMcpStatus(id: string): McpStatus {
  const session = useSession()
  const host = session?.mcp ?? null
  const subscribe = useMemo(() => (host === null ? null : (fn: () => void) => host.subscribe(fn)), [host])
  const read = useCallback(() => host?.current()?.manager.status(id) ?? OFF, [host, id])
  return useExternal(subscribe, read)
}

/** The name of the MCP server a tool comes from (its `origin`), for the interface. */
export function useMcpServerName(): (origin: string | undefined) => string | undefined {
  const servers = useMcpServers()
  return useCallback((origin) => servers.find((s) => s.id === origin)?.name, [servers])
}
