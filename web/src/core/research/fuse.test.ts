import { describe, expect, test } from 'bun:test'
import type { SearchHit } from '../contracts/research.ts'
import { fuseHits, normalizeUrl } from './fuse.ts'

const hit = (url: string, backend: SearchHit['backend'], title = url): SearchHit => ({
  url,
  title,
  snippet: `about ${title}`,
  backend,
})

describe('normalizeUrl', () => {
  test('one identity for the spellings of one page', () => {
    const same = [
      'https://www.example.com/a/b/?utm_source=x&b=2&a=1#top',
      'http://example.com:80/a/b?a=1&b=2&fbclid=z',
      'https://EXAMPLE.com:443/a//b?b=2&a=1&gclid=q',
    ]
    for (const u of same) expect(normalizeUrl(u)).toBe('https://example.com/a/b?a=1&b=2')
    expect(normalizeUrl('https://example.com')).toBe('https://example.com/')
    expect(normalizeUrl('https://example.com:8443/x/')).toBe('https://example.com:8443/x')
  })

  test('arXiv, DOI and Wikipedia mobile forms collapse', () => {
    expect(normalizeUrl('https://arxiv.org/pdf/1706.03762v5.pdf')).toBe('https://arxiv.org/abs/1706.03762v5')
    expect(normalizeUrl('http://arxiv.org/abs/1706.03762v5/')).toBe('https://arxiv.org/abs/1706.03762v5')
    expect(normalizeUrl('https://dx.doi.org/10.1000/ABC')).toBe(normalizeUrl('https://doi.org/10.1000/abc'))
    expect(normalizeUrl('https://en.m.wikipedia.org/wiki/Rate_limiting')).toBe(
      'https://en.wikipedia.org/wiki/Rate_limiting',
    )
  })

  test('no identity for anything but an http(s) address without credentials', () => {
    for (const u of ['javascript:alert(1)', 'ftp://x.org/a', 'data:text/plain,hi', 'not a url', 'https://u:p@x.org/'])
      expect(normalizeUrl(u)).toBeNull()
  })
})

describe('fuseHits', () => {
  test('reciprocal-rank fusion: a page two backends found ranks first, once, with both backends', () => {
    const fused = fuseHits(
      [
        [hit('https://a.org/', 'wikipedia'), hit('https://b.org/x', 'wikipedia')],
        [hit('https://www.b.org/x/', 'marginalia', 'B again'), hit('https://c.org/', 'marginalia')],
      ],
      10,
    )
    // The URL and title of the best-ranked sighting are kept (rank 1 in the second list beats rank 2 in the first).
    expect(fused.map((f) => f.url)).toEqual(['https://www.b.org/x/', 'https://a.org/', 'https://c.org/'])
    expect(fused[0]?.from).toEqual(['wikipedia', 'marginalia'])
    expect(fused[0]?.title).toBe('B again')
    expect(fused[0]?.score).toBeCloseTo(1 / 62 + 1 / 61, 6)
  })

  test('deterministic ties, limits, duplicates within a list and hits without identity', () => {
    const lists = [[hit('https://z.org/', 'mojeek'), hit('https://z.org/#x', 'mojeek'), hit('ftp://no', 'mojeek')]]
    expect(fuseHits(lists, 5).map((f) => f.url)).toEqual(['https://z.org/'])
    const tie = fuseHits([[hit('https://b.org/', 'github')], [hit('https://a.org/', 'openalex')]], 5)
    expect(tie.map((f) => f.url)).toEqual(['https://a.org/', 'https://b.org/'])
    expect(fuseHits(lists, 0)).toEqual([])
  })
})
