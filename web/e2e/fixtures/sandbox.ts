import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { BrowserContext, Frame, Page } from '@playwright/test'

/*
 * The sandbox from the test's side: the pinned runtimes served offline from the exact packages installed (the same
 * bytes jsDelivr serves, which the unit tests check against runtime-lock.json), and a harness that frames the
 * sandbox pages in the app's page and talks to them over the real protocol, as web/src/sandbox/host.ts does.
 */

const web = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url))

const lock = JSON.parse(readFileSync(web('src/core/sandbox/runtime-lock.json'), 'utf8')) as {
  pyodide: { base: string; files: Record<string, string> }
  mermaid: { url: string; sha256: string }
}

export const PROTOCOL = 'aparte-sandbox/1'
export const CDN = 'https://cdn.jsdelivr.net'
export const PYODIDE_FILES = Object.entries(lock.pyodide.files).map(([name, sha256]) => ({
  name,
  sha256,
  url: `${lock.pyodide.base}${name}`,
}))
export const MERMAID = { url: lock.mermaid.url, sha256: lock.mermaid.sha256 }

interface LockPkg {
  file_name: string
  sha256: string
  depends: string[]
  imports: string[]
}
const pyodideLock = JSON.parse(readFileSync(web('node_modules/pyodide/pyodide-lock.json'), 'utf8')) as {
  packages: Record<string, LockPkg>
}

const canon = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-')
const byCanon = new Map(Object.entries(pyodideLock.packages).map(([name, p]) => [canon(name), { name, ...p }]))
const byImport = new Map<string, string>()
for (const [name, p] of Object.entries(pyodideLock.packages))
  for (const imp of p.imports) {
    const top = imp.split('.')[0] ?? imp
    if (!byImport.has(top)) byImport.set(top, name)
  }

/** The wheel files a Python run needs (its imports and asked packages, with dependencies), as assets to transfer. */
function pyodidePackages(
  code: string,
  asked: readonly string[],
): { name: string; sha256: string; url: string; pkg: string }[] {
  const wanted: string[] = []
  for (const line of code.split(/\r?\n/)) {
    const m = /^\s*(?:import\s+([A-Za-z_]\w*)|from\s+([A-Za-z_]\w*))/.exec(line)
    const name = m?.[1] ?? m?.[2]
    const pkg = name === undefined ? undefined : byImport.get(name)
    if (pkg !== undefined) wanted.push(pkg)
  }
  for (const a of asked) {
    const found = byCanon.get(canon(a))
    if (found !== undefined) wanted.push(found.name)
  }
  const seen = new Set<string>()
  const stack = [...wanted]
  while (stack.length > 0) {
    const name = stack.pop() as string
    if (seen.has(name)) continue
    seen.add(name)
    for (const dep of pyodideLock.packages[name]?.depends ?? []) {
      const d = byCanon.get(canon(dep))
      if (d !== undefined) stack.push(d.name)
    }
  }
  return [...seen].map((name) => {
    const resolved = byCanon.get(canon(name))
    if (resolved === undefined) throw new Error(`unknown pyodide package ${name}`)
    return {
      name: resolved.file_name,
      sha256: resolved.sha256,
      url: `${lock.pyodide.base}${resolved.file_name}`,
      pkg: resolved.name,
    }
  })
}

/** The local file a pinned CDN URL stands for, or null. */
function localFile(url: string): string | null {
  if (url === lock.mermaid.url) return web('node_modules/mermaid/dist/mermaid.min.js')
  if (url.startsWith(lock.pyodide.base)) {
    const name = url.slice(lock.pyodide.base.length)
    // Only the core files ship in the npm package; wheels are cached by bytesFor.
    if (Object.keys(lock.pyodide.files).includes(name)) return web(`node_modules/pyodide/${name}`)
  }
  return null
}

const WHEEL_CACHE = web('node_modules/.cache/aparte-wheels')

/**
 * The bytes a pinned CDN URL stands for: a core file from node_modules, or a package wheel from a local cache,
 * downloaded once from the CDN by the test process (never by the browser, which only ever talks to this route). A
 * missing, uncacheable file returns null and the route answers 404.
 */
async function bytesFor(url: string): Promise<Buffer | null> {
  const path = localFile(url)
  if (path !== null) {
    try {
      return readFileSync(path)
    } catch {
      return null
    }
  }
  // A wheel of the pinned distribution: not shipped in the npm package, so cached on disk after one download.
  if (!url.startsWith(lock.pyodide.base)) return null
  const name = url.slice(lock.pyodide.base.length)
  if (!/^[\w.+-]+\.whl$/.test(name)) return null
  const cached = `${WHEEL_CACHE}/${name}`
  if (existsSync(cached)) return readFileSync(cached)
  const response = await fetch(url)
  if (!response.ok) return null
  const buffer = Buffer.from(await response.arrayBuffer())
  mkdirSync(WHEEL_CACHE, { recursive: true })
  writeFileSync(cached, buffer)
  return buffer
}

const cache = new Map<string, Buffer>()

/**
 * Plays jsDelivr for this context: the pinned files from node_modules, a 404 for anything else. `tamper` names URLs
 * served with one byte changed. Returns the URLs requested, in order.
 */
export async function serveRuntimes(context: BrowserContext, tamper: readonly string[] = []): Promise<string[]> {
  const requested: string[] = []
  await context.route(`${CDN}/**`, async (route) => {
    const url = route.request().url()
    requested.push(url)
    const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' }
    const key = url
    let body = cache.get(key) ?? (await bytesFor(url)) ?? undefined
    if (body === undefined) return route.fulfill({ status: 404, headers, body: 'not found' })
    cache.set(key, body)
    if (tamper.includes(url)) {
      const copy = Buffer.from(body)
      copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 1
      body = copy
    }
    return route.fulfill({ status: 200, headers, body })
  })
  return requested
}

export interface Limits {
  timeoutMs: number
  memoryBytes: number
  outputChars: number
  maxFiles: number
  maxFileBytes: number
}

export const LIMITS: Limits = {
  timeoutMs: 60_000,
  memoryBytes: 1024 * 1024 * 1024,
  outputChars: 20_000,
  maxFiles: 16,
  maxFileBytes: 8 * 1024 * 1024,
}

/** Frames a sandbox page in the app's page as the app does and waits for it to say it is ready; returns its frame. */
export async function openSandbox(page: Page, which: 'runner' | 'artifact'): Promise<Frame> {
  await page.evaluate(async (which) => {
    const iframe = document.createElement('iframe')
    iframe.setAttribute('sandbox', 'allow-scripts')
    iframe.dataset.testSandbox = which
    iframe.title = `test ${which}`
    const ready = new Promise<void>((resolve) => {
      const listener = (event: MessageEvent) => {
        if (event.source === iframe.contentWindow && (event.data as { type?: string } | null)?.type === 'ready') {
          window.removeEventListener('message', listener)
          resolve()
        }
      }
      window.addEventListener('message', listener)
    })
    iframe.src = new URL(`sandbox/${which}.html`, document.baseURI).href
    document.body.append(iframe)
    await ready
  }, which)
  const frame = page.frames().find((f) => f.url().endsWith(`/sandbox/${which}.html`))
  if (frame === undefined) throw new Error(`The ${which} frame is not there`)
  return frame
}

export interface RunOutcome {
  status: string
  stdout: string
  stderr: string
  value?: string
  error?: string
  truncated: boolean
  files: { name: string; mediaType: string; text: string }[]
  images: number
  packages: string[]
}

/**
 * Runs code in the test's runner frame (openSandbox first) over the protocol; a Python run fetches Pyodide's core
 * from the CDN URLs (served by serveRuntimes) inside the page, as the app does.
 */
export async function runInFrame(
  page: Page,
  run: { language: 'javascript' | 'python'; code: string; limits?: Partial<Limits>; packages?: string[] },
): Promise<RunOutcome> {
  return page.evaluate(
    async ({ run, limits, protocol, pyodide, packages }) => {
      const iframe = document.querySelector<HTMLIFrameElement>('iframe[data-test-sandbox="runner"]')
      if (iframe?.contentWindow == null) throw new Error('No runner frame')
      const assets: { name: string; sha256: string; data: ArrayBuffer }[] = []
      if (run.language === 'python') {
        for (const file of pyodide) {
          const response = await fetch(file.url)
          assets.push({ name: file.name, sha256: file.sha256, data: await response.arrayBuffer() })
        }
      }
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
      const result = new Promise<Record<string, unknown>>((resolve) => {
        const listener = (event: MessageEvent) => {
          const data = event.data as { type?: string; id?: string; result?: Record<string, unknown> } | null
          if (event.source === iframe.contentWindow && data?.type === 'result' && data.id === id) {
            window.removeEventListener('message', listener)
            resolve(data.result ?? {})
          }
        }
        window.addEventListener('message', listener)
      })
      iframe.contentWindow.postMessage(
        {
          p: protocol,
          type: 'run',
          id,
          language: run.language,
          code: run.code,
          files: [],
          assets,
          packages,
          limits,
        },
        '*',
        assets.map((a) => a.data),
      )
      const r = (await result) as {
        files: { name: string; mediaType: string; data: ArrayBuffer }[]
        images: unknown[]
      } & Record<string, unknown>
      return {
        ...r,
        files: r.files.map((f) => ({ name: f.name, mediaType: f.mediaType, text: new TextDecoder().decode(f.data) })),
        images: r.images.length,
      } as unknown as RunOutcome
    },
    {
      run,
      limits: { ...LIMITS, ...run.limits },
      protocol: PROTOCOL,
      pyodide:
        run.language === 'python'
          ? [...PYODIDE_FILES, ...pyodidePackages(run.code, run.packages ?? [])]
          : PYODIDE_FILES,
      packages: run.language === 'python' ? pyodidePackages(run.code, run.packages ?? []).map((w) => w.pkg) : [],
    },
  )
}

export interface Rendered {
  type: 'rendered' | 'failed'
  height?: number
  message?: string
}

/**
 * Renders an artifact in the test's artifact frame (openSandbox first) over the protocol, like web/src/ui/chat/
 * Artifact.tsx. For a Mermaid diagram the test fetches the pinned bundle (served by serveRuntimes) and transfers it,
 * as the app does. Resolves with the first `rendered` or `failed` the frame posts back.
 */
export async function renderArtifact(
  page: Page,
  artifact: { kind: 'html' | 'svg' | 'mermaid'; source: string; run?: boolean; theme?: 'light' | 'dark' },
): Promise<Rendered> {
  const mermaid = artifact.kind === 'mermaid' ? MERMAID : null
  return page.evaluate(
    async ({ artifact, protocol, mermaid }) => {
      const iframe = document.querySelector<HTMLIFrameElement>('iframe[data-test-sandbox="artifact"]')
      if (iframe?.contentWindow == null) throw new Error('No artifact frame')
      const assets: { name: string; sha256: string; data: ArrayBuffer }[] = []
      if (mermaid !== null) {
        const response = await fetch(mermaid.url)
        assets.push({ name: 'mermaid.min.js', sha256: mermaid.sha256, data: await response.arrayBuffer() })
      }
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
      const done = new Promise<{ type: string; height?: number; message?: string }>((resolve) => {
        const listener = (event: MessageEvent) => {
          const data = event.data as { type?: string; id?: string; height?: number; message?: string } | null
          if (event.source !== iframe.contentWindow || data?.id !== id) return
          if (data.type === 'rendered' || data.type === 'failed') {
            window.removeEventListener('message', listener)
            resolve({ type: data.type, height: data.height, message: data.message })
          }
        }
        window.addEventListener('message', listener)
      })
      iframe.contentWindow.postMessage(
        {
          p: protocol,
          type: 'render',
          id,
          kind: artifact.kind,
          source: artifact.source,
          run: artifact.run ?? false,
          theme: artifact.theme ?? 'light',
          assets,
        },
        '*',
        assets.map((a) => a.data),
      )
      return (await done) as { type: 'rendered' | 'failed'; height?: number; message?: string }
    },
    { artifact, protocol: PROTOCOL, mermaid },
  )
}
