import { type ReactNode, Suspense } from 'react'
import { Route, Router, Switch, useLocation } from 'wouter'
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
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </ScreenBoundary>
  )
}
