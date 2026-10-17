/**
 * Bundle budget (`bun run size`): fails when the initial JavaScript exceeds 150 KB gzip. Initial means what the
 * browser must load before the first render: the entry chunk `dist/index.html` references and, transitively, every
 * chunk it imports statically (Vite also lists those as modulepreload links). Chunks reached only by `import()` are
 * lazy and reported apart. Prints the breakdown either way.
 */
import { existsSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'

export const BUDGET = 150 * 1024

/** `assets/x.js` for `/aparte/assets/x.js` or `https://host/aparte/assets/x.js`, relative to `dist`. */
export function distPath(ref: string, base: string): string {
  const path = ref.replace(/^https?:\/\/[^/]+/, '')
  return path.startsWith(base) ? path.slice(base.length) : path.replace(/^\/+/, '')
}

/** The scripts and modulepreloads `index.html` references. */
export function htmlScripts(html: string): string[] {
  const refs = new Set<string>()
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]+\.m?js)"/g)) if (m[1]) refs.add(m[1])
  return [...refs]
}

/** Specifiers of a chunk's static imports and re-exports (`import(...)` is lazy and excluded). */
export function staticImports(code: string): string[] {
  const out = new Set<string>()
  for (const m of code.matchAll(/(?:^|[;\s}])(?:import|export)\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"']+)["']/g)) {
    if (m[1]) out.add(m[1])
  }
  return [...out]
}

/** Every `dist`-relative chunk the given entries load statically, entries included. */
export async function initialChunks(dist: string, entries: readonly string[]): Promise<string[]> {
  const seen = new Set<string>()
  const queue = [...entries]
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (seen.has(file)) continue
    seen.add(file)
    const code = await Bun.file(join(dist, file)).text()
    for (const spec of staticImports(code)) {
      if (spec.startsWith('.')) queue.push(posix.normalize(posix.join(posix.dirname(file), spec)))
    }
  }
  return [...seen]
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`

async function main(): Promise<number> {
  const web = resolve(import.meta.dir, '..')
  // An optional argument names another build directory; the default is web/dist.
  const dist = process.argv[2] ? resolve(process.argv[2]) : join(web, 'dist')
  const index = join(dist, 'index.html')
  if (!existsSync(index)) {
    console.error('size: dist/index.html is missing; run `bun run build` first')
    return 1
  }
  const base = process.env.VITE_BASE ?? '/aparte/'
  const entries = htmlScripts(await Bun.file(index).text()).map((ref) => distPath(ref, base))
  if (entries.length === 0) {
    console.error('size: no initial JavaScript found in dist/index.html')
    return 1
  }
  for (const entry of entries) {
    if (!existsSync(join(dist, entry))) {
      console.error(`size: dist/index.html references ${entry}, which is not in dist`)
      return 1
    }
  }
  const initial = await initialChunks(dist, entries)
  const sizes = new Map<string, number>()
  for (const file of initial) sizes.set(file, gzipSync(await Bun.file(join(dist, file)).bytes()).length)
  const total = [...sizes.values()].reduce((a, b) => a + b, 0)

  console.log('initial JS (gzip):')
  for (const [file, size] of [...sizes].sort((a, b) => b[1] - a[1])) console.log(`  ${kb(size).padStart(9)}  ${file}`)

  let lazy = 0
  let lazyCount = 0
  for await (const file of new Bun.Glob('assets/**/*.{js,mjs}').scan({ cwd: dist })) {
    if (sizes.has(file)) continue
    lazy += gzipSync(await Bun.file(join(dist, file)).bytes()).length
    lazyCount++
  }
  console.log(`lazy JS: ${kb(lazy)} gzip in ${lazyCount} chunk${lazyCount === 1 ? '' : 's'}`)
  console.log(`initial JS: ${kb(total)} gzip (budget ${kb(BUDGET)})`)
  if (total > BUDGET) {
    console.error(`size: over budget by ${kb(total - BUDGET)}`)
    return 1
  }
  return 0
}

if (import.meta.main) process.exit(await main())
