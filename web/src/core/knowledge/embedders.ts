/*
 * Embeddings through a provider's own API, with the key the user stored for it: OpenAI and OpenAI-compatible servers
 * (`/embeddings`), Mistral (`/embeddings`) and Gemini (`batchEmbedContents`). Requests go through the provider's
 * guarded fetch (core/ai/providers.ts), so only that API's own headers leave, over web/src/security/net.ts with
 * purpose `provider`.
 *
 * Invariants:
 * - Every vector is returned unit-length, one per text, in order; a response of another count or shape is an error.
 * - An error never carries the key: its message names the provider's HTTP status only.
 */

import { normalize } from '../ai/local/embed.ts'
import { baseUrlOf, guardedFetch } from '../ai/providers.ts'
import type { FetchLike, ProviderConfig, ProviderKind } from '../contracts/ai.ts'
import type { EmbedderPort } from '../contracts/knowledge.ts'

/** The kinds whose embeddings API this module calls, with the model a new knowledge base starts with. */
export const EMBEDDING_MODELS: Readonly<Partial<Record<ProviderKind, string>>> = {
  openai: 'text-embedding-3-small',
  google: 'gemini-embedding-001',
  mistral: 'mistral-embed',
  'openai-compatible': 'nomic-embed-text',
}

/** Texts sent in one request at most. */
export const API_BATCH = 64
/** Gemini's embeddings are asked at this size (it defaults to 3072 floats a vector). */
const GEMINI_DIMENSIONS = 768

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'EmbeddingError'
  }
}

export function embeddingKind(kind: ProviderKind): boolean {
  return EMBEDDING_MODELS[kind] !== undefined
}

/** What names the vectors of a provider's model. */
export function providerEmbedderKey(providerId: string, model: string): string {
  return `provider:${providerId}:${model}`
}

function vectorsFrom(rows: unknown, count: number): Float32Array[] {
  if (!Array.isArray(rows) || rows.length !== count) throw new EmbeddingError('The provider returned no embeddings')
  return rows.map((row) => {
    if (!Array.isArray(row) || row.length === 0 || row.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
      throw new EmbeddingError('The provider returned a malformed embedding')
    }
    return normalize(Float32Array.from(row as number[]))
  })
}

async function post(
  send: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
) {
  const res = await send(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined)
    throw new EmbeddingError(`The embeddings API answered HTTP ${res.status}`, res.status)
  }
  return (await res.json()) as unknown
}

/** Rows of an OpenAI-shaped answer, `{data: [{index, embedding}]}`, in input order. */
function openAiRows(json: unknown): unknown[] {
  const data = (json as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  return [...data]
    .sort((a, b) => Number((a as { index?: number }).index ?? 0) - Number((b as { index?: number }).index ?? 0))
    .map((d) => (d as { embedding?: unknown }).embedding)
}

export interface ApiEmbedderInput {
  readonly provider: ProviderConfig
  readonly model: string
  /** Null only for a keyless OpenAI-compatible server. */
  readonly apiKey: string | null
  /** web/src/core/ai/fetch.ts `providerFetch`, or a test's fake. */
  readonly fetch: FetchLike
}

export function createApiEmbedder(input: ApiEmbedderInput): EmbedderPort {
  const { provider, model, apiKey } = input
  const kind = provider.kind
  if (!embeddingKind(kind)) throw new EmbeddingError(`The ${kind} provider has no embeddings API here`)
  if (apiKey === null && kind !== 'openai-compatible') throw new EmbeddingError('The provider needs a key')
  const send = guardedFetch(kind, input.fetch)
  const base = baseUrlOf(provider)
  const batch = async (texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> => {
    if (kind === 'google') {
      const json = await post(
        send,
        `${base}/models/${encodeURIComponent(model)}:batchEmbedContents`,
        { 'x-goog-api-key': apiKey ?? '' },
        {
          requests: texts.map((text) => ({
            model: `models/${model}`,
            content: { parts: [{ text }] },
            outputDimensionality: GEMINI_DIMENSIONS,
          })),
        },
        signal,
      )
      const rows = ((json as { embeddings?: unknown } | null)?.embeddings ?? []) as { values?: unknown }[]
      return vectorsFrom(Array.isArray(rows) ? rows.map((r) => r?.values) : rows, texts.length)
    }
    const headers: Record<string, string> = apiKey === null ? {} : { authorization: `Bearer ${apiKey}` }
    const body = kind === 'openai' ? { model, input: texts, encoding_format: 'float' } : { model, input: texts }
    return vectorsFrom(openAiRows(await post(send, `${base}/embeddings`, headers, body, signal)), texts.length)
  }
  return {
    key: providerEmbedderKey(provider.id, model),
    async embed(texts, signal) {
      const out: Float32Array[] = []
      for (let i = 0; i < texts.length; i += API_BATCH) {
        signal?.throwIfAborted()
        out.push(...(await batch(texts.slice(i, i + API_BATCH), signal)))
      }
      const dim = out[0]?.length
      if (out.some((v) => v.length !== dim)) throw new EmbeddingError('The provider returned embeddings of mixed sizes')
      return out
    },
  }
}
