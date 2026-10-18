/*
 * The tool layer (web/src/core/contracts/tools.ts): identity and fingerprints, the registry and its drift detection,
 * the approval policy, the loop's result parts, and the built-in tools. Pinned here: a changed definition is a new
 * fingerprint that conversations and approvals made for the old one refuse; nothing but a read-only, closed-world
 * built-in runs unasked; fetch_url never reaches this machine or a private network.
 */
import { describe, expect, test } from 'bun:test'
import { InvalidInputError } from '../contracts/crypto.ts'
import type {
  FingerprintModule,
  LoopModule,
  PolicyModule,
  RegistryModule,
  Tool,
  ToolApproval,
  ToolApprovals,
} from '../contracts/tools.ts'
import type { SearchHit } from '../search/search.ts'
import {
  builtinTools,
  calculatorTool,
  currentTimeTool,
  FETCH_MAX_CHARS,
  fetchUrlTool,
  htmlText,
  privateHost,
  searchConversationsTool,
} from './builtins.ts'
import { calculate } from './calculator.ts'
import * as fingerprintImpl from './fingerprint.ts'
import * as loopImpl from './loop.ts'
import * as policyImpl from './policy.ts'
import * as registryImpl from './registry.ts'

const F: FingerprintModule = fingerprintImpl
const R: RegistryModule = registryImpl
const P: PolicyModule = policyImpl
const L: LoopModule = loopImpl

const CONV = 'aaaaaaaaaaaaaaaaaaaaaaaaaa'
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbbbb'

function fakeTool(over: Partial<Tool> = {}): Tool {
  return {
    name: 'lookup',
    description: 'Looks something up.',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
      additionalProperties: false,
    },
    annotations: { readOnly: true, destructive: false, openWorld: false },
    source: 'mcp',
    origin: 'server-1',
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    ...over,
  }
}

function memoryApprovals(): ToolApprovals & { readonly rows: Map<string, ToolApproval> } {
  const rows = new Map<string, ToolApproval>()
  const key = (k: string, c: string | null) => `${c ?? '*'}|${k}`
  return {
    rows,
    list: () => [...rows.values()],
    get: (k, c) => rows.get(key(k, c)),
    grant: ({ approvalKey, fingerprint, conversation }) =>
      rows.set(key(approvalKey, conversation), { approvalKey, fingerprint, conversation, grantedAt: 1 }),
    revoke: (k, c) => rows.delete(key(k, c)),
  }
}

const ctx = (signal = new AbortController().signal) => ({ conversationId: CONV, callId: 'c1', signal })

describe('identity and fingerprints', () => {
  test('the approval key names source, origin and name', () => {
    expect(F.approvalKeyOf({ source: 'mcp', origin: 'srv', name: 'x' })).toBe('mcp:srv:x')
    expect(F.approvalKeyOf({ source: 'builtin', name: 'calculator' })).toBe('builtin:-:calculator')
  })

  test('the fingerprint ignores member order, title and origin, and changes with anything the model reads', async () => {
    const base = fakeTool()
    const reordered = fakeTool({
      inputSchema: {
        additionalProperties: false,
        required: ['q'],
        properties: { q: { type: 'string' } },
        type: 'object',
      },
      title: 'Lookup',
      origin: 'elsewhere',
    })
    const fp = await F.fingerprintOf(base)
    expect(fp).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await F.fingerprintOf(reordered)).toBe(fp)
    for (const changed of [
      fakeTool({ description: 'Looks something up!' }),
      fakeTool({ name: 'lookup2' }),
      fakeTool({ inputSchema: { type: 'object', properties: { q: { type: 'number' } } } }),
      fakeTool({ annotations: { readOnly: true, destructive: false, openWorld: true } }),
    ]) {
      expect(await F.fingerprintOf(changed)).not.toBe(fp)
    }
  })

  test('canonical JSON is RFC 8785: sorted members, ECMAScript numbers, no whitespace', () => {
    expect(fingerprintImpl.canonicalJson({ b: [1, 0.5, -0, 1e21], a: 'é\n', c: { y: null, x: true } })).toBe(
      '{"a":"é\\n","b":[1,0.5,0,1e+21],"c":{"x":true,"y":null}}',
    )
    expect(() => fingerprintImpl.canonicalJson({ a: Number.NaN })).toThrow(InvalidInputError)
    expect(() => fingerprintImpl.canonicalJson({ a: '\ud800' })).toThrow(InvalidInputError)
  })
})

describe('the registry', () => {
  test('registers checked, frozen copies; refuses duplicates, reserved and malformed specs', async () => {
    const registry = R.createToolRegistry()
    const input = fakeTool()
    const registered = await registry.register(input)
    expect(registered.approvalKey).toBe('mcp:server-1:lookup')
    expect(registered.fingerprint).toBe(await F.fingerprintOf(input))
    ;(input.inputSchema as Record<string, unknown>).extra = 'changed later'
    expect('extra' in registered.tool.inputSchema).toBe(false)
    expect(Object.isFrozen(registered.tool.inputSchema)).toBe(true)
    await expect(registry.register(fakeTool())).rejects.toBeInstanceOf(InvalidInputError)
    for (const bad of [
      fakeTool({ name: 'web_search' }),
      fakeTool({ name: 'has space' }),
      fakeTool({ name: 'x'.repeat(65) }),
      fakeTool({ name: 'nodesc', description: ' ' }),
      fakeTool({ name: 'noschema', inputSchema: { type: 'string' } as never }),
      fakeTool({ name: 'nosource', source: 'plugin' as never }),
      fakeTool({ name: 'noannotations', annotations: { readOnly: true } as never }),
    ]) {
      await expect(registry.register(bad)).rejects.toBeInstanceOf(InvalidInputError)
    }
    expect(registry.list().map((r) => r.tool.name)).toEqual(['lookup'])
  })

  test('snapshots are sorted by name and carry the web search as a provider entry', async () => {
    const registry = R.createToolRegistry()
    await registry.register(fakeTool({ name: 'zeta' }))
    await registry.register(fakeTool({ name: 'alpha', source: 'builtin', origin: undefined }))
    const snapshot = await registry.snapshot(['zeta', 'alpha', 'unknown'], { webSearch: true })
    expect(snapshot.map((e) => [e.name, e.source])).toEqual([
      ['alpha', 'builtin'],
      ['web_search', 'provider'],
      ['zeta', 'mcp'],
    ])
    expect(snapshot[1]?.fingerprint).toBe(await F.webSearchFingerprint())
    expect(snapshot[0]).not.toHaveProperty('origin')
    expect(snapshot[2]?.origin).toBe('server-1')
  })

  test('drift: a changed definition and a vanished tool are reported, never declared', async () => {
    const registry = R.createToolRegistry()
    await registry.register(fakeTool({ name: 'stable' }))
    await registry.register(fakeTool({ name: 'changing' }))
    await registry.register(fakeTool({ name: 'leaving' }))
    const snapshot = await registry.snapshot(['stable', 'changing', 'leaving'], { webSearch: true })
    registry.unregister('changing')
    await registry.register(fakeTool({ name: 'changing', description: 'Now does something else.' }))
    registry.unregister('leaving')
    const resolved = registry.resolve(snapshot)
    expect(resolved.declared.map((r) => r.tool.name)).toEqual(['stable'])
    expect(resolved.drifted).toEqual(['changing'])
    expect(resolved.missing).toEqual(['leaving'])
    expect(resolved.webSearch).toBe(true)
    // The same name from another server is not the tool the conversation froze.
    registry.unregister('stable')
    await registry.register(fakeTool({ name: 'stable', origin: 'server-2' }))
    expect(registry.resolve(snapshot).missing).toContain('stable')
  })

  test('notifies subscribers of changes', async () => {
    const registry = R.createToolRegistry()
    let n = 0
    const off = registry.subscribe(() => n++)
    await registry.register(fakeTool())
    registry.unregister('lookup')
    registry.unregister('lookup')
    off()
    await registry.register(fakeTool())
    expect(n).toBe(2)
  })
})

describe('the approval policy', () => {
  async function setup(tool: Tool) {
    const registry = R.createToolRegistry()
    const registered = await registry.register(tool)
    const snapshot = await registry.snapshot([tool.name])
    return { registry, registered, resolved: registry.resolve(snapshot) }
  }

  test('only a read-only, closed-world built-in that asks for it runs unasked', () => {
    const builtin = fakeTool({ source: 'builtin', origin: undefined, autoApprove: true })
    expect(P.autoApproved(builtin)).toBe(true)
    expect(P.autoApproved({ ...builtin, autoApprove: undefined })).toBe(false)
    expect(P.autoApproved({ ...builtin, source: 'mcp' })).toBe(false)
    expect(P.autoApproved({ ...builtin, annotations: { readOnly: true, destructive: false, openWorld: true } })).toBe(
      false,
    )
    expect(P.autoApproved({ ...builtin, annotations: { readOnly: false, destructive: false, openWorld: false } })).toBe(
      false,
    )
    expect(P.autoApproved({ ...builtin, annotations: { readOnly: true, destructive: true, openWorld: false } })).toBe(
      false,
    )
  })

  test('asks, then honours a conversation approval there only and an always approval everywhere', async () => {
    const { registered, resolved } = await setup(fakeTool())
    const approvals = memoryApprovals()
    const decide = (conversationId: string) => P.decideApproval({ name: 'lookup', resolved, approvals, conversationId })
    expect(decide(CONV)).toEqual({ kind: 'ask' })
    P.recordDecision({ decision: 'once', tool: registered, approvals, conversationId: CONV })
    P.recordDecision({ decision: 'deny', tool: registered, approvals, conversationId: CONV })
    expect(approvals.rows.size).toBe(0)
    P.recordDecision({ decision: 'conversation', tool: registered, approvals, conversationId: CONV })
    expect(decide(CONV)).toEqual({ kind: 'run', by: 'conversation' })
    expect(decide(OTHER)).toEqual({ kind: 'ask' })
    P.recordDecision({ decision: 'always', tool: registered, approvals, conversationId: CONV })
    expect(decide(OTHER)).toEqual({ kind: 'run', by: 'always' })
  })

  test('an approval of an older fingerprint does not carry over to a changed definition', async () => {
    const { registered } = await setup(fakeTool())
    const approvals = memoryApprovals()
    P.recordDecision({ decision: 'always', tool: registered, approvals, conversationId: CONV })
    P.recordDecision({ decision: 'conversation', tool: registered, approvals, conversationId: CONV })
    const changed = await setup(fakeTool({ description: 'Now also deletes things.' }))
    expect(P.decideApproval({ name: 'lookup', resolved: changed.resolved, approvals, conversationId: CONV })).toEqual({
      kind: 'ask',
    })
  })

  test('refuses what the conversation does not declare, whatever was approved', async () => {
    const { registry, registered, resolved } = await setup(fakeTool())
    const approvals = memoryApprovals()
    P.recordDecision({ decision: 'always', tool: registered, approvals, conversationId: CONV })
    expect(P.decideApproval({ name: 'other', resolved, approvals, conversationId: CONV })).toEqual({
      kind: 'refuse',
      reason: 'undeclared',
    })
    expect(P.decideApproval({ name: 'web_search', resolved, approvals, conversationId: CONV }).kind).toBe('refuse')
    const snapshot = await registry.snapshot(['lookup'])
    registry.unregister('lookup')
    await registry.register(fakeTool({ description: 'Changed.' }))
    expect(
      P.decideApproval({ name: 'lookup', resolved: registry.resolve(snapshot), approvals, conversationId: CONV }),
    ).toEqual({ kind: 'refuse', reason: 'drifted' })
    registry.unregister('lookup')
    expect(
      P.decideApproval({ name: 'lookup', resolved: registry.resolve(snapshot), approvals, conversationId: CONV }),
    ).toEqual({ kind: 'refuse', reason: 'missing' })
  })
})

describe('the loop parts', () => {
  test('the step budget grows with the effort', () => {
    expect(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((e) => L.stepBudget(e as never))).toEqual([
      2, 2, 4, 8, 16, 24, 32,
    ])
    expect(L.stepBudget(null)).toBe(8)
  })

  test('a result part: one text as a string, one JSON value as itself, a mix as a list; details and images kept', () => {
    const call = { callId: 'c1', name: 'x' }
    expect(
      L.resultPart(call, {
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toEqual({
      type: 'tool-result',
      callId: 'c1',
      name: 'x',
      output: 'a\n\nb',
    })
    expect(L.resultPart(call, { content: [{ type: 'json', value: { n: 1 } }], details: { d: 1 } })).toEqual({
      type: 'tool-result',
      callId: 'c1',
      name: 'x',
      output: { n: 1 },
      details: { d: 1 },
    })
    const image = { type: 'image' as const, blob: 'b', mediaType: 'image/png', width: 0, height: 0 }
    expect(
      L.resultPart(
        call,
        {
          content: [
            { type: 'text', text: 'see' },
            { type: 'json', value: 2 },
            { type: 'image', data: new Uint8Array([1]), mediaType: 'image/png' },
          ],
          isError: true,
        },
        [image],
      ),
    ).toEqual({
      type: 'tool-result',
      callId: 'c1',
      name: 'x',
      output: [
        { type: 'text', text: 'see' },
        { type: 'json', value: 2 },
      ],
      isError: true,
      parts: [image],
    })
  })

  test('a call that did not run gets a fixed error result naming why', () => {
    const a = L.unansweredResult({ callId: 'c1', name: 'x' }, 'denied')
    expect(a).toEqual({
      type: 'tool-result',
      callId: 'c1',
      name: 'x',
      output: 'The user declined to run this tool.',
      isError: true,
      details: { notRun: 'denied' },
    })
    expect(L.unansweredResult({ callId: 'c1', name: 'x' }, 'denied')).toEqual(a)
    const reasons = ['denied', 'stopped', 'budget', 'undeclared', 'drifted', 'missing', 'interrupted'] as const
    const texts = reasons.map((r) => L.unansweredResult({ callId: 'c', name: 'x' }, r).output)
    expect(new Set(texts).size).toBe(reasons.length)
  })
})

describe('the calculator', () => {
  test.each([
    ['17 * 24', 408],
    ['2 + 3 * 4', 14],
    ['(2 + 3) * 4', 20],
    ['-2^2', -4],
    ['2^-1', 0.5],
    ['2^3^2', 512],
    ['10 % 4', 2],
    ['sqrt(16) + abs(-3)', 7],
    ['log(1000)', 3],
    ['log(8, 2)', 3],
    ['round(pi, 2)', 3.14],
    ['max(1, 7, 3) - min(4, 2)', 5],
    ['1_000 * 1.5e3', 1_500_000],
    ['6 × 7 ÷ 2', 21],
  ])('%s = %d', (expression, value) => {
    expect(calculate(expression)).toBeCloseTo(value, 10)
  })

  test.each(['2 +', 'foo(1)', 'alert(1)', '1; 2', 'constructor', '((1)', 'sqrt(1, 2)', '"1"', `${'('.repeat(80)}1`])(
    'refuses %s',
    async (expression) => {
      const result = await calculatorTool().execute({ expression }, ctx())
      expect(result.isError).toBe(true)
    },
  )

  test('the tool returns the number as text and refuses a missing expression', async () => {
    expect(await calculatorTool().execute({ expression: '17 * 24' }, ctx())).toEqual({
      content: [{ type: 'text', text: '408' }],
    })
    expect((await calculatorTool().execute({}, ctx())).isError).toBe(true)
    expect((await calculatorTool().execute({ expression: '1/0' }, ctx())).isError).toBe(true)
  })
})

describe('the built-in tools', () => {
  test('which are offered, with which annotations', () => {
    const fetch = async () => new Response('')
    const search = { search: async () => [] }
    expect(builtinTools({ clock: { now: () => 0 } }).map((t) => t.name)).toEqual(['calculator', 'current_time'])
    const all = builtinTools({ clock: { now: () => 0 }, download: fetch, search })
    expect(all.map((t) => [t.name, P.autoApproved(t), t.annotations.openWorld])).toEqual([
      ['calculator', true, false],
      ['current_time', true, false],
      ['fetch_url', false, true],
      ['search_conversations', false, false],
    ])
    for (const t of all) {
      expect(t.source).toBe('builtin')
      expect(t.annotations.readOnly).toBe(true)
      expect(t.annotations.destructive).toBe(false)
    }
  })

  test('current_time reads the clock', async () => {
    const tool = currentTimeTool({ clock: { now: () => Date.UTC(2026, 9, 18, 12, 30) }, timeZone: 'Europe/Paris' })
    const result = await tool.execute({}, ctx())
    expect(result.content[0]).toMatchObject({
      type: 'json',
      value: { utc: '2026-10-18T12:30:00.000Z', timeZone: 'Europe/Paris' },
    })
    const value = (result.content[0] as unknown as { value: { local: string } }).value
    expect(value.local).toContain('2:30')
  })

  test('search_conversations leaves out the conversation asking, and returns excerpts as data', async () => {
    const hit = (conversation: string, title: string): SearchHit => ({
      conversation,
      title,
      score: 1,
      titleMatch: false,
      messages: [{ id: 'm', snippet: { text: `about ${title}`, highlights: [] } }],
    })
    const seen: string[] = []
    const tool = searchConversationsTool({
      search: {
        search: async (q) => {
          seen.push(q)
          return [hit(CONV, 'this one'), hit(OTHER, 'trip')]
        },
      },
    })
    const result = await tool.execute({ query: '  trip  ' }, ctx())
    expect(seen).toEqual(['trip'])
    expect(result.content).toEqual([
      { type: 'json', value: { query: 'trip', results: [{ title: 'trip', excerpts: ['about trip'] }] } },
    ])
    expect((await tool.execute({ query: '' }, ctx())).isError).toBe(true)
  })

  test('fetch_url refuses everything but public https before any request', async () => {
    const calls: string[] = []
    const tool = fetchUrlTool({
      download: async (input) => {
        calls.push(String(input))
        return new Response('x', { headers: { 'content-type': 'text/plain' } })
      },
    })
    for (const url of [
      'http://example.org/',
      'https://user:pw@example.org/',
      'https://localhost/',
      'https://127.0.0.1/',
      'https://10.1.2.3/',
      'https://192.168.1.1/',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/',
      'https://printer.local/',
      'https://intranet/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url',
    ]) {
      expect((await tool.execute({ url }, ctx())).isError).toBe(true)
    }
    expect(calls).toEqual([])
    expect(privateHost('example.org')).toBe(false)
    expect(privateHost('8.8.8.8')).toBe(false)
    expect(privateHost('fd00::1')).toBe(true)
  })

  test('fetch_url reads text without markup, caps it, and reports failures as results', async () => {
    const page = `<html><head><title>T</title><script>steal()</script></head><body><h1>Hello &amp; welcome</h1><p>Line&nbsp;one<br>two</p><style>p{}</style></body></html>`
    let served: Response = new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    const seen: { url: string; init: RequestInit | undefined }[] = []
    const tool = fetchUrlTool({
      download: async (input, init) => {
        seen.push({ url: String(input), init })
        return served
      },
    })
    const ok = await tool.execute({ url: 'https://example.org/a#frag' }, ctx())
    expect(seen[0]?.url).toBe('https://example.org/a')
    expect(seen[0]?.init?.method).toBe('GET')
    expect(ok.isError).toBeUndefined()
    expect(ok.content).toEqual([{ type: 'text', text: 'Hello & welcome\nLine one\ntwo' }])
    expect(ok.details).toMatchObject({ status: 200, truncated: false })

    served = new Response('y'.repeat(FETCH_MAX_CHARS + 10), { headers: { 'content-type': 'text/plain' } })
    const long = await tool.execute({ url: 'https://example.org/b' }, ctx())
    expect((long.content[0] as { text: string }).text).toEndWith('[The content was cut: only its beginning is shown.]')
    expect(long.details).toMatchObject({ truncated: true })

    served = new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } })
    expect(await tool.execute({ url: 'https://example.org/c' }, ctx())).toMatchObject({ isError: true })
    served = new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'image/png' } })
    expect(await tool.execute({ url: 'https://example.org/d' }, ctx())).toMatchObject({ isError: true })

    const failing = fetchUrlTool({
      download: async () => {
        throw new TypeError('Failed to fetch')
      },
    })
    const cors = await failing.execute({ url: 'https://example.org/e' }, ctx())
    expect(cors.isError).toBe(true)
    expect((cors.content[0] as { text: string }).text).toContain('CORS')
  })

  test('fetch_url refuses what a redirect brought from this machine, a private network or plain http', async () => {
    // The user approved a public address; the site answers with a redirect to a local model server, which may well
    // let the app's origin read it. That answer must never reach the model.
    const redirectedTo = (url: string) => {
      const response = new Response('{"models":["secret-local-model"]}', {
        headers: { 'content-type': 'application/json' },
      })
      Object.defineProperty(response, 'redirected', { value: true })
      Object.defineProperty(response, 'url', { value: url })
      return response
    }
    let served = redirectedTo('http://127.0.0.1:11434/api/tags')
    const tool = fetchUrlTool({ download: async () => served })
    for (const target of [
      'http://127.0.0.1:11434/api/tags',
      'https://10.0.0.1/',
      'https://localhost:8443/',
      'http://example.org/',
    ]) {
      served = redirectedTo(target)
      const result = await tool.execute({ url: 'https://example.org/r' }, ctx())
      expect(result.isError, target).toBe(true)
      expect(JSON.stringify(result.content), target).not.toContain('secret-local-model')
    }
    served = redirectedTo('https://www.example.org/r')
    const ok = await tool.execute({ url: 'https://example.org/r' }, ctx())
    expect(ok.isError).toBeUndefined()
    expect(ok.details).toMatchObject({ url: 'https://www.example.org/r' })
  })

  test('fetch_url reads a Wikipedia article through its extracts API', async () => {
    const seen: string[] = []
    let served = () =>
      new Response(
        JSON.stringify({ query: { pages: [{ title: 'Église orthodoxe', extract: 'L’Église orthodoxe est…' }] } }),
        { headers: { 'content-type': 'application/json; charset=utf-8' } },
      )
    const tool = fetchUrlTool({
      download: async (input) => {
        seen.push(String(input))
        return served()
      },
    })
    const ok = await tool.execute({ url: 'https://fr.m.wikipedia.org/wiki/%C3%89glise_orthodoxe#Histoire' }, ctx())
    const api = new URL(seen[0] ?? '')
    expect(api.origin).toBe('https://fr.wikipedia.org')
    expect(api.pathname).toBe('/w/api.php')
    expect(api.searchParams.get('origin')).toBe('*')
    expect(api.searchParams.get('titles')).toBe('Église_orthodoxe')
    expect(ok.isError).toBeUndefined()
    expect(ok.content).toEqual([{ type: 'text', text: 'Église orthodoxe\n\nL’Église orthodoxe est…' }])
    expect(ok.details).toMatchObject({ url: 'https://fr.m.wikipedia.org/wiki/%C3%89glise_orthodoxe' })

    served = () =>
      new Response(JSON.stringify({ query: { pages: [{ title: 'Nope', missing: true }] } }), {
        headers: { 'content-type': 'application/json' },
      })
    expect(await tool.execute({ url: 'https://en.wikipedia.org/wiki/Nope' }, ctx())).toMatchObject({ isError: true })

    await tool.execute({ url: 'https://fr.wikipedia.org/w/index.php?search=orthodoxie' }, ctx())
    expect(seen.at(-1)).toBe('https://fr.wikipedia.org/w/index.php?search=orthodoxie')
  })

  test('fetch_url stops with the turn', async () => {
    const abort = new AbortController()
    const tool = fetchUrlTool({
      download: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          abort.abort()
        }),
    })
    await expect(tool.execute({ url: 'https://example.org/' }, ctx(abort.signal))).rejects.toThrow()
  })

  test('htmlText decodes entities and drops scripts, styles and comments', () => {
    expect(htmlText('<!-- x --><p>a&lt;b &#65;&#x42;</p><script>x()</script><noscript>n</noscript>c')).toBe('a<b AB\nc')
  })
})
