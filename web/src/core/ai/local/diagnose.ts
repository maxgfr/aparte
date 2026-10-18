/*
 * The diagnosis of a model server on this computer (Ollama, LM Studio, Jan, any OpenAI-compatible server on the
 * loopback). A failed call from a web page says almost nothing by itself: a CORS refusal, a server that is not
 * running and a browser that blocks local network access all look like the same TypeError. So the diagnosis asks
 * again in two ways: an ordinary request to the model list, and an opaque (`no-cors`) request that succeeds whenever
 * the server answers at all, CORS aside. Ollama is also asked its version on its native API. Every request goes
 * through the fetch it is handed (the app's network wrapper, purpose `provider`).
 */
import type { FetchLike } from '../../contracts/ai.ts'

export type ServerVerdict =
  /** The model list came back; `models` is how many the server lists. */
  | { readonly kind: 'ok'; readonly models: number; readonly version?: string }
  /** The server answered with an HTTP error. */
  | { readonly kind: 'http'; readonly status: number }
  /** The server answers but the browser refused to read the answer: it does not allow this origin (CORS). */
  | { readonly kind: 'cors' }
  /** Nothing answered: the server is not running at that address, or the browser blocked local network access. */
  | { readonly kind: 'unreachable' }
  /** The page is offline. */
  | { readonly kind: 'offline' }

export interface DiagnoseEnv {
  /** The app's network wrapper with purpose `provider` (`providerFetch`), or a test's fake. */
  readonly get: FetchLike
  readonly online: boolean
  readonly signal?: AbortSignal
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

function countModels(body: unknown): number {
  if (typeof body !== 'object' || body === null) return 0
  const data = (body as { data?: unknown; models?: unknown }).data ?? (body as { models?: unknown }).models
  return Array.isArray(data) ? data.length : 0
}

/** Diagnoses the server at `baseUrl` (as stored: `http://localhost:11434/v1`). `preset` names Ollama's native API. */
export async function diagnoseServer(
  baseUrl: string,
  preset: string | undefined,
  env: DiagnoseEnv,
): Promise<ServerVerdict> {
  if (!env.online) return { kind: 'offline' }
  const base = baseUrl.replace(/\/+$/, '')
  const init = env.signal ? { signal: env.signal } : {}
  try {
    const res = await env.get(`${base}/models`, { method: 'GET', headers: { accept: 'application/json' }, ...init })
    if (!res.ok) return { kind: 'http', status: res.status }
    const models = countModels(await readJson(res))
    if (preset !== 'ollama') return { kind: 'ok', models }
    const version = await ollamaVersion(base, env)
    return version === null ? { kind: 'ok', models } : { kind: 'ok', models, version }
  } catch (error) {
    if (env.signal?.aborted) throw error
  }
  try {
    await env.get(new URL(base).origin, { method: 'GET', mode: 'no-cors', cache: 'no-store', ...init })
    return { kind: 'cors' }
  } catch (error) {
    if (env.signal?.aborted) throw error
    return { kind: 'unreachable' }
  }
}

/** Ollama's version from its native API (`/api/version` at the server's root), or null. */
export async function ollamaVersion(baseUrl: string, env: DiagnoseEnv): Promise<string | null> {
  try {
    const res = await env.get(`${new URL(baseUrl).origin}/api/version`, {
      method: 'GET',
      ...(env.signal ? { signal: env.signal } : {}),
    })
    if (!res.ok) return null
    const body = await readJson(res)
    const version = typeof body === 'object' && body !== null ? (body as { version?: unknown }).version : undefined
    return typeof version === 'string' && /^[\w.+-]{1,40}$/.test(version) ? version : null
  } catch {
    return null
  }
}

/** Browsers whose page cannot reach plain-http servers on this computer from a secure page in every case. */
export function isSafari(userAgent: string): boolean {
  return /Safari\//.test(userAgent) && !/Chrome\/|Chromium\/|Edg\/|CriOS\/|FxiOS\/|Firefox\//.test(userAgent)
}
