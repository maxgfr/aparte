import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { build, type Plugin } from 'vite'
import { SANDBOX_PAGES, type SandboxPage, sandboxPolicy, sandboxScriptURL } from '../src/security/policy.ts'
import { escapeAttribute } from './csp.ts'

/** The placeholders of the page templates (web/src/sandbox/frame/<page>.html). */
export const SANDBOX_CSP_PLACEHOLDER = '%APARTE_SANDBOX_CSP%'
export const SANDBOX_SCRIPT_PLACEHOLDER = '%APARTE_SANDBOX_SCRIPT%'

const VIRTUAL = 'virtual:aparte-sandbox-workers'
const RESOLVED = `\0${VIRTUAL}`

export interface SandboxBuildOptions {
  readonly origin: string
  readonly base: string
  /** The `web/` directory. */
  readonly root: string
  readonly minify?: boolean
}

/** Bundles one entry as a classic script (an IIFE: no import or export left), with the given virtual modules. */
async function classicScript(
  entry: string,
  o: SandboxBuildOptions,
  workers?: { readonly jsWorker: string; readonly pyWorker: string },
): Promise<string> {
  const virtual: Plugin = {
    name: 'aparte:sandbox-workers',
    resolveId: (id) => (id === VIRTUAL ? RESOLVED : null),
    load: (id) => {
      if (id !== RESOLVED) return null
      if (workers === undefined) throw new Error(`${entry} cannot import ${VIRTUAL}`)
      return `export const jsWorker = ${JSON.stringify(workers.jsWorker)}\nexport const pyWorker = ${JSON.stringify(workers.pyWorker)}\n`
    },
  }
  const output = await build({
    configFile: false,
    root: o.root,
    logLevel: 'silent',
    publicDir: false,
    mode: 'production',
    define: { __APARTE_APP_ORIGIN__: JSON.stringify(o.origin) },
    plugins: [virtual],
    build: {
      write: false,
      target: 'es2022',
      minify: o.minify ?? true,
      sourcemap: false,
      reportCompressedSize: false,
      lib: { entry: join(o.root, entry), formats: ['iife'], name: 'aparteSandbox', fileName: () => 'out.js' },
    },
  })
  const outputs = Array.isArray(output) ? output : [output]
  for (const out of outputs) {
    if (!('output' in out)) continue
    const chunk = out.output.find((c) => c.type === 'chunk')
    if (chunk !== undefined && chunk.type === 'chunk') return chunk.code
  }
  throw new Error(`sandbox: ${entry} produced no script`)
}

/** Fills a page template: its policy and its script URL. Throws when a placeholder is missing. */
export function sandboxPage(template: string, page: SandboxPage, o: { origin: string; base: string }): string {
  for (const placeholder of [SANDBOX_CSP_PLACEHOLDER, SANDBOX_SCRIPT_PLACEHOLDER]) {
    if (!template.includes(placeholder)) throw new Error(`sandbox/${page}.html: ${placeholder} is missing`)
  }
  return template
    .replaceAll(SANDBOX_CSP_PLACEHOLDER, escapeAttribute(sandboxPolicy(page, o)))
    .replaceAll(SANDBOX_SCRIPT_PLACEHOLDER, escapeAttribute(sandboxScriptURL(page, o)))
}

/** Every file of `<base>sandbox/`, by its path under it: each page and its script. */
export async function bundleSandbox(o: SandboxBuildOptions): Promise<Map<string, string>> {
  const jsWorker = await classicScript('src/sandbox/frame/js-worker.ts', o)
  const pyWorker = await classicScript('src/sandbox/frame/py-worker.ts', o)
  const files = new Map<string, string>()
  for (const page of SANDBOX_PAGES) {
    const template = await readFile(join(o.root, `src/sandbox/frame/${page}.html`), 'utf8')
    files.set(`${page}.html`, sandboxPage(template, page, o))
    files.set(`${page}.js`, await classicScript(`src/sandbox/frame/${page}.ts`, o, { jsWorker, pyWorker }))
  }
  return files
}

/**
 * Builds the sandbox pages into `<base>sandbox/`. Their CSP names the exact URL of their script on the app's origin
 * (as index.html's names the app's path), so they are written per build, like index.html, and never precached
 * (pwa.config.ts). Under `vite serve` they are built on request, for the origin the browser asked.
 */
export function sandboxPlugin(o: { origin: string; base: string }): Plugin {
  let root = process.cwd()
  return {
    name: 'aparte:sandbox',
    configResolved(config) {
      root = config.root
    },
    async generateBundle() {
      for (const [path, source] of await bundleSandbox({ ...o, root })) {
        this.emitFile({ type: 'asset', fileName: `sandbox/${path}`, source })
      }
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = req.url?.split('?')[0] ?? ''
        const prefix = `${o.base}sandbox/`
        if (!path.startsWith(prefix)) return next()
        try {
          const origin = `http://${req.headers.host ?? 'localhost'}`
          const file = (await bundleSandbox({ origin, base: o.base, root, minify: false })).get(
            path.slice(prefix.length),
          )
          if (file === undefined) return next()
          res.setHeader('Content-Type', path.endsWith('.html') ? 'text/html' : 'text/javascript')
          res.end(file)
        } catch (error) {
          next(error)
        }
      })
    },
  }
}
