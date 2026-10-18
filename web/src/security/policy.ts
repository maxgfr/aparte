/**
 * The app's Content-Security-Policy and the other response headers, as data shared by the build (the `<meta>` in
 * `index.html`, `build/csp.ts`), the service worker (headers it adds to navigations and worker scripts) and the scan
 * gate (`scripts/scan.ts`), so the three can never disagree.
 *
 * GitHub Pages sends no security headers, so the `<meta>` policy is what protects the first load. It cannot carry
 * `frame-ancestors` (ignored in a meta), which is why `src/security/frame.ts` refuses to run framed, and why the
 * service worker re-sends the policy as a real header once it controls the page.
 */

export interface PolicyOptions {
  /** The origin the app is served from, without a trailing slash (`https://maxgfr.github.io`). */
  origin: string
  /** The path the app is served under, with both slashes (`/aparte/`). */
  base: string
  /** `vite serve`: inline React refresh preamble, HMR web socket, no Trusted Types, no path restriction. */
  dev?: boolean
  /** The policy is sent as an HTTP header, so `frame-ancestors` is meaningful and appended. */
  header?: boolean
}

/**
 * Where the app may connect. Providers are chosen by the user (any HTTPS endpoint, or a local model server on the
 * loopback), so the CSP cannot list hosts; `src/security/net.ts` enforces the same rule in code and records each
 * origin for the transparency panel.
 */
const CONNECT = ["'self'", 'https:', 'http://localhost:*', 'http://127.0.0.1:*'] as const

/** Vite's dev server pushes updates over a web socket on the loopback. */
const DEV_CONNECT = ['ws://localhost:*', 'ws://127.0.0.1:*'] as const

/** Throws unless `origin` is a bare http(s) origin and `base` an absolute path ending in a slash. */
function checkOptions({ origin, base }: Pick<PolicyOptions, 'origin' | 'base'>): void {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new TypeError(`CSP origin is not a URL: ${origin}`)
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.origin !== origin) {
    throw new TypeError(`CSP origin must be a bare http(s) origin without a trailing slash: ${origin}`)
  }
  // A source expression ends at whitespace, ';' or ','; anything else outside the path grammar is refused too.
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(base)) {
    throw new TypeError(`CSP base must be an absolute path that starts and ends with '/': ${base}`)
  }
}

/** Joins directives as `name value value; name value`. */
function serialize(directives: ReadonlyArray<readonly [string, ...string[]]>): string {
  return directives.map((d) => d.join(' ')).join('; ')
}

/**
 * The app's policy. In production every script, style, font, manifest and worker must come from `<origin><base>`
 * (not just the origin: other projects share `maxgfr.github.io`), WebAssembly may compile but JavaScript may not be
 * evaluated, and every script URL sink requires a Trusted Type from the `aparte` policy (`dompurify` is reserved for
 * the sanitiser). Sandboxed frames for untrusted content live under `<base>sandbox/`.
 */
export function contentSecurityPolicy(o: PolicyOptions): string {
  checkOptions(o)
  const dev = o.dev === true
  const app = dev ? "'self'" : `${o.origin}${o.base}`
  const directives: Array<[string, ...string[]]> = [
    ['default-src', "'none'"],
    // 'unsafe-inline' only in dev: @vitejs/plugin-react injects an inline refresh preamble. Production has none.
    dev ? ['script-src', app, "'wasm-unsafe-eval'", "'unsafe-inline'"] : ['script-src', app, "'wasm-unsafe-eval'"],
    // Vite's dev server injects CSS as <style> elements; the build emits stylesheets only.
    dev ? ['style-src', app, "'unsafe-inline'"] : ['style-src', app],
    ['font-src', app],
    ['manifest-src', app],
    ['worker-src', app, 'blob:'],
    ['img-src', "'self'", 'blob:', 'data:'],
    ['media-src', "'self'", 'blob:'],
    dev ? ['connect-src', ...CONNECT, ...DEV_CONNECT] : ['connect-src', ...CONNECT],
    ['frame-src', dev ? "'self'" : `${o.origin}${o.base}sandbox/`],
    ['object-src', "'none'"],
    ['base-uri', "'none'"],
    ['form-action', "'none'"],
  ]
  // Vite's dev client and error overlay write HTML and script URLs without Trusted Types, so dev drops them.
  if (!dev) directives.push(['require-trusted-types-for', "'script'"], ['trusted-types', 'aparte', 'dompurify'])
  if (o.header === true) directives.push(['frame-ancestors', "'none'"])
  return serialize(directives)
}

/**
 * Headers the service worker adds to navigation responses. Pages cannot send them (GitHub Pages controls its
 * headers), so they only apply once the worker controls the page: from then on the document is isolated from
 * cross-origin openers, refuses to be framed and keeps powerful features to itself.
 */
export function securityHeaders(o: { origin: string; base: string }): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy({ ...o, header: true }),
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy':
      'camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()',
  }
}

/**
 * Headers for worker script responses. A dedicated worker loaded from a URL is governed by the policy of its own
 * response, not the page's, so without this header a worker could evaluate code or reach anything. Workers render
 * nothing: they may import the app's modules, compile WebAssembly and connect like the page, and nothing else.
 */
export function workerHeaders(o: { origin: string; base: string }): Record<string, string> {
  checkOptions(o)
  return {
    'Content-Security-Policy': serialize([
      ['default-src', "'none'"],
      ['script-src', `${o.origin}${o.base}`, "'wasm-unsafe-eval'"],
      ['connect-src', ...CONNECT],
    ]),
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  }
}

/** Parses a serialized policy into directive name → values, for tests and the scan gate. */
export function parsePolicy(policy: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const part of policy.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/)
    if (name) out.set(name.toLowerCase(), values)
  }
  return out
}

/** The sandbox pages, served under `<base>sandbox/` and framed by the app with `sandbox="allow-scripts"`. */
export type SandboxPage = 'runner' | 'artifact'

export const SANDBOX_PAGES: readonly SandboxPage[] = ['runner', 'artifact']

/** Where a sandbox page loads its one script from: `<origin><base>sandbox/<page>.js`. */
export function sandboxScriptURL(page: SandboxPage, o: { origin: string; base: string }): string {
  checkOptions(o)
  return `${o.origin}${o.base}sandbox/${page}.js`
}

/**
 * The meta policy of a sandbox page (web/src/sandbox/frame/). Sandbox frames have an opaque origin, which the
 * service worker never intercepts, so the page carries its whole policy itself; its workers (started from `blob:`)
 * and nested `srcdoc` frames inherit it. Nothing may be fetched or connected to: `connect-src 'none'`, no host for
 * images, styles, fonts, media, frames or forms. The only script URL is the page's own built script, exactly; the rest
 * comes from `blob:` URLs the page makes from bytes it was given (the pinned runtimes, the code to run).
 *
 * - runner: runs code in workers. `'unsafe-eval'` because Pyodide's dynamic libraries evaluate their JavaScript glue;
 *   evaluation inside the sandbox reaches nothing the code itself could not.
 * - artifact: renders an artifact, and runs its inline scripts and styles only once the user clicked Run (until
 *   then the nested frame is `sandbox=""`); images and fonts may come from `blob:` and `data:` only.
 */
export function sandboxPolicy(page: SandboxPage, o: { origin: string; base: string }): string {
  const script = sandboxScriptURL(page, o)
  const closed: Array<[string, ...string[]]> = [
    ['connect-src', "'none'"],
    ['frame-src', "'none'"],
    ['child-src', "'none'"],
    ['object-src', "'none'"],
    ['manifest-src', "'none'"],
    ['base-uri', "'none'"],
    ['form-action', "'none'"],
  ]
  if (page === 'runner') {
    return serialize([
      ['default-src', "'none'"],
      ['script-src', script, 'blob:', "'unsafe-eval'", "'wasm-unsafe-eval'"],
      ['worker-src', 'blob:'],
      ['img-src', "'none'"],
      ['style-src', "'none'"],
      ['font-src', "'none'"],
      ['media-src', "'none'"],
      ...closed,
    ])
  }
  return serialize([
    ['default-src', "'none'"],
    ['script-src', script, 'blob:', "'unsafe-inline'"],
    ['worker-src', "'none'"],
    ['img-src', 'blob:', 'data:'],
    ['style-src', "'unsafe-inline'"],
    ['font-src', 'data:'],
    ['media-src', 'blob:', 'data:'],
    ...closed,
  ])
}
