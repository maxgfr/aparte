import { afterAll, describe, expect, test } from 'bun:test'
import * as z from 'zod'

// The page globals initSecurity reads, faked: Bun has no DOM. Each case imports a fresh copy of init.ts (a distinct
// query is a distinct module instance) because the module remembers its first outcome by design.
type InitModule = typeof import('./init.ts')
type TtModule = typeof import('./tt.ts')

const g = globalThis as Record<string, unknown>
const saved = Object.fromEntries(['window', 'document', 'location', 'trustedTypes'].map((k) => [k, g[k]]))

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v
})

/** A Trusted Types factory that records the policies created and wraps what they return. */
function fakeTrustedTypes() {
  const created: string[] = []
  return {
    created,
    createPolicy(name: string, rules: { createScriptURL?: (url: string) => string }) {
      created.push(name)
      return { name, createScriptURL: (url: string) => ({ trusted: rules.createScriptURL?.(url) }) }
    },
  }
}

function fakeDocument() {
  const replaced: unknown[][] = []
  const attrs: Record<string, string> = {}
  const element = () => ({
    textContent: '',
    setAttribute: (name: string, value: string) => {
      attrs[name] = value
    },
    append() {},
  })
  return {
    replaced,
    attrs,
    body: { replaceChildren: (...nodes: unknown[]) => replaced.push(nodes) },
    createElement: element,
  }
}

async function load<T>(path: string): Promise<T> {
  // A computed specifier: the query makes Bun evaluate a fresh instance, and TypeScript does not resolve it.
  const specifier: string = path
  return (await import(specifier)) as T
}

describe('initSecurity', () => {
  test('runs top-level: jitless Zod, one aparte policy, idempotent', async () => {
    const self = {}
    const tt = fakeTrustedTypes()
    const doc = fakeDocument()
    Object.assign(g, {
      window: { top: self, self, window: self, opener: null },
      document: doc,
      // Under bun test import.meta.env.BASE_URL is unset, so the base is '/'.
      location: new URL('https://maxgfr.github.io/'),
      trustedTypes: tt,
    })
    const { initSecurity } = await load<InitModule>('./init.ts?top')
    const { scriptURL } = await load<TtModule>('./tt.ts')

    expect(initSecurity()).toBe(true)
    expect(initSecurity()).toBe(true)
    expect(z.config().jitless).toBe(true)
    expect(tt.created).toEqual(['aparte'])
    expect(doc.replaced).toEqual([])

    // Script URLs now come from that policy, which still validates them.
    expect(scriptURL('/sw.js')).toEqual({ trusted: 'https://maxgfr.github.io/sw.js' } as never)
    expect(() => scriptURL('https://evil.example/sw.js')).toThrow(TypeError)
    expect(() => scriptURL('/src/main.tsx')).toThrow(TypeError)
    expect(tt.created).toEqual(['aparte'])

    // Remembered: being framed later (it cannot happen to a live window) does not flip the answer or touch the page.
    g.window = { top: {}, self, opener: null }
    expect(initSecurity()).toBe(true)
  })

  test.each([
    ['framed', { top: {}, opener: null }],
    ['opened', { top: undefined, opener: {} }],
  ] as const)('refuses to run %s and replaces the page once', async (reason, shape) => {
    const self = {}
    const doc = fakeDocument()
    Object.assign(g, {
      window: { top: shape.top ?? self, self, window: self, opener: shape.opener },
      document: doc,
      location: new URL('https://maxgfr.github.io/aparte/#/import?key=attacker'),
    })
    const { initSecurity } = await load<InitModule>(`./init.ts?${reason}`)
    expect(initSecurity()).toBe(false)
    expect(initSecurity()).toBe(false)
    expect(doc.replaced).toHaveLength(1)
    // The way out is the app's start page, never the URL the framing page chose.
    expect(doc.attrs.href).toBe('https://maxgfr.github.io/')
  })
})
