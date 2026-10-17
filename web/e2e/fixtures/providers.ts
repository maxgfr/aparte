import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BrowserContext, Request, Route } from '@playwright/test'
import type { Answer } from './sse.ts'

/*
 * The model providers, played by the test: Anthropic and Gemini on their own hosts, and an OpenAI-compatible server
 * the user typed (a loopback endpoint, as a local model server would be). Every request is recorded with its headers
 * and body, and checked against the rules of web/src/core/contracts/ai.ts: no header but the provider's own (an
 * unlisted one fails the CORS preflight of the real host), no AI SDK user-agent, and the key in its header only.
 *
 * A route fulfils with the whole body at once. A response that must arrive over time (a stream to stop half-way,
 * bytes cut at random) is served by a local HTTP server instead: the request to the loopback endpoint is continued
 * there, unseen by the app, which still sees its own URL.
 */

export const ANTHROPIC_ORIGIN = 'https://api.anthropic.com'
export const GOOGLE_ORIGIN = 'https://generativelanguage.googleapis.com'
/**
 * The OpenAI-compatible endpoint the specs type in. Port 9 (discard) would be refused by Firefox and WebKit before any
 * request, as a Fetch "bad port"; this one is not on that list and is never listened on by the specs themselves.
 */
export const CUSTOM_ORIGIN = 'http://127.0.0.1:18080'
export const CUSTOM_BASE_URL = `${CUSTOM_ORIGIN}/v1`

export type MockKind = 'anthropic' | 'google' | 'openai-compatible'

/** One request the app made to a provider. */
export interface Call {
  readonly kind: MockKind
  readonly method: string
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  /** The body as sent. */
  readonly raw: string
  /** The body parsed as JSON, or null. */
  readonly body: unknown
  /** Whether it asked for a generation (as opposed to a model list). */
  readonly generation: boolean
}

/** A response that arrives piece by piece: each chunk is flushed `delayMs` after the previous one. */
export interface Streamed {
  readonly chunks: readonly (string | Uint8Array)[]
  readonly delayMs?: number
  /** Keep the response open after the last chunk until `release()` or until the app closes it (a stop). */
  readonly hold?: boolean
}

/** A streamed response being served, as the local server sees it. */
export interface Serving {
  /** Chunks written so far. */
  written: number
  /** Whether the app closed the connection before the response ended. */
  closedByClient: boolean
  /** Whether the response ended, either way. */
  closed: boolean
}

/** Headers the browser sets itself; the app cannot choose them, so the policy below ignores them. */
const BROWSER_HEADERS = new Set([
  'accept-encoding',
  'accept-language',
  'cache-control',
  'connection',
  'content-length',
  'dnt',
  'host',
  'origin',
  'pragma',
  'priority',
  'referer',
  'te',
  'user-agent',
])

/** The only headers the app may set, per provider (web/src/core/contracts/ai.ts). */
const ALLOWED_HEADERS: Record<MockKind, ReadonlySet<string>> = {
  anthropic: new Set([
    'x-api-key',
    'anthropic-version',
    'anthropic-beta',
    'anthropic-dangerous-direct-browser-access',
    'content-type',
    'accept',
  ]),
  google: new Set(['x-goog-api-key', 'content-type', 'accept']),
  'openai-compatible': new Set(['authorization', 'content-type', 'accept']),
}

/** The model lists each provider answers a connection test with, in its own format. */
const MODEL_LISTS: Record<MockKind, unknown> = {
  anthropic: {
    data: [
      { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-04-01T00:00:00Z' },
      { type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-04-01T00:00:00Z' },
    ],
    has_more: false,
    first_id: 'claude-opus-5-5',
    last_id: 'claude-haiku-5-5',
  },
  google: {
    models: [
      {
        name: 'models/gemini-3-flash',
        displayName: 'Gemini 3 Flash',
        inputTokenLimit: 1048576,
        outputTokenLimit: 65536,
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
      },
    ],
  },
  'openai-compatible': {
    object: 'list',
    data: [{ id: 'llama-3.3-70b-versatile', object: 'model', created: 1760700000, owned_by: 'e2e' }],
  },
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'request-id, x-request-id',
}

const json = (status: number, data: unknown) => ({
  status,
  headers: { ...CORS, 'content-type': 'application/json' },
  body: JSON.stringify(data),
})

function isGeneration(kind: MockKind, method: string, url: URL): boolean {
  if (method !== 'POST') return false
  if (kind === 'anthropic') return url.pathname === '/v1/messages'
  if (kind === 'google') return /^\/v1beta\/models\/[^/]+:streamGenerateContent$/.test(url.pathname)
  return url.pathname === '/v1/chat/completions'
}

function isModelList(kind: MockKind, method: string, url: URL): boolean {
  if (method !== 'GET') return false
  if (kind === 'anthropic') return url.pathname === '/v1/models'
  if (kind === 'google') return url.pathname === '/v1beta/models'
  return url.pathname === '/v1/models'
}

export class ProviderMock {
  readonly calls: Call[] = []
  private readonly queues: Record<MockKind, (Answer | Streamed)[]> = {
    anthropic: [],
    google: [],
    'openai-compatible': [],
  }
  private readonly keys: Partial<Record<MockKind, string>> = {}
  private readonly found: string[] = []
  private readonly streams = new Map<string, { plan: Streamed; state: Serving }>()
  private readonly holds = new Set<() => void>()
  private server: Server | null = null
  private port = 0
  private waiters: (() => void)[] = []

  /** Routes the three providers of `context` to this mock. Routes added later run first, so call it after the gates. */
  static async install(context: BrowserContext): Promise<ProviderMock> {
    const mock = new ProviderMock()
    await mock.listen()
    await context.route(`${ANTHROPIC_ORIGIN}/**`, (route) => mock.handle('anthropic', route))
    await context.route(`${GOOGLE_ORIGIN}/**`, (route) => mock.handle('google', route))
    await context.route(`${CUSTOM_ORIGIN}/**`, (route) => mock.handle('openai-compatible', route))
    return mock
  }

  /** The key the app should send to `kind`: it must appear in the provider's auth header and nowhere else. */
  expectKey(kind: MockKind, key: string): void {
    this.keys[kind] = key
  }

  /** Queues the answers to the next generations asked of `kind`, in order. */
  serve(kind: MockKind, ...answers: (Answer | Streamed)[]): void {
    this.queues[kind].push(...answers)
  }

  /** The generation requests made to `kind` so far, oldest first. */
  generations(kind: MockKind): Call[] {
    return this.calls.filter((c) => c.kind === kind && c.generation)
  }

  /** The body of the latest generation request to `kind`, as JSON. */
  lastBody(kind: MockKind): Record<string, unknown> {
    const last = this.generations(kind).at(-1)
    if (!last) throw new Error(`No generation was asked of ${kind}`)
    return last.body as Record<string, unknown>
  }

  /** Resolves once `kind` has received `count` generation requests. */
  async waitForGenerations(kind: MockKind, count: number, timeout = 30_000): Promise<Call[]> {
    const deadline = Date.now() + timeout
    while (this.generations(kind).length < count) {
      if (Date.now() > deadline)
        throw new Error(`${kind} received ${this.generations(kind).length} generations, expected ${count}`)
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        setTimeout(resolve, 100)
      })
    }
    return this.generations(kind)
  }

  /** The streamed responses served so far, in order. */
  served(): Serving[] {
    return [...this.streams.values()].map((s) => s.state)
  }

  /** Ends every held response normally. */
  release(): void {
    for (const end of this.holds) end()
    this.holds.clear()
  }

  /** Everything that broke the request rules, and answers queued but never asked for. */
  problems(): string[] {
    const unused = (Object.keys(this.queues) as MockKind[])
      .filter((k) => this.queues[k].length > 0)
      .map((k) => `${this.queues[k].length} answer(s) queued for ${k} were never requested`)
    return [...this.found, ...unused]
  }

  async close(): Promise<void> {
    this.release()
    const server = this.server
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(kind: MockKind, route: Route): Promise<void> {
    const request = route.request()
    const method = request.method()
    const url = new URL(request.url())
    // Playwright answers the CORS preflight of a routed request itself; one that reaches a route is answered the way
    // the real hosts do, with the provider's own headers only.
    if (method === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          ...CORS,
          'access-control-allow-methods': 'GET, POST',
          'access-control-allow-headers': [...ALLOWED_HEADERS[kind]].join(', '),
          'access-control-max-age': '600',
        },
      })
      return
    }
    const call = await this.record(kind, request, url)
    if (isModelList(kind, method, url)) {
      await route.fulfill(json(200, MODEL_LISTS[kind]))
      return
    }
    if (!call.generation) {
      this.found.push(`Unexpected request to ${kind}: ${method} ${url.href}`)
      await route.fulfill(json(404, { error: { type: 'not_found_error', message: 'Not found' } }))
      return
    }
    const answer = this.queues[kind].shift()
    if (!answer) {
      this.found.push(`Generation asked of ${kind} with no answer queued: ${method} ${url.href}`)
      await route.fulfill(json(500, { error: { type: 'api_error', message: 'No answer queued by the test' } }))
      return
    }
    if ('body' in answer) {
      await route.fulfill({
        status: answer.status,
        headers: { ...CORS, 'content-type': answer.contentType },
        body: answer.body,
      })
      return
    }
    if (kind !== 'openai-compatible') throw new Error('Only the loopback endpoint can stream piece by piece')
    const token = `s${this.streams.size + 1}`
    this.streams.set(token, {
      plan: answer,
      state: { written: 0, closedByClient: false, closed: false },
    })
    await route.continue({ url: `http://127.0.0.1:${this.port}/stream/${token}` })
  }

  private async record(kind: MockKind, request: Request, url: URL): Promise<Call> {
    const headers = await request.allHeaders()
    const raw = request.postData() ?? ''
    let body: unknown = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      body = null
    }
    const call: Call = {
      kind,
      method: request.method(),
      url: url.href,
      headers,
      raw,
      body,
      generation: isGeneration(kind, request.method(), url),
    }
    this.calls.push(call)
    this.check(call)
    for (const wake of this.waiters.splice(0)) wake()
    return call
  }

  private check(call: Call): void {
    const where = `${call.method} ${call.url}`
    for (const name of Object.keys(call.headers)) {
      const lower = name.toLowerCase()
      if (BROWSER_HEADERS.has(lower) || lower.startsWith('sec-') || lower.startsWith(':')) continue
      if (!ALLOWED_HEADERS[call.kind].has(lower)) this.found.push(`Header ${lower} sent to ${call.kind}: ${where}`)
    }
    const agent = call.headers['user-agent'] ?? ''
    if (/ai-sdk|\bai\/\d/i.test(agent)) this.found.push(`AI SDK user-agent sent to ${call.kind}: ${agent}`)
    const key = this.keys[call.kind]
    if (!key) return
    if (call.raw.includes(key) || call.url.includes(key)) this.found.push(`API key outside its header: ${where}`)
    const sent =
      call.kind === 'anthropic'
        ? call.headers['x-api-key']
        : call.kind === 'google'
          ? call.headers['x-goog-api-key']
          : call.headers.authorization?.replace(/^Bearer /, '')
    if (sent !== key) this.found.push(`API key missing from the ${call.kind} auth header: ${where}`)
  }

  private async listen(): Promise<void> {
    const server = createServer((req, res) => {
      void this.stream(req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    this.server = server
    this.port = (server.address() as AddressInfo).port
  }

  private async stream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const cors = {
      ...CORS,
      'access-control-allow-methods': 'GET, POST',
      'access-control-allow-headers': [...ALLOWED_HEADERS['openai-compatible']].join(', '),
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end()
      return
    }
    const token = (req.url ?? '').replace(/^\/stream\//, '')
    const entry = this.streams.get(token)
    if (!entry) {
      res.writeHead(404, cors).end()
      return
    }
    const { plan, state } = entry
    req.resume()
    res.on('close', () => {
      if (!res.writableEnded) state.closedByClient = true
      state.closed = true
    })
    res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    res.flushHeaders()
    for (const chunk of plan.chunks) {
      if (state.closed) return
      if (plan.delayMs) await new Promise((resolve) => setTimeout(resolve, plan.delayMs))
      if (state.closed) return
      res.write(chunk)
      state.written += 1
    }
    if (plan.hold && !state.closed) {
      await new Promise<void>((resolve) => {
        const end = () => resolve()
        this.holds.add(end)
        res.on('close', () => {
          this.holds.delete(end)
          resolve()
        })
      })
    }
    if (!state.closed) res.end()
  }
}
