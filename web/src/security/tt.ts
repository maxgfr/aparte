/**
 * The `aparte` Trusted Types policy. The CSP requires a Trusted Type at every script URL sink (`new Worker`, service
 * worker registration, `<script src>`), and this policy is the only one the app creates: it vouches for the app's own
 * built modules and its service worker, nothing else. There is deliberately no `default` policy, which would silently
 * bless every string reaching a sink. The `dompurify` name in the CSP is reserved for the sanitiser.
 */

export const POLICY = 'aparte'

/** Where a script URL is resolved and what it must stay under. */
export interface ScriptURLContext {
  /** The document URL relative URLs resolve against. */
  href: string
  /** The app's base path (`/aparte/`). */
  base: string
  /** Vite's dev server serves modules from source paths with queries (`src/x.ts?worker_file&type=module`). */
  dev?: boolean
}

/** A built module: one path segment under `assets/`, as Vite names its chunks. */
const ASSET = /^assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.m?js$/

/** The service worker, at the root of the scope it controls. */
const SERVICE_WORKER = 'sw.js'

/**
 * Validates a script URL and returns it absolute; throws a TypeError otherwise. The URL must be same-origin and, once
 * the parser has resolved dot segments, sit under the base as `assets/<chunk>.js|.mjs` or `sw.js`, without a query or
 * a fragment (a query could select different code from a server that honours it; production never needs one).
 */
export function checkScriptURL(url: string | URL, ctx: ScriptURLContext): string {
  const raw = String(url)
  let parsed: URL
  try {
    parsed = new URL(raw, ctx.href)
  } catch {
    throw new TypeError(`Blocked script URL (unparsable): ${raw}`)
  }
  if (parsed.origin !== new URL(ctx.href).origin || parsed.username || parsed.password) {
    throw new TypeError(`Blocked script URL (not same-origin): ${raw}`)
  }
  if (!parsed.pathname.startsWith(ctx.base)) {
    throw new TypeError(`Blocked script URL (outside ${ctx.base}): ${raw}`)
  }
  if (parsed.href.includes('#')) throw new TypeError(`Blocked script URL (fragment): ${raw}`)
  if (ctx.dev === true) return parsed.href
  if (parsed.href.includes('?')) throw new TypeError(`Blocked script URL (query): ${raw}`)
  const rest = parsed.pathname.slice(ctx.base.length)
  if (rest !== SERVICE_WORKER && !ASSET.test(rest)) {
    throw new TypeError(`Blocked script URL (not a built module or the service worker): ${raw}`)
  }
  return parsed.href
}

// Vite replaces these at build time (`DEV` becomes `false`, so the dev branch is dropped from production bundles);
// under `bun test` they read the process environment and are undefined.
const BASE: unknown = import.meta.env.BASE_URL
const DEV: unknown = import.meta.env.DEV

/** The context of the running page. */
function pageContext(): ScriptURLContext {
  return { href: globalThis.location.href, base: typeof BASE === 'string' ? BASE : '/', dev: DEV === true }
}

/** The browser's Trusted Types factory, absent where the API is not implemented. */
function factory(): TrustedTypePolicyFactory | undefined {
  return (globalThis as { trustedTypes?: TrustedTypePolicyFactory }).trustedTypes
}

/** The policy once created; it stays unset where the browser has no Trusted Types. */
let policy: TrustedTypePolicy | undefined

/**
 * Creates the `aparte` policy once. Idempotent: under an enforced `trusted-types` directive a second policy with the
 * same name would throw, so the module keeps the first one.
 */
export function createPolicies(): void {
  if (policy) return
  const tt = factory()
  if (tt) policy = tt.createPolicy(POLICY, { createScriptURL: (url) => checkScriptURL(url, pageContext()) })
}

/**
 * A script URL fit for a sink: a TrustedScriptURL from the `aparte` policy where Trusted Types exist, the validated
 * absolute URL otherwise. Throws for anything but the app's own built modules and service worker.
 */
export function scriptURL(url: string | URL): TrustedScriptURL | string {
  createPolicies()
  return policy ? policy.createScriptURL(String(url)) : checkScriptURL(url, pageContext())
}
