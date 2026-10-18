import { type ReactNode, Suspense } from 'react'
import { Redirect, Route, Router, Switch, useLocation } from 'wouter'
import { useHashLocation, useHashSearch } from './hashLocation.ts'
import { lazyChunk, ScreenBoundary } from './lazyChunk.tsx'
import { paths } from './routes.ts'

/* Every screen is a chunk of its own, loaded when first visited; the home is a new chat. */
const About = lazyChunk(() => import('../screens/About/index.tsx').then((m) => m.default))
const NotFound = lazyChunk(() => import('../screens/NotFound/index.tsx').then((m) => m.default))
const Protect = lazyChunk(() => import('../screens/Protect/index.tsx').then((m) => m.default))
const Protection = lazyChunk(() => import('../screens/Protection/index.tsx').then((m) => m.default))
const Chat = lazyChunk(() => import('../screens/Chat/index.tsx').then((m) => m.default))
const Conversations = lazyChunk(() => import('../screens/Conversations/index.tsx').then((m) => m.default))
const Providers = lazyChunk(() => import('../screens/Providers/index.tsx').then((m) => m.default))
const Provider = lazyChunk(() => import('../screens/Providers/Provider.tsx').then((m) => m.default))
const Sync = lazyChunk(() => import('../screens/Sync/index.tsx').then((m) => m.default))
const SyncJoin = lazyChunk(() => import('../screens/Sync/Join.tsx').then((m) => m.default))
const McpServers = lazyChunk(() => import('../screens/Mcp/index.tsx').then((m) => m.default))
const McpServer = lazyChunk(() => import('../screens/Mcp/Server.tsx').then((m) => m.default))
const More = lazyChunk(() => import('../screens/More/index.tsx').then((m) => m.default))
const Transfer = lazyChunk(() => import('../screens/Transfer/index.tsx').then((m) => m.default))
const Characters = lazyChunk(() => import('../screens/Characters/index.tsx').then((m) => m.default))
const Character = lazyChunk(() => import('../screens/Characters/Character.tsx').then((m) => m.default))
const Lorebook = lazyChunk(() => import('../screens/Characters/Lorebook.tsx').then((m) => m.default))
const Arena = lazyChunk(() => import('../screens/Arena/index.tsx').then((m) => m.default))
const Stats = lazyChunk(() => import('../screens/Stats/index.tsx').then((m) => m.default))
const Knowledge = lazyChunk(() => import('../screens/Knowledge/index.tsx').then((m) => m.default))
const KnowledgeBase = lazyChunk(() => import('../screens/Knowledge/Base.tsx').then((m) => m.default))
const Skills = lazyChunk(() => import('../screens/Skills/index.tsx').then((m) => m.default))
const Voice = lazyChunk(() => import('../screens/Voice/index.tsx').then((m) => m.default))
const Share = lazyChunk(() => import('../screens/Share/index.tsx').then((m) => m.default))

/** Hash routing (path and query in the hash): GitHub Pages serves one file and has no SPA rewrite. */
export function HashRouter({ children }: { children: ReactNode }) {
  return (
    <Router hook={useHashLocation} searchHook={useHashSearch}>
      {children}
    </Router>
  )
}

export function Routes() {
  const [location] = useLocation()
  return (
    <ScreenBoundary key={location}>
      <Suspense fallback={null}>
        <Switch>
          <Route path={paths.home} component={Chat} />
          <Route path={paths.about} component={About} />
          <Route path={paths.protection} component={Protection} />
          <Route path={paths.protect} component={Protect} />
          <Route path={paths.chat} component={Chat} />
          <Route path={paths.chatThread} component={Chat} />
          <Route path={paths.conversations} component={Conversations} />
          <Route path={paths.providers} component={Providers} />
          <Route path={paths.providerNew} component={Provider} />
          <Route path={paths.provider} component={Provider} />
          <Route path={paths.sync} component={Sync} />
          <Route path={paths.syncJoin} component={SyncJoin} />
          <Route path={paths.mcp} component={McpServers} />
          <Route path={paths.mcpNew} component={McpServer} />
          <Route path={paths.mcpServer} component={McpServer} />
          <Route path={paths.more} component={More} />
          <Route path={paths.transfer} component={Transfer} />
          <Route path={paths.characters} component={Characters} />
          <Route path={paths.character} component={Character} />
          <Route path={paths.lorebook} component={Lorebook} />
          <Route path={paths.arena} component={Arena} />
          <Route path={paths.stats} component={Stats} />
          <Route path={paths.knowledge} component={Knowledge} />
          <Route path={paths.knowledgeBase} component={KnowledgeBase} />
          <Route path={paths.skills} component={Skills} />
          <Route path={paths.voice} component={Voice} />
          <Route path={paths.share} component={Share} />
          {/* Recovery is a screen of the lock gate; once the vault is open, its address leads home. */}
          <Route path={paths.recover}>
            <Redirect to={paths.home} replace />
          </Route>
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </ScreenBoundary>
  )
}
