import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { type BrowserContext, test as base, expect, type Page } from '@playwright/test'
import type { NetPurpose } from '../src/security/net.ts'

/**
 * The end-to-end gates every spec runs under. Importing `test` from here instead of `@playwright/test` puts each
 * page of the test's context under three checks, all reported at the end of the test:
 *
 * 1. no Content-Security-Policy or Trusted Types violation, in any frame;
 * 2. no request to an origin other than the app's own, unless `spec/network-allowlist.json` lists that origin for one
 *    of the purposes the test declares with `test.use({ netPurposes: [...] })` (the request is aborted as well);
 * 3. no console error and no uncaught exception.
 *
 * A test that provokes a violation on purpose says so with `gates.expectViolation`, and then fails if the violation
 * does not happen: an expected refusal that silently stops occurring is a regression too.
 */

/** Every value of `NetPurpose`, checked against the type in both directions so the two cannot drift apart. */
const PURPOSES = [
  'provider',
  'mcp',
  'tool',
  'sync',
  'download',
  'catalog',
  'skills',
  'research',
  'app',
] as const satisfies readonly NetPurpose[]
const purposesComplete: [Exclude<NetPurpose, (typeof PURPOSES)[number]>] extends [never] ? true : false = true
void purposesComplete

/** One origin other than the app's own that the app may contact, and the purposes it may contact it for. */
export interface AllowedHost {
  origin: string
  purposes: NetPurpose[]
}

const ALLOWLIST_PATH = fileURLToPath(new URL('../../spec/network-allowlist.json', import.meta.url))

/** Loopback hosts, the only ones plain http may reach (a local model server, a local relay). */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Reads and validates `spec/network-allowlist.json`: one array per `NetPurpose`, each entry `"self"` (the app's own
 * origin, always allowed) or a bare origin. Keys starting with `$` are documentation. A missing purpose, an unknown
 * key or an entry that is not a bare https (or loopback http) origin throws, so a typo can never widen or silently
 * drop the gate.
 */
export function loadAllowlist(path = ALLOWLIST_PATH): AllowedHost[] {
  const data = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> | null
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${path}: expected an object`)
  for (const key of Object.keys(data))
    if (!key.startsWith('$') && !(PURPOSES as readonly string[]).includes(key))
      throw new Error(`${path}: unknown purpose ${key}`)
  const byOrigin = new Map<string, NetPurpose[]>()
  for (const purpose of PURPOSES) {
    const entries = data[purpose]
    if (!Array.isArray(entries)) throw new Error(`${path}: ${purpose} must be an array`)
    for (const entry of entries) {
      if (entry === 'self') continue
      const where = `${path}: ${purpose} entry ${JSON.stringify(entry)}`
      if (typeof entry !== 'string') throw new Error(`${where} is not a string`)
      let url: URL
      try {
        url = new URL(entry)
      } catch {
        throw new Error(`${where} is not an origin`)
      }
      if (url.origin !== entry) throw new Error(`${where} must be a bare origin (scheme, host and port only)`)
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))
        throw new Error(`${where} must be https, or http on the loopback`)
      byOrigin.set(entry, [...(byOrigin.get(entry) ?? []), purpose])
    }
  }
  return [...byOrigin].map(([origin, purposes]) => ({ origin, purposes }))
}

/** Schemes that reach the network; `blob:` and `data:` URLs are the page's own bytes and never leave it. */
const NETWORK_SCHEMES = ['http:', 'https:', 'ws:', 'wss:']

/** Whether a URL reaches the network at all. */
export function reachesNetwork(url: URL): boolean {
  return NETWORK_SCHEMES.includes(url.protocol)
}

/** Whether `url` is the origin `entry` names; websockets match the http origin of the same host and port. */
export function originMatches(entry: AllowedHost, url: URL): boolean {
  const scheme = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol
  return new URL(`${scheme}//${url.host}`).origin === entry.origin
}

/** A CSP or Trusted Types violation as the page saw it (`SecurityPolicyViolationEvent`). */
export interface Violation {
  directive: string
  blockedURI: string
  sourceFile: string
  line: number
  sample: string
  disposition: string
  documentURI: string
  /** The frame the event fired in, as Playwright knows it. */
  frame: string
}

interface ExpectedViolation {
  directive: string
  console?: RegExp
}

/** The binding the init script reports through; exposed on every context the gates watch. */
const BINDING = '__aparteGateViolation'

/**
 * Runs in every frame before any of its scripts. It listens at the window in the capture phase, so the app cannot
 * stop the event before it is recorded. The binding is looked up when an event fires, not when the script runs, as
 * Playwright does not promise which of the two is installed first.
 */
function recordViolations(binding: string) {
  window.addEventListener(
    'securitypolicyviolation',
    (e) => {
      const report = (window as unknown as Record<string, (v: unknown) => void>)[binding]
      report?.({
        directive: e.effectiveDirective || e.violatedDirective,
        blockedURI: e.blockedURI,
        sourceFile: e.sourceFile,
        line: e.lineNumber,
        sample: e.sample,
        disposition: e.disposition,
        documentURI: e.documentURI,
      })
    },
    true,
  )
}

/** What one test's gates saw, and the expectations it declared. */
export class Gates {
  readonly violations: Violation[] = []
  readonly consoleErrors: string[] = []
  readonly pageErrors: string[] = []
  /** Requests to hosts the allowlist does not grant this test: each one was aborted. */
  readonly blocked: string[] = []
  /** Every origin contacted, with whether it was the app's own, for the test's report. */
  readonly contacted = new Map<string, 'app' | 'foreign' | 'allowed' | 'blocked'>()
  private readonly expected: ExpectedViolation[] = []
  /** Console errors a test provokes on purpose without a violation event (a refusal the browser only logs). */
  private readonly expectedConsole: RegExp[] = []
  /** Exact URLs a test serves itself to play another site (an attacker framing the app). */
  private readonly foreign = new Set<string>()
  /** Origins a test plays as an endpoint the user typed (a local model server, a custom base URL). */
  private readonly userOrigins = new Set<string>()

  constructor(
    private readonly appOrigin: string,
    private readonly allowlist: readonly AllowedHost[],
    private readonly purposes: readonly NetPurpose[],
  ) {}

  /**
   * Declares that this test provokes a violation of `directive` on purpose. Violations of that directive are then
   * not failures, the console error the browser logs for them is matched by `console`, and the test fails unless at
   * least one such violation occurred.
   */
  expectViolation(directive: string, console?: RegExp): void {
    this.expected.push({ directive, console })
  }

  /**
   * Declares a console error this test provokes on purpose that comes with no `securitypolicyviolation` event: a
   * frame refused by `frame-ancestors` is reported to the framing page's console only. Errors matching `pattern` are
   * then not failures, and the test fails unless at least one occurred.
   */
  expectConsoleError(pattern: RegExp): void {
    this.expectedConsole.push(pattern)
  }

  /**
   * Serves `html` at `url` from the test itself, to play another site (a page framing the app, an opener). Only that
   * exact URL is admitted: anything else the foreign page or the app requests from its origin is still a failure.
   */
  async foreignPage(context: BrowserContext, url: string, html: string): Promise<void> {
    this.foreign.add(url)
    await context.route(url, (route) => route.fulfill({ contentType: 'text/html', body: html }))
  }

  /**
   * Admits `origin` for this test only, as an endpoint the user typed. Such endpoints are by rule not in the
   * allowlist; the test that plays one names it here, and every other origin stays a failure. Only a bare http(s)
   * origin is accepted, and plain http only on the loopback, as web/src/security/net.ts requires.
   */
  userEndpoint(origin: string): void {
    const url = new URL(origin)
    if (url.origin !== origin) throw new Error(`userEndpoint: ${origin} is not a bare origin`)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))
      throw new Error(`userEndpoint: ${origin} must be https, or http on the loopback`)
    this.userOrigins.add(origin)
  }

  /** Whether `url` is an origin admitted with `userEndpoint`. */
  private isUserEndpoint(url: URL): boolean {
    return [...this.userOrigins].some((origin) => originMatches({ origin, purposes: [] }, url))
  }

  /** Whether the app may contact `url`: its own origin always, any other host only through the allowlist. */
  allows(url: URL): boolean {
    if (url.origin === this.appOrigin || this.foreign.has(url.href) || this.isUserEndpoint(url)) return true
    return this.allowlist.some((e) => originMatches(e, url) && e.purposes.some((p) => this.purposes.includes(p)))
  }

  /** Records a request; false when it must be aborted. Schemes that never reach the network are not requests. */
  check(raw: string): boolean {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      this.blocked.push(raw)
      return false
    }
    if (!reachesNetwork(url)) return true
    const ok = this.allows(url)
    const key = url.protocol.startsWith('ws') ? `${url.protocol}//${url.host}` : url.origin
    const kind =
      url.origin === this.appOrigin
        ? 'app'
        : this.foreign.has(url.href) || this.isUserEndpoint(url)
          ? 'foreign'
          : ok
            ? 'allowed'
            : 'blocked'
    if (this.contacted.get(key) !== 'blocked') this.contacted.set(key, kind)
    if (!ok) this.blocked.push(raw)
    return ok
  }

  /** Puts `context` (and every page and frame it opens) under the gates. */
  async watch(context: BrowserContext): Promise<void> {
    await context.exposeBinding(BINDING, (source, v: Omit<Violation, 'frame'>) => {
      this.violations.push({ ...v, frame: source.frame.url() })
    })
    await context.addInitScript(recordViolations, BINDING)
    context.on('console', (m) => {
      if (m.type() === 'error') this.consoleErrors.push(`${m.page()?.url() ?? 'worker'}: ${m.text()}`)
    })
    context.on('weberror', (e) => {
      this.pageErrors.push(`${e.page()?.url() ?? 'worker'}: ${e.error().stack ?? e.error().message}`)
    })
    // The `request` event sees every request, including those a test fulfils itself with its own route: a mocked
    // host still has to be declared. The route below is the last in the chain and only aborts what is not allowed.
    context.on('request', (r) => {
      this.check(r.url())
    })
    // WebKit routes the `blob:` URLs a sandboxed frame loads its workers from: they are not requests (as `check`
    // says), so they go on untouched.
    await context.route(
      () => true,
      (route) => {
        const url = new URL(route.request().url())
        return !reachesNetwork(url) || this.allows(url) ? route.fallback() : route.abort('blockedbyclient')
      },
    )
    await context.routeWebSocket(
      () => true,
      (ws) => {
        if (this.check(ws.url())) ws.connectToServer()
        else void ws.close({ code: 1008, reason: 'Blocked by the e2e network gate' })
      },
    )
  }

  /** Everything that breaks a gate, one line each; empty when the test is clean. */
  problems(): string[] {
    const unexpected = this.violations.filter((v) => !this.expected.some((x) => x.directive === v.directive))
    const consoleErrors = this.consoleErrors.filter(
      (m) => !this.expected.some((x) => x.console?.test(m)) && !this.expectedConsole.some((re) => re.test(m)),
    )
    return [
      ...unexpected.map(
        (v) =>
          `CSP/TT violation: ${v.directive} blocked ${v.blockedURI || '(inline)'} at ${v.sourceFile || v.documentURI}:${v.line}` +
          `${v.sample ? ` sample ${JSON.stringify(v.sample)}` : ''} (${v.disposition}, frame ${v.frame})`,
      ),
      ...this.expected
        .filter((x) => !this.violations.some((v) => v.directive === x.directive))
        .map((x) => `Expected violation did not happen: ${x.directive}`),
      ...this.expectedConsole
        .filter((re) => !this.consoleErrors.some((m) => re.test(m)))
        .map((re) => `Expected console error did not happen: ${re}`),
      ...this.blocked.map(
        (u) => `Request outside the network allowlist (purposes: ${this.purposes.join(', ') || 'none'}): ${u}`,
      ),
      ...consoleErrors.map((m) => `Console error: ${m}`),
      ...this.pageErrors.map((m) => `Uncaught exception: ${m}`),
    ]
  }
}

interface GateFixtures {
  /** The network purposes this test exercises; the allowlist is applied for these only. None by default. */
  netPurposes: NetPurpose[]
  gates: Gates
}

/** Read once per worker, when the specs import the gates: a malformed allowlist fails every spec at load. */
const allowlist = loadAllowlist()

export const test = base.extend<GateFixtures>({
  netPurposes: [[], { option: true }],
  gates: [
    async ({ context, baseURL, netPurposes }, use, testInfo) => {
      if (!baseURL) throw new Error('The e2e gates need a baseURL to know the app origin')
      const gates = new Gates(new URL(baseURL).origin, allowlist, netPurposes)
      await gates.watch(context)
      await use(gates)
      await testInfo.attach('network', {
        contentType: 'application/json',
        body: JSON.stringify(Object.fromEntries(gates.contacted), null, 2),
      })
      expect(gates.problems(), 'e2e gates: CSP/Trusted Types, network allowlist, console and page errors').toEqual([])
    },
    { auto: true },
  ],
  // The page is created only once the gates watch its context, so its very first navigation is covered.
  page: async ({ page, gates }, use) => {
    void gates
    await use(page)
  },
})

export { expect }

/** No serious or critical accessibility violation on the current screen. */
export async function accessible(page: Page, screen: string): Promise<void> {
  await page.evaluate(async () => {
    // The first install of the service worker can announce itself with a toast that fades in, at whatever moment the
    // precache completes: the audit waits for that install, so the toast never starts entering while colours are
    // measured. The page registers its worker as it starts; a page whose worker is blocked has no registration.
    const registration = await navigator.serviceWorker?.getRegistration()
    if (registration !== undefined && registration.active === null) await navigator.serviceWorker.ready
    // What the install changed on screen is rendered by the next frame.
    await new Promise((resolve) => requestAnimationFrame(resolve))
    // Colours are measured once entrances (toasts, sheets) have finished fading in.
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
        // A cancelled animation (a sheet closed mid-way) rejects: it is finished all the same.
        .map((a) => a.finished.catch(() => undefined)),
    )
  })
  const { violations } = await new AxeBuilder({ page }).analyze()
  const bad = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
  expect(
    bad.map(
      (v) => `${screen}: ${v.id} ${v.nodes.map((n) => `${n.target.join(' ')} ${n.failureSummary ?? ''}`).join('; ')}`,
    ),
  ).toEqual([])
}
