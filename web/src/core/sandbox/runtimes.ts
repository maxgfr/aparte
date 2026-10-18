/*
 * The pinned runtimes of the sandboxes (runtime-lock.json): which files a Python run or a Mermaid diagram needs, where
 * they come from and the SHA-256 each must have. Pure: the page fetches (web/src/sandbox/runtime.ts), this module
 * decides what to fetch and checks what came back.
 *
 * Invariants:
 * - A file is used only once its bytes hash to the pinned value; anything else is refused with TamperedError, whatever
 *   the server or a cache returned.
 * - A Pyodide package is pinned by its entry in the pinned `pyodide-lock.json`, so the whole distribution is fixed by
 *   one hash: a package outside it is unknown and never fetched.
 * - File names from the lock are checked before they become URLs: one path segment, no `..`, the package extensions.
 */
import { InvalidInputError, TamperedError } from '../contracts/crypto.ts'
import type { PinnedFile } from '../contracts/sandbox.ts'
import { toHex } from '../crypto/bytes.ts'
import { sha256 } from '../crypto/keys.ts'
import lock from './runtime-lock.json'

const HEX64 = /^[0-9a-f]{64}$/

/** The core files of Pyodide, in the order the worker loads them. */
export const PYODIDE_CORE = [
  'pyodide.js',
  'pyodide.asm.js',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json',
] as const
export type PyodideCoreFile = (typeof PYODIDE_CORE)[number]

export const PYODIDE_VERSION: string = lock.pyodide.version
export const MERMAID_VERSION: string = lock.mermaid.version

/** Where the pinned Pyodide distribution is served from, with its trailing slash. */
export const PYODIDE_BASE: string = lock.pyodide.base

/** The pinned core files of Pyodide. */
export function pyodideCore(): readonly (PinnedFile & { readonly name: PyodideCoreFile })[] {
  const files = lock.pyodide.files as Readonly<Record<PyodideCoreFile, string>>
  return PYODIDE_CORE.map((name) => ({ name, url: `${PYODIDE_BASE}${name}`, sha256: files[name] }))
}

/** The pinned Mermaid bundle. */
export function mermaidFile(): PinnedFile {
  return { url: lock.mermaid.url, sha256: lock.mermaid.sha256 }
}

/** Throws TamperedError unless `bytes` hash to `expected` (lowercase hex SHA-256). */
export async function checkHash(bytes: Uint8Array, expected: string): Promise<void> {
  if (!HEX64.test(expected)) throw new InvalidInputError('A pinned hash is 64 lowercase hex digits')
  const actual = toHex(await sha256(bytes))
  if (actual !== expected) throw new TamperedError(`The file does not match its pinned SHA-256 (got ${actual})`)
}

/** One package of the pinned Pyodide distribution. */
export interface PyodidePackage {
  readonly name: string
  readonly fileName: string
  readonly sha256: string
  readonly depends: readonly string[]
  readonly imports: readonly string[]
}

export interface PyodideLock {
  readonly packages: ReadonlyMap<string, PyodidePackage>
  /** The package of a name as pip normalises it (`Python_DateUtil` is `python-dateutil`). */
  readonly byCanonical: ReadonlyMap<string, PyodidePackage>
  /** Top-level import name to package name. */
  readonly byImport: ReadonlyMap<string, string>
}

/** Normalises a package name as pip does (`Python_DateUtil` and `python-dateutil` are one package). */
function canonical(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,200}\.(?:whl|zip|tar)$/
const PACKAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,100}$/
const IMPORT_NAME = /^(?=.{1,200}$)[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/

function strings(value: unknown, pattern: RegExp, what: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && pattern.test(v)))
    throw new InvalidInputError(`pyodide-lock.json: ${what} is not a list of names`)
  return value as string[]
}

/** Reads the (already hash-checked) `pyodide-lock.json`. InvalidInputError when an entry is malformed. */
export function parsePyodideLock(text: string): PyodideLock {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new InvalidInputError('pyodide-lock.json is not JSON')
  }
  const raw = (data as { packages?: unknown } | null)?.packages
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new InvalidInputError('pyodide-lock.json has no packages')
  const packages = new Map<string, PyodidePackage>()
  const byImport = new Map<string, string>()
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value as Record<string, unknown> | null
    if (entry === null || typeof entry !== 'object') throw new InvalidInputError(`pyodide-lock.json: bad entry ${key}`)
    const { file_name: fileName, sha256: hash } = entry
    if (!PACKAGE_NAME.test(key)) throw new InvalidInputError(`pyodide-lock.json: bad package name ${key}`)
    if (typeof fileName !== 'string' || !FILE_NAME.test(fileName) || fileName.includes('..'))
      throw new InvalidInputError(`pyodide-lock.json: bad file name for ${key}`)
    if (typeof hash !== 'string' || !HEX64.test(hash))
      throw new InvalidInputError(`pyodide-lock.json: bad sha256 for ${key}`)
    const pkg: PyodidePackage = Object.freeze({
      name: key,
      fileName,
      sha256: hash,
      depends: Object.freeze(strings(entry.depends, PACKAGE_NAME, `${key}.depends`)),
      // A few entries list a name no import statement can spell (`numpy-tests`): those are left out.
      imports: Object.freeze(strings(entry.imports, /^.{1,200}$/, `${key}.imports`).filter((n) => IMPORT_NAME.test(n))),
    })
    packages.set(key, pkg)
    for (const name of pkg.imports) {
      const top = name.split('.')[0] as string
      if (!byImport.has(top)) byImport.set(top, key)
    }
  }
  const byCanonical = new Map<string, PyodidePackage>()
  for (const pkg of packages.values()) byCanonical.set(canonical(pkg.name), pkg)
  for (const pkg of packages.values())
    for (const dep of pkg.depends)
      if (!byCanonical.has(canonical(dep)))
        throw new InvalidInputError(`pyodide-lock.json: ${pkg.name} depends on unknown ${dep}`)
  return { packages, byCanonical, byImport }
}

/**
 * The top-level modules a Python source imports (`import a.b, c as d`, `from e.f import g`), without relative imports.
 * A text scan, not a parse: an import inside a string is found too, which only loads a package that is not needed.
 */
export function importsOf(code: string): string[] {
  const out = new Set<string>()
  for (const line of code.split(/\r?\n/)) {
    const from = /^\s*from\s+([A-Za-z_]\w*)[\w.]*\s+import\b/.exec(line)
    if (from?.[1]) {
      out.add(from[1])
      continue
    }
    const plain = /^\s*import\s+(.+)$/.exec(line)
    if (!plain?.[1]) continue
    for (const item of plain[1].split('#')[0]?.split(',') ?? []) {
      const name = /^\s*([A-Za-z_]\w*)/.exec(item)?.[1]
      if (name) out.add(name)
    }
  }
  return [...out].sort()
}

/**
 * The packages a run needs: those its imports name and those asked for, with every dependency, sorted by name.
 * `unknown` lists the asked names the distribution does not have (imports of other modules are left to Python).
 */
export function resolvePackages(
  lockfile: PyodideLock,
  code: string,
  asked: readonly string[] = [],
): { readonly packages: readonly PyodidePackage[]; readonly unknown: readonly string[] } {
  const wanted: string[] = []
  const unknown: string[] = []
  for (const name of importsOf(code)) {
    const pkg = lockfile.byImport.get(name)
    if (pkg !== undefined) wanted.push(pkg)
  }
  for (const name of asked) {
    const pkg = lockfile.byCanonical.get(canonical(name))?.name ?? lockfile.byImport.get(name)
    if (pkg === undefined) unknown.push(name)
    else wanted.push(pkg)
  }
  const seen = new Set<string>()
  const stack = [...wanted]
  while (stack.length > 0) {
    const name = stack.pop() as string
    if (seen.has(name)) continue
    seen.add(name)
    for (const dep of lockfile.packages.get(name)?.depends ?? []) {
      const found = lockfile.byCanonical.get(canonical(dep))
      if (found !== undefined) stack.push(found.name)
    }
  }
  const packages = [...seen].sort().map((name) => lockfile.packages.get(name) as PyodidePackage)
  return { packages, unknown: [...new Set(unknown)].sort() }
}

/** Where a package of the pinned distribution is fetched from. */
export function packageFile(pkg: PyodidePackage): PinnedFile {
  return { url: `${PYODIDE_BASE}${pkg.fileName}`, sha256: pkg.sha256 }
}
