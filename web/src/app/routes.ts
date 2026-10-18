/** Every screen's path inside the hash. Links and the router read them from here, never as literals. */
export const paths = {
  welcome: '/',
  about: '/about',
  createVault: '/vault/new',
  recover: '/recover',
  /** A new chat (nothing is stored until its first message). */
  chat: '/chat',
  /** One chat: `/chat/<conversation id>`. */
  chatThread: '/chat/:id',
  /** The conversation list (the sidebar holds it from 1000px). */
  conversations: '/chats',
  providers: '/providers',
  /** A new provider: `/providers/new?catalog=<id>`, `?local=<preset id>`, `?device=<webllm|chrome-ai>` or `?custom`. */
  providerNew: '/providers/new',
  /** One provider: `/providers/<provider id>`. */
  provider: '/providers/:id',
  /** Sync status and destinations. */
  sync: '/sync',
  /** A device without a vault takes one from its sync store. */
  syncJoin: '/sync/join',
  /** The MCP servers. */
  mcp: '/mcp',
  mcpNew: '/mcp/new',
  /** One MCP server: `/mcp/<server id>`. */
  mcpServer: '/mcp/:id',
  /** The screens beyond the tab bar: Arena, characters, import and export, usage, About. */
  more: '/more',
  /** Exports, the encrypted backup and imports from other apps; `?launch` when opened with a file (file_handlers). */
  transfer: '/transfer',
  /** Characters, lorebooks, quick replies and regex rules. */
  characters: '/characters',
  /** One character: `/characters/<persona id>`. */
  character: '/characters/:id',
  /** One lorebook: `/lorebooks/<lorebook id>`. */
  lorebook: '/lorebooks/:id',
  /** Blind A/B rounds between two models and the local leaderboard. */
  arena: '/arena',
  /** Tokens and cost over time. */
  stats: '/stats',
  /** The knowledge bases. */
  knowledge: '/knowledge',
  /** One knowledge base: `/knowledge/<knowledge base id>`. */
  knowledgeBase: '/knowledge/:id',
  /** Dictation, reading aloud and notifications. */
  voice: '/voice',
  /** What other apps shared (the share target): `/share?received=<outcome>` after a share. */
  share: '/share',
} as const

export type RouteName = keyof typeof paths

/** The path of one chat. */
export function chatPath(id: string): string {
  return `/chat/${encodeURIComponent(id)}`
}

/** The path of one character. */
export function characterPath(id: string): string {
  return `/characters/${encodeURIComponent(id)}`
}

/** The path of one lorebook. */
export function lorebookPath(id: string): string {
  return `/lorebooks/${encodeURIComponent(id)}`
}

/** The path of one knowledge base. */
export function knowledgePath(id: string): string {
  return `/knowledge/${encodeURIComponent(id)}`
}

/** The path of one provider's settings. */
export function providerPath(id: string): string {
  return `/providers/${encodeURIComponent(id)}`
}

/** The path of one MCP server's settings. */
export function mcpServerPath(id: string): string {
  return `/mcp/${encodeURIComponent(id)}`
}

/**
 * Where a new provider comes from: a catalog provider, a local server preset, a model that runs in this browser
 * (`webllm` or `chrome-ai`), or a custom endpoint.
 */
export type ProviderSource =
  | { readonly from: 'catalog'; readonly id: string }
  | { readonly from: 'local'; readonly id: string }
  | { readonly from: 'device'; readonly id: 'webllm' | 'chrome-ai' }
  | { readonly from: 'custom' }

/** The path that creates a provider from `source`. */
export function newProviderPath(source: ProviderSource): string {
  if (source.from === 'custom') return `${paths.providerNew}?custom`
  return `${paths.providerNew}?${source.from}=${encodeURIComponent(source.id)}`
}

/** The source a `/providers/new` query names (a custom endpoint when it names none). */
export function providerSourceOf(search: string): ProviderSource {
  const q = new URLSearchParams(search)
  const catalog = q.get('catalog')
  if (catalog) return { from: 'catalog', id: catalog }
  const local = q.get('local')
  if (local) return { from: 'local', id: local }
  const device = q.get('device')
  if (device === 'webllm' || device === 'chrome-ai') return { from: 'device', id: device }
  return { from: 'custom' }
}
