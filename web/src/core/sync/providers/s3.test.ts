import { describe, expect, test } from 'bun:test'
import { device } from '../testkit.ts'
import { MemoryBucket } from './memory.ts'
import { remoteContract } from './remote.contract.ts'
import { classify, corsRule, parseListPage, s3Store } from './s3.ts'
import { signV4 } from './sigv4.ts'

const KEYS = { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret/test+key' }
const ENDPOINT = 'https://s3.example.test'

/**
 * A fake S3: path-style buckets, ListObjectsV2 with continuation tokens, GET/PUT/DELETE, and a signature check that
 * recomputes the Authorization header of every request.
 */
function fakeS3(options: { pageSize?: number; skewMs?: number } = {}) {
  const objects = new Map<string, Uint8Array>()
  const calls: string[] = []
  const handle = async (url: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? 'GET'
    const headers = init.headers as Record<string, string>
    const body = init.body instanceof Uint8Array ? init.body : undefined
    const date = headers['x-amz-date'] as string
    if (options.skewMs !== undefined) {
      const sent = Date.parse(
        `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
      )
      const server = Date.now() + options.skewMs
      if (Math.abs(server - sent) > 15 * 60_000) {
        return new Response('<Error><Code>RequestTimeTooSkewed</Code></Error>', {
          status: 403,
          headers: { date: new Date(server).toUTCString() },
        })
      }
    }
    const expected = await signV4({
      method,
      url,
      region: 'auto',
      ...KEYS,
      datetime: date,
      ...(body ? { body, headers: { 'content-type': 'application/octet-stream' } } : {}),
    })
    if (expected.headers.authorization !== headers.authorization) {
      return new Response('<Error><Code>SignatureDoesNotMatch</Code></Error>', { status: 403 })
    }
    const u = new URL(url)
    const [, bucket, ...rest] = decodeURIComponent(u.pathname).split('/')
    if (bucket !== 'vault') return new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 })
    const key = rest.join('/')
    calls.push(`${method} ${key || u.search}`)
    if (method === 'GET' && key === '') {
      const prefix = u.searchParams.get('prefix') ?? ''
      const max = Math.min(Number(u.searchParams.get('max-keys') ?? 1000), options.pageSize ?? 1000)
      const after = u.searchParams.get('continuation-token') ?? ''
      const all = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort()
      const page = all.slice(0, max)
      const truncated = all.length > max
      const xml = `<ListBucketResult>${page.map((k) => `<Contents><Key>${k}</Key><Size>${objects.get(k)?.length}</Size></Contents>`).join('')}<IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${page.at(-1)}</NextContinuationToken>` : ''}</ListBucketResult>`
      return new Response(xml, { status: 200 })
    }
    if (method === 'GET') {
      const v = objects.get(key)
      return v
        ? new Response(new Uint8Array(v), { status: 200 })
        : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
    }
    if (method === 'PUT') {
      objects.set(key, new Uint8Array(body ?? new Uint8Array()))
      return new Response('', { status: 200 })
    }
    if (method === 'DELETE') {
      objects.delete(key)
      return new Response(null, { status: 204 })
    }
    return new Response('', { status: 405 })
  }
  return { objects, calls, handle }
}

const store = (server: ReturnType<typeof fakeS3>, prefix = 'aparte') =>
  s3Store({ endpoint: ENDPOINT, region: 'auto', bucket: 'vault', prefix, ...KEYS, http: server.handle, pageSize: 2 })

remoteContract('S3', async () => {
  const server = fakeS3({ pageSize: 2 })
  return { store: store(server), again: () => store(server) }
})

describe('S3 store', () => {
  test('objects live under the prefix, byte for byte', async () => {
    const server = fakeS3()
    const s = store(server, 'my/prefix/')
    await s.put('fmt/1', new TextEncoder().encode('aparte/1\n'))
    expect([...server.objects.keys()]).toEqual(['my/prefix/fmt/1'])
  })

  test('a listing follows continuation tokens to the end', async () => {
    const server = fakeS3({ pageSize: 2 })
    const s = store(server)
    for (let i = 0; i < 7; i++) await s.put(`k/${'a'.repeat(16)}/000000000${i}-aaaaaaaa`, new Uint8Array([i]))
    expect((await s.list('')).length).toBe(7)
    expect(server.calls.filter((c) => c.startsWith('GET ?')).length).toBe(4)
  })

  test('wrong keys are an auth error; a missing bucket is not-found; a skewed clock is corrected once', async () => {
    const server = fakeS3()
    const bad = s3Store({
      endpoint: ENDPOINT,
      region: 'auto',
      bucket: 'vault',
      accessKeyId: 'x',
      secretAccessKey: 'y',
      http: server.handle,
    })
    await expect(bad.list('')).rejects.toMatchObject({ kind: 'auth' })
    const missing = s3Store({ endpoint: ENDPOINT, region: 'auto', bucket: 'other', ...KEYS, http: server.handle })
    await expect(missing.list('')).rejects.toMatchObject({ kind: 'not-found' })
    const skewed = fakeS3({ skewMs: 3_600_000 })
    const s = s3Store({ endpoint: ENDPOINT, region: 'auto', bucket: 'vault', ...KEYS, http: skewed.handle })
    expect(await s.list('')).toEqual([])
  })

  test('error codes map to the store error kinds', () => {
    expect(classify(503, { code: 'SlowDown' })).toBe('rate-limited')
    expect(classify(403, { code: 'SignatureDoesNotMatch' })).toBe('auth')
    expect(classify(400, { code: 'EntityTooLarge' })).toBe('quota')
    expect(classify(403, { code: 'AccessDenied' })).toBe('permission')
    expect(classify(500, {})).toBe('network')
    expect(
      parseListPage(
        '<ListBucketResult><Contents><Key>a&amp;b</Key><Size>3</Size></Contents><IsTruncated>false</IsTruncated></ListBucketResult>',
      ),
    ).toEqual({
      keys: [{ key: 'a&b', size: 3 }],
      truncated: false,
    })
  })

  test('the CORS rule names the origin and the methods the app uses', () => {
    const rule = corsRule('https://maxgfr.github.io')
    expect(JSON.parse(rule.json)).toEqual([
      {
        AllowedOrigins: ['https://maxgfr.github.io'],
        AllowedMethods: ['GET', 'PUT', 'DELETE', 'HEAD'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['ETag', 'Date'],
        MaxAgeSeconds: 3600,
      },
    ])
    expect(rule.xml).toContain('<AllowedOrigin>https://maxgfr.github.io</AllowedOrigin>')
  })

  test('two devices sync through a bucket', async () => {
    const server = fakeS3({ pageSize: 3 })
    const bucket = new MemoryBucket()
    const a = await device(bucket, { remote: () => store(server) })
    const b = await device(bucket, { remote: () => store(server) })
    const conv = a.ws.conversations.create({ title: 'via S3' })
    await a.sync()
    await b.sync()
    expect(b.ws.conversations.get(conv)?.title).toBe('via S3')
  })
})
