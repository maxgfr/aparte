import { describe, expect, test } from 'bun:test'
import { isWall, pageText, pageTitle, READ_MAX_BYTES, readPage, UNREACHABLE_NOTE } from './read.ts'
import { backendRoutes, fakeWeb, loadFixtures } from './testkit.ts'

const fixtures = await loadFixtures()

const ARTICLE = `<!doctype html><html><head><title>Fallback title</title>
<meta property="og:title" content="Token buckets &amp; you"></head><body>
<nav>Home About Pricing Login Signup Products Careers</nav>
<main><h1>Token buckets</h1><p>${'A token bucket refills at a fixed rate and holds at most b tokens. '.repeat(8)}</p></main>
<footer>Copyright footer links everywhere</footer><script>steal()</script></body></html>`

function web(extra: Record<string, { body: string; type?: string; status?: number; refuse?: boolean }> = {}) {
  const page = fakeWeb(extra)
  const api = fakeWeb(backendRoutes(fixtures))
  return { page, api, options: { page: page.http, api: api.http, chars: 2000 } }
}

describe('readPage', () => {
  test('an HTML page: its main region as text, its og:title, nothing of scripts or navigation', async () => {
    const w = web({ 'https://blog.example/': { body: ARTICLE, type: 'text/html; charset=utf-8' } })
    const read = await readPage('https://blog.example/tokens#part', w.options)
    expect(read.status).toBe('ok')
    expect(read.title).toBe('Token buckets & you')
    expect(read.text).toStartWith('Token buckets')
    expect(read.text).not.toContain('Pricing')
    expect(read.text).not.toContain('steal')
    // The fragment is not sent, and the request carries no header of its own.
    expect(w.page.requests[0]?.url).toBe('https://blog.example/tokens')
    expect(w.page.requests[0]?.init?.headers).toBeUndefined()
  })

  test('text is cut to the depth, and says so', async () => {
    const w = web({ 'https://t.example/': { body: 'x'.repeat(5000), type: 'text/plain' } })
    const read = await readPage('https://t.example/a.txt', { ...w.options, chars: 100 })
    expect(read.text).toStartWith('x'.repeat(100))
    expect(read.text).toContain('[The text was cut here')
  })

  test('Wikipedia and Hacker News are read through their APIs, keeping the page as the source', async () => {
    const w = web()
    const wiki = await readPage('https://en.m.wikipedia.org/wiki/Rate_limiting', w.options)
    expect(wiki).toMatchObject({ status: 'ok', title: 'Rate limiting' })
    expect(wiki.text).toContain('429: Too Many Requests')
    const url = new URL(w.api.requests[0]?.url ?? '')
    expect(url.origin).toBe('https://en.wikipedia.org')
    expect(url.searchParams.get('origin')).toBe('*')
    expect(url.searchParams.get('titles')).toBe('Rate_limiting')
    const hn = await readPage('https://news.ycombinator.com/item?id=8863', w.options)
    expect(hn.status).toBe('ok')
    expect(w.api.requests.at(-1)?.url).toBe('https://hn.algolia.com/api/v1/items/8863')
    expect(w.page.requests).toEqual([])
  })

  test('refusals: not https, credentials, private hosts; nothing is requested', async () => {
    const w = web()
    for (const u of ['ftp://x.org/', 'https://a:b@x.org/', 'https://localhost/', 'https://192.168.1.2/', 'nope'])
      expect((await readPage(u, w.options)).status).toBe('failed')
    expect(w.page.requests).toEqual([])
    // Plain http is read over https.
    const h = web({ 'https://plain.example/': { body: 'hello there', type: 'text/plain' } })
    expect((await readPage('http://plain.example/', h.options)).text).toBe('hello there')
  })

  test('failures in words: CORS refusal, HTTP errors, PDFs and binaries', async () => {
    const w = web({
      'https://nocors.example/': { body: '', refuse: true },
      'https://gone.example/': { body: '', status: 404 },
      'https://pdf.example/': { body: '%PDF-1.7', type: 'application/pdf' },
      'https://img.example/': { body: 'GIF89a', type: 'image/gif' },
    })
    expect(await readPage('https://nocors.example/x', w.options)).toMatchObject({
      status: 'failed',
      note: UNREACHABLE_NOTE,
    })
    expect((await readPage('https://gone.example/x', w.options)).note).toBe('the site answered HTTP 404')
    expect((await readPage('https://pdf.example/x', w.options)).note).toContain('PDF')
    expect((await readPage('https://img.example/x', w.options)).note).toContain('image/gif')
  })

  test('a wall is reported as such, with no text', async () => {
    const w = web({ 'https://www.mojeek.com/': { body: fixtures['mojeek-captcha.html'], type: 'text/html' } })
    expect(await readPage('https://www.mojeek.com/search?q=x', w.options)).toMatchObject({ status: 'wall', text: '' })
    expect(isWall('Please enable JavaScript to view this site.')).toBe(true)
    expect(isWall('We value your privacy. Accept all cookies?')).toBe(true)
    expect(isWall(`${'Real content about cookies and captcha research. '.repeat(40)}`)).toBe(false)
    expect(isWall('', 'Just a moment...')).toBe(true)
  })

  test('an abort rejects; a huge page is read up to the cap', async () => {
    const controller = new AbortController()
    controller.abort()
    const w = web({ 'https://big.example/': { body: 'y'.repeat(READ_MAX_BYTES + 5000), type: 'text/plain' } })
    expect(readPage('https://big.example/', { ...w.options, signal: controller.signal })).rejects.toThrow()
    const big = await readPage('https://big.example/', { ...w.options, chars: READ_MAX_BYTES * 2 })
    expect(big.text.length).toBe(READ_MAX_BYTES)
  })

  test('pageText falls back to the whole page without a clear main region; pageTitle decodes entities', () => {
    expect(pageText('<body><p>Short</p><main>tiny</main></body>')).toBe('Short\ntiny')
    expect(pageTitle('<title> A &lt;b&gt; title </title>')).toBe('A <b> title')
  })
})
