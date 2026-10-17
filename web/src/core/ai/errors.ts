/*
 * What a failed provider call means to the user (ChatError in web/src/core/contracts/ai.ts). Every message here comes
 * from the provider or the network and is untrusted text: it is shown as text, cut to a readable length, and scrubbed
 * of the API key in case a server echoed it back.
 */
import { APICallError } from 'ai'
import type { ChatError, ChatErrorCode } from '../contracts/ai.ts'

const MAX_MESSAGE = 500

/** The error `type` a provider names in its body (Anthropic `overloaded_error`, OpenAI `insufficient_quota`...). */
const TYPE_CODES: Readonly<Record<string, ChatErrorCode>> = {
  authentication_error: 'auth',
  permission_error: 'auth',
  rate_limit_error: 'rate-limit',
  overloaded_error: 'overloaded',
  api_error: 'server',
  not_found_error: 'not-found',
  invalid_request_error: 'invalid-request',
  request_too_large: 'invalid-request',
  context_length_exceeded: 'context-length',
  insufficient_quota: 'rate-limit',
}

const CONTEXT_LENGTH =
  /prompt is too long|context[ _-]?length|context window|maximum context|too many (input )?tokens|input is too long|exceeds the model'?s? (maximum|context)/i

const BAD_KEY = /api key not valid|invalid api key|incorrect api key|invalid x-api-key/i

/** fetch rejects with a TypeError and one of these messages when there is no readable answer (offline, CORS, DNS). */
const NETWORK = /failed to fetch|fetch failed|networkerror|network error|load failed|cannot connect|network connection/i

const RETRYABLE: ReadonlySet<ChatErrorCode> = new Set([
  'auth-or-network',
  'rate-limit',
  'overloaded',
  'server',
  'truncated',
])

function scrub(message: string, apiKey: string | null): string {
  let out = message
  if (apiKey && apiKey.length >= 4) out = out.split(apiKey).join('***')
  return out.length > MAX_MESSAGE ? `${out.slice(0, MAX_MESSAGE)}…` : out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The provider's own error object from a parsed body: `{error: {type, message}}`, `{type, message}` or `[{error}]`. */
function errorObject(data: unknown): { type?: string; code?: string; message?: string } {
  const root = Array.isArray(data) ? data[0] : data
  if (!isRecord(root)) return {}
  const inner = isRecord(root.error) ? root.error : root
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined)
  const message = str(inner.message) ?? str(root.message) ?? (typeof root.error === 'string' ? root.error : undefined)
  return { type: str(inner.type) ?? str(inner.status), code: str(inner.code), message }
}

function parseBody(body: string | undefined): unknown {
  if (!body) return undefined
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

function codeForStatus(status: number, detail: { type?: string; code?: string; message: string }): ChatErrorCode {
  const named = (detail.code && TYPE_CODES[detail.code]) || (detail.type && TYPE_CODES[detail.type]) || undefined
  if (named === 'context-length' || CONTEXT_LENGTH.test(detail.message)) {
    if (status === 400 || status === 413 || status === 422 || named === 'context-length') return 'context-length'
  }
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return named === 'overloaded' ? 'overloaded' : 'rate-limit'
  if (status === 529 || status === 503 || named === 'overloaded') return 'overloaded'
  if (status === 404) return 'not-found'
  if (status >= 500) return 'server'
  if (status === 400 || status === 413 || status === 422) {
    // Gemini answers a bad key with 400 INVALID_ARGUMENT, "API key not valid".
    return named === 'auth' || BAD_KEY.test(detail.message) ? 'auth' : 'invalid-request'
  }
  return named ?? 'unknown'
}

function make(code: ChatErrorCode, message: string, apiKey: string | null, status?: number): ChatError {
  return {
    code,
    message: scrub(message, apiKey),
    ...(status === undefined ? {} : { status }),
    retryable: RETRYABLE.has(code),
  }
}

/** Whether an error or one of its causes is fetch failing without an answer. */
function isNetworkFailure(error: unknown): boolean {
  let e: unknown = error
  for (let depth = 0; depth < 5 && e instanceof Error; depth++) {
    if (NETWORK.test(e.message)) return true
    e = e.cause
  }
  return false
}

/**
 * Maps any failure of a provider call to a ChatError: an HTTP answer by status and the provider's error type, an
 * error event inside the stream by its type, and a fetch that rejected without an answer as `auth-or-network` (a key
 * refused without CORS headers looks exactly like being offline to a web page).
 */
export function describeError(error: unknown, apiKey: string | null): ChatError {
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined)
  if (isRecord(error)) {
    // An HTTP answer (APICallError) or an error event inside an open stream (the AI SDK's StreamProviderError, or the
    // provider's own error object): both name a status, a provider error type, or a body to read them from.
    const body = APICallError.isInstance(error) ? parseBody(error.responseBody) : undefined
    const fromData = errorObject(error.data ?? body)
    const type = str(error.type) ?? fromData.type
    const code = str(error.code) ?? fromData.code
    const status = typeof error.statusCode === 'number' ? error.statusCode : undefined
    const message = fromData.message ?? str(error.message) ?? ''
    // Only an HTTP answer has a status of its own; a stream error's status is inferred from its type.
    const http = APICallError.isInstance(error) ? status : undefined
    if (status !== undefined) return make(codeForStatus(status, { type, code, message }), message, apiKey, http)
    const named = (type && TYPE_CODES[type]) || (code && TYPE_CODES[code]) || undefined
    if (named) return make(named, message, apiKey)
  }
  if (isNetworkFailure(error)) {
    return make('auth-or-network', error instanceof Error ? error.message : '', apiKey)
  }
  return make('unknown', error instanceof Error ? error.message : String(error), apiKey)
}

/** The error a stream that stopped without its finish event ends with. */
export function truncatedError(): ChatError {
  return { code: 'truncated', message: '', retryable: true }
}
