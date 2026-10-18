import { type ReactNode, Suspense } from 'react'
import { Redirect, Route, Router, Switch, useLocation } from 'wouter'
import Welcome from '../screens/Welcome/index.tsx'
import { useHashLocation, useHashSearch } from './hashLocation.ts'
import { lazyChunk, ScreenBoundary } from './lazyChunk.tsx'
import { paths } from './routes.ts'

/*
 * The start screen ships in the entry chunk, so the first paint needs no extra request; every other screen is a
 * chunk of its own, loaded when first visited.
 */
const About = lazyChunk(() => import('../screens/About/index.tsx').then((m) => m.default))
const NotFound = lazyChunk(() => import('../screens/NotFound/index.tsx').then((m) => m.default))
const Onboarding = lazyChunk(() => import('../screens/Onboarding/index.tsx').then((m) => m.default))
const Chat = lazyChunk(() => import('../screens/Chat/index.tsx').then((m) => m.default))
const Conversations = lazyChunk(() => import('../screens/Conversations/index.tsx').then((m) => m.default))
const Providers = lazyChunk(() => import('../screens/Providers/index.tsx').then((m) => m.default))
const Provider = lazyChunk(() => import('../screens/Providers/Provider.tsx').then((m) => m.default))
const Sync = lazyChunk(() => import('../screens/Sync/index.tsx').then((m) => m.default))
const SyncJoin = lazyChunk(() => import('../screens/Sync/Join.tsx').then((m) => m.default))

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
          <Route path={paths.welcome} component={Welcome} />
          <Route path={paths.about} component={About} />
          <Route path={paths.createVault} component={Onboarding} />
          <Route path={paths.chat} component={Chat} />
          <Route path={paths.chatThread} component={Chat} />
          <Route path={paths.conversations} component={Conversations} />
          <Route path={paths.providers} component={Providers} />
          <Route path={paths.providerNew} component={Provider} />
          <Route path={paths.provider} component={Provider} />
          <Route path={paths.sync} component={Sync} />
          <Route path={paths.syncJoin} component={SyncJoin} />
          {/* Recovery is a screen of the lock gate; once the vault is open, its address leads home. */}
          <Route path={paths.recover}>
            <Redirect to={paths.welcome} replace />
          </Route>
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </ScreenBoundary>
  )
}
