/*
 * AWS Signature Version 4 for S3 requests, over WebCrypto (no third-party signer). Checked against the worked examples
 * of the S3 documentation ("Signature Calculations for the Authorization Header", GET Object, GET Bucket, PUT Object).
 */

import type { Bytes } from '../../contracts/crypto.ts'
import { toHex, utf8 } from '../../crypto/bytes.ts'
import { hmacSha256, sha256 } from '../../crypto/keys.ts'

export interface SigV4Input {
  readonly method: string
  readonly url: string
  /** Headers to send and sign besides host and the x-amz ones (content-type, range, x-amz-storage-class...). */
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: Uint8Array
  readonly region: string
  readonly service?: string
  /** `YYYYMMDDTHHMMSSZ`. */
  readonly datetime: string
  readonly accessKeyId: string
  readonly secretAccessKey: string
  readonly sessionToken?: string
}

/** RFC 3986 percent-encoding, as SigV4 wants it (encodeURIComponent leaves `!'()*` alone). */
export function uriEncode(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** An S3 key as a URL path: each segment encoded, the slashes kept. */
export const encodeKey = (key: string): string => key.split('/').map(uriEncode).join('/')

/** `20130524T000000Z` for a Unix time in milliseconds. */
export const amzDate = (ms: number): string => new Date(ms).toISOString().replace(/[:-]|\.\d{3}/g, '')

export interface Signed {
  /** Every header to send, Authorization included (but not Host, which the platform sets). */
  readonly headers: Record<string, string>
  readonly canonicalRequest: string
  readonly stringToSign: string
  readonly signature: string
}

export async function signV4(input: SigV4Input): Promise<Signed> {
  const service = input.service ?? 's3'
  const url = new URL(input.url)
  const payloadHash = toHex(await sha256(input.body ?? new Uint8Array()))
  const date = input.datetime.slice(0, 8)
  const scope = `${date}/${input.region}/${service}/aws4_request`

  const send: Record<string, string> = {}
  for (const [k, v] of Object.entries(input.headers ?? {})) send[k.toLowerCase()] = v
  send['x-amz-content-sha256'] = payloadHash
  send['x-amz-date'] = input.datetime
  if (input.sessionToken) send['x-amz-security-token'] = input.sessionToken

  const signing: Record<string, string> = { ...send, host: url.host }
  const names = Object.keys(signing).sort()
  const canonicalHeaders = names.map((n) => `${n}:${(signing[n] as string).trim().replace(/\s+/g, ' ')}\n`).join('')
  const signedHeaders = names.join(';')

  const query = [...url.searchParams]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  // The path is used as sent: S3 does not encode it a second time.
  const canonicalRequest = [
    input.method.toUpperCase(),
    url.pathname || '/',
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', input.datetime, scope, toHex(await sha256(utf8(canonicalRequest)))].join(
    '\n',
  )

  let key: Bytes = await hmacSha256(utf8(`AWS4${input.secretAccessKey}`), utf8(date))
  for (const part of [input.region, service, 'aws4_request']) key = await hmacSha256(key, utf8(part))
  const signature = toHex(await hmacSha256(key, utf8(stringToSign)))
  send.authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return { headers: send, canonicalRequest, stringToSign, signature }
}
