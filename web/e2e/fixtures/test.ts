import { expect, type Gates, test as gated } from '../gates.ts'
import { CUSTOM_ORIGIN, ProviderMock } from './providers.ts'

/*
 * The gated `test` of e2e/gates.ts with the model providers played by the test. A spec that uses `providers` gets a
 * fresh mock per test, routed after the gates (so it answers first while the gates still see every request), and
 * fails when a request broke the provider rules or an answer it queued was never asked for.
 */

interface ProviderFixtures {
  providers: ProviderMock
}

export const test = gated.extend<ProviderFixtures>({
  // WebKit and Firefox do not let a test route what a page controlled by a service worker fetches: the request goes
  // out through the worker, past the mock and past the gates' abort. The specs that play the providers therefore run
  // without the app's service worker (e2e/shell.spec.ts covers it), so every provider request meets the mock.
  serviceWorkers: 'block',
  providers: async ({ context, gates }, use) => {
    void gates
    const mock = await ProviderMock.install(context)
    await use(mock)
    const problems = mock.problems()
    await mock.close()
    expect(problems, 'provider requests: headers, key placement and queued answers').toEqual([])
  },
})

export { expect }

/** What gates.ts is asked to offer: admitting, for one test, an origin it plays as an endpoint the user typed. */
type AdmitsUserEndpoints = Gates & { userEndpoint?: (origin: string) => void }

/**
 * Lets the loopback endpoint of the specs through the network gate for this test. Endpoints the user types are not
 * in spec/network-allowlist.json, so the gate admits them per test, the way `foreignPage` admits a page the test
 * plays; until gates.ts offers that, the spec fails here with the reason.
 */
export function admitCustomEndpoint(gates: Gates): void {
  if (gates.allows(new URL(CUSTOM_ORIGIN))) return
  const admitting = gates as AdmitsUserEndpoints
  if (typeof admitting.userEndpoint !== 'function')
    throw new Error(`The network gate cannot admit the user-typed endpoint ${CUSTOM_ORIGIN} (Gates.userEndpoint)`)
  admitting.userEndpoint(CUSTOM_ORIGIN)
}
