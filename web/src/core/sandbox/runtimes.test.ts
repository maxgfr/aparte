import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TamperedError } from '../contracts/crypto.ts'
import { utf8 } from '../crypto/bytes.ts'
import {
  checkHash,
  importsOf,
  MERMAID_VERSION,
  mermaidFile,
  PYODIDE_BASE,
  PYODIDE_VERSION,
  packageFile,
  parsePyodideLock,
  pyodideCore,
  resolvePackages,
} from './runtimes.ts'

const web = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url))
const pkg = JSON.parse(readFileSync(web('package.json'), 'utf8')) as { devDependencies: Record<string, string> }
const realLock = parsePyodideLock(readFileSync(web('node_modules/pyodide/pyodide-lock.json'), 'utf8'))

describe('the pinned runtimes', () => {
  test('pin the exact versions package.json installs, from their CDN paths', () => {
    expect(pkg.devDependencies.pyodide).toBe(PYODIDE_VERSION)
    expect(pkg.devDependencies.mermaid).toBe(MERMAID_VERSION)
    expect(PYODIDE_BASE).toBe(`https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`)
    expect(mermaidFile().url).toBe(`https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`)
  })

  test('every pinned hash matches the installed file', async () => {
    for (const file of pyodideCore()) {
      await checkHash(new Uint8Array(readFileSync(web(`node_modules/pyodide/${file.name}`))), file.sha256)
      expect(file.url).toBe(`${PYODIDE_BASE}${file.name}`)
    }
    await checkHash(new Uint8Array(readFileSync(web('node_modules/mermaid/dist/mermaid.min.js'))), mermaidFile().sha256)
  })

  test('the loader checks the version it was pinned for', () => {
    const loader = readFileSync(web('node_modules/pyodide/pyodide.js'), 'utf8')
    expect(loader).toContain(`"${PYODIDE_VERSION}"`)
  })
})

describe('checkHash', () => {
  test('a mismatch is TamperedError', async () => {
    const bytes = utf8('abc')
    await checkHash(bytes, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    await expect(checkHash(bytes, '0'.repeat(64))).rejects.toBeInstanceOf(TamperedError)
    await expect(checkHash(bytes, 'BA7816BF')).rejects.toThrow('64 lowercase hex')
  })
})

describe('the Pyodide lock', () => {
  test('has the scientific packages and their dependencies', () => {
    for (const name of ['numpy', 'pandas', 'matplotlib']) expect(realLock.packages.has(name)).toBe(true)
    expect(realLock.byImport.get('dateutil')).toBe('python-dateutil')
    expect(realLock.byImport.has('numpy-tests')).toBe(false)
  })

  test.each([
    ['not JSON', 'nope'],
    ['no packages', '{}'],
    ['a file name with a path', JSON.stringify({ packages: { a: entry({ file_name: '../a.whl' }) } })],
    [
      'a file name with an URL',
      JSON.stringify({ packages: { a: entry({ file_name: 'https://evil.example/a.whl' }) } }),
    ],
    ['a bad hash', JSON.stringify({ packages: { a: entry({ sha256: 'xyz' }) } })],
    ['an unknown dependency', JSON.stringify({ packages: { a: entry({ depends: ['b'] }) } })],
    ['imports that are not strings', JSON.stringify({ packages: { a: entry({ imports: [42] }) } })],
  ])('refuses %s', (_name, text) => {
    expect(() => parsePyodideLock(text)).toThrow()
  })

  function entry(over: Record<string, unknown>) {
    return { file_name: 'a-1.0-py3-none-any.whl', sha256: 'c'.repeat(64), depends: [], imports: ['a'], ...over }
  }
})

describe('imports and packages', () => {
  test('finds top-level imports, not relative ones', () => {
    const code = [
      'import numpy as np, os.path',
      'from pandas.core import frame',
      '  import matplotlib.pyplot as plt  # plots',
      'from . import local',
      'x = "import nothing"',
    ].join('\n')
    expect(importsOf(code)).toEqual(['matplotlib', 'numpy', 'os', 'pandas'])
  })

  test('resolves imports and asked names to the dependency closure, sorted', () => {
    const { packages, unknown } = resolvePackages(realLock, 'import pandas as pd\nimport json', ['Python_DateUtil'])
    const names = packages.map((p) => p.name)
    expect(names).toEqual([...names].sort())
    expect(names).toEqual(expect.arrayContaining(['pandas', 'numpy', 'python-dateutil', 'pytz', 'six']))
    expect(unknown).toEqual([])
    const file = packageFile(packages[0] as (typeof packages)[number])
    expect(file.url.startsWith(PYODIDE_BASE)).toBe(true)
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('lists asked packages the distribution does not have', () => {
    expect(resolvePackages(realLock, 'print(1)', ['requests-evil', 'numpy']).unknown).toEqual(['requests-evil'])
    expect(resolvePackages(realLock, 'import json, sys').packages).toEqual([])
  })
})

describe('the network allowlist', () => {
  test('lists the host of every pinned runtime for purpose download', () => {
    const list = JSON.parse(readFileSync(web('../spec/network-allowlist.json'), 'utf8')) as { download: string[] }
    const hosts = new Set([...pyodideCore().map((f) => new URL(f.url).origin), new URL(mermaidFile().url).origin])
    // The sandbox hosts are a subset of `download`, which also carries the model-file hosts of other milestones.
    for (const host of hosts) expect([host, list.download]).toEqual([host, expect.arrayContaining([host])])
  })
})
