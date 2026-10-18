/*
 * An S3-compatible bucket as a sync store (AWS S3, Cloudflare R2, MinIO, Backblaze B2, Garage), ported from the
 * cursus provider with an in-house Signature V4 (sigv4.ts). Path-style addressing: `<endpoint>/<bucket>/<prefix><name>`.
 * Objects are stored as they are (envelopes, the marker, keyslots). A browser reaches the bucket only if its CORS
 * rule admits the app's origin: `corsRule` gives the rule to paste in the provider's console.
 */

import type { Bytes } from '../../contracts/crypto.ts'
import { type RemoteEntry, RemoteError, type RemoteErrorKind, type RemoteStore } from '../../contracts/sync.ts'
import type { Http } from './github.ts'
import { amzDate, encodeKey, signV4 } from './sigv4.ts'

export interface S3Options {
  /** Base URL without the bucket, such as `https://<account>.r2.cloudflarestorage.com`. */
  readonly endpoint: string
  /** `auto` for R2, `us-east-1` for MinIO's default. */
  readonly region: string
  readonly bucket: string
  readonly prefix?: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
  readonly http: Http
  readonly now?: () => number
  /** Keys per listing page (S3 caps it at 1000). */
  readonly pageSize?: number
}

const AUTH_CODES = new Set(['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ExpiredToken', 'InvalidToken'])
const REGION_CODES = new Set([
  'AuthorizationHeaderMalformed',
  'PermanentRedirect',
  'IllegalLocationConstraintException',
])
const QUOTA_CODES = new Set(['QuotaExceeded', 'XMinioStorageFull', 'StorageFull', 'EntityTooLarge'])

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** The five XML entities and numeric references; S3 bodies are flat and machine-written, so a regex is enough. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16))
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10))
    return NAMED[name] ?? whole
  })
}

function tagText(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml)
  return m?.[1] === undefined ? undefined : decodeEntities(m[1])
}

export interface ListPage {
  readonly keys: { readonly key: string; readonly size: number }[]
  readonly truncated: boolean
  readonly nextToken?: string
}

export function parseListPage(xml: string): ListPage {
  const keys: { key: string; size: number }[] = []
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = tagText(m[1] ?? '', 'Key')
    if (key !== undefined) keys.push({ key, size: Number(tagText(m[1] ?? '', 'Size') ?? 0) })
  }
  const nextToken = tagText(xml, 'NextContinuationToken')
  return { keys, truncated: tagText(xml, 'IsTruncated') === 'true', ...(nextToken ? { nextToken } : {}) }
}

export interface S3ErrorBody {
  readonly code?: string
  readonly message?: string
  readonly serverTime?: string
}

export function parseError(xml: string): S3ErrorBody {
  const body = /<Error>([\s\S]*?)<\/Error>/.exec(xml)?.[1]
  if (!body) return {}
  const code = tagText(body, 'Code')
  const message = tagText(body, 'Message')
  const serverTime = tagText(body, 'ServerTime')
  return { ...(code ? { code } : {}), ...(message ? { message } : {}), ...(serverTime ? { serverTime } : {}) }
}

/** An HTTP failure as a RemoteError kind; the S3 code wins over the status. */
export function classify(status: number, body: S3ErrorBody): RemoteErrorKind {
  const code = body.code ?? ''
  if (code === 'RequestTimeTooSkewed') return 'clock-skew'
  if (status === 429 || status === 503 || code === 'SlowDown' || code === 'TooManyRequests') return 'rate-limited'
  if (QUOTA_CODES.has(code) || status === 507) return 'quota'
  if (AUTH_CODES.has(code) || REGION_CODES.has(code) || status === 401) return 'auth'
  if (code === 'NoSuchBucket') return 'not-found'
  if (status >= 500) return 'network'
  return 'permission'
}

function retryAfter(h: string | null, now: number): number | undefined {
  if (!h) return undefined
  const s = Number(h)
  if (Number.isFinite(s)) return Math.max(0, s * 1000)
  const t = Date.parse(h)
  return Number.isNaN(t) ? undefined : Math.max(0, t - now)
}

const normalizePrefix = (prefix?: string): string => {
  const p = (prefix ?? '').trim().replace(/^\/+|\/+$/g, '')
  return p === '' ? '' : `${p}/`
}

export function s3StoreId(o: Pick<S3Options, 'endpoint' | 'bucket' | 'prefix'>): string {
  return `s3:${o.endpoint.replace(/\/+$/, '')}/${o.bucket}/${normalizePrefix(o.prefix)}`
}

export function s3Store(o: S3Options): RemoteStore {
  const prefix = normalizePrefix(o.prefix)
  const endpoint = o.endpoint.replace(/\/+$/, '')
  const base = `${endpoint}/${encodeURIComponent(o.bucket)}`
  const now = o.now ?? (() => Date.now())
  /** Server time minus local time, learnt from a RequestTimeTooSkewed answer. */
  let skewMs = 0

  async function send(method: string, url: string, body?: Uint8Array): Promise<Response> {
    const signed = await signV4({
      method,
      url,
      region: o.region,
      accessKeyId: o.accessKeyId,
      secretAccessKey: o.secretAccessKey,
      ...(o.sessionToken ? { sessionToken: o.sessionToken } : {}),
      datetime: amzDate(now() + skewMs),
      ...(body ? { body, headers: { 'content-type': 'application/octet-stream' } } : {}),
    })
    try {
      return await o.http(url, {
        method,
        headers: signed.headers,
        ...(body ? { body: new Uint8Array(body) } : {}),
        cache: 'no-store',
      })
    } catch (cause) {
      // In a browser, a bucket whose CORS rule does not admit the origin fails exactly like this.
      throw new RemoteError('network', `S3 ${method}: no answer (offline, or the bucket's CORS rule)`, { cause })
    }
  }

  /** One signed request; a RequestTimeTooSkewed answer is retried once with the server's time. 404 is returned. */
  async function request(method: string, url: string, body?: Uint8Array): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await send(method, url, body)
      if (res.ok || res.status === 404) return res
      const err = parseError(await res.text())
      const kind = classify(res.status, err)
      if (kind === 'clock-skew' && attempt === 0) {
        const server = Date.parse(res.headers.get('date') ?? '') || Date.parse(err.serverTime ?? '')
        if (!Number.isNaN(server)) {
          skewMs = server - now()
          continue
        }
      }
      const what = err.code ? `${err.code}${err.message ? `: ${err.message}` : ''}` : `HTTP ${res.status}`
      const wait = retryAfter(res.headers.get('retry-after'), now())
      throw new RemoteError(kind, `S3 ${method}: ${what}`, wait === undefined ? undefined : { retryAfterMs: wait })
    }
  }

  const listUrl = (full: string, maxKeys: number, token?: string): string => {
    const q = new URLSearchParams({ 'list-type': '2', prefix: full, 'max-keys': String(maxKeys) })
    if (token !== undefined) q.set('continuation-token', token)
    return `${base}?${q.toString()}`
  }

  return {
    id: s3StoreId(o),
    kind: 's3',
    keepsHistory: false,
    async list(listPrefix = '') {
      const pageSize = Math.min(1000, Math.max(1, o.pageSize ?? 1000))
      const out: RemoteEntry[] = []
      let token: string | undefined
      for (;;) {
        const res = await request('GET', listUrl(prefix + listPrefix, pageSize, token))
        if (res.status === 404) throw new RemoteError('not-found', `S3 bucket ${o.bucket} not found`)
        const page = parseListPage(await res.text())
        for (const k of page.keys) {
          if (k.key.startsWith(prefix)) out.push({ name: k.key.slice(prefix.length), size: k.size })
        }
        if (!page.truncated) break
        if (!page.nextToken) throw new RemoteError('network', 'S3 listing truncated without a continuation token')
        token = page.nextToken
      }
      return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    },
    async get(entry) {
      const res = await request('GET', `${base}/${encodeKey(prefix + entry.name)}`)
      if (res.status === 404) return null
      return new Uint8Array(await res.arrayBuffer()) as Bytes
    },
    async put(name, bytes) {
      const res = await request('PUT', `${base}/${encodeKey(prefix + name)}`, bytes)
      if (res.status === 404) throw new RemoteError('not-found', `S3 bucket ${o.bucket} not found`)
      await res.arrayBuffer()
    },
    async flush() {},
    async delete(name) {
      const res = await request('DELETE', `${base}/${encodeKey(prefix + name)}`)
      await res.arrayBuffer()
    },
  }
}

/**
 * The CORS rule a bucket needs for the app at `origin`: JSON for the AWS and R2 consoles, XML for the PutBucketCors
 * API (MinIO's `mc cors set`, B2). `Date` is exposed so a skewed clock can be corrected from the browser.
 */
export function corsRule(origin: string): { readonly json: string; readonly xml: string } {
  const methods = ['GET', 'PUT', 'DELETE', 'HEAD']
  const expose = ['ETag', 'Date']
  const json = JSON.stringify(
    [
      {
        AllowedOrigins: [origin],
        AllowedMethods: methods,
        AllowedHeaders: ['*'],
        ExposeHeaders: expose,
        MaxAgeSeconds: 3600,
      },
    ],
    null,
    2,
  )
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const xml = [
    '<CORSConfiguration>',
    '  <CORSRule>',
    `    <AllowedOrigin>${esc(origin)}</AllowedOrigin>`,
    ...methods.map((m) => `    <AllowedMethod>${m}</AllowedMethod>`),
    '    <AllowedHeader>*</AllowedHeader>',
    ...expose.map((h) => `    <ExposeHeader>${h}</ExposeHeader>`),
    '    <MaxAgeSeconds>3600</MaxAgeSeconds>',
    '  </CORSRule>',
    '</CORSConfiguration>',
  ].join('\n')
  return { json, xml }
}
