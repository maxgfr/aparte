import { describe, expect, test } from 'bun:test'
import { contentSecurityPolicy } from '../src/security/policy.ts'
import {
  checkIndexHtml,
  codeRanges,
  decodeSegment,
  isComputedKey,
  isScannedSource,
  packageOf,
  position,
  rangeAt,
  scanBundle,
  scanSource,
  setsJitless,
  sourceAt,
  stripComments,
} from './scan.ts'

const rules = (file: string, code: string) => scanSource(file, code).map((f) => f.rule)

/** Fixtures are JavaScript source as text; `#{` stands for a template expression opener in them. */
const js = (text: string) => text.replaceAll('#{', `${'$'}{`)

describe('stripComments', () => {
  test('blanks comments and keeps offsets, strings, templates and regexes', () => {
    const code = [
      "const a = 'no // comment here' // el.innerHTML",
      '/* innerHTML',
      js('   spans lines */ const b = `x #{"//"} y` + /\\/\\/[/*]/.source'),
      'const c = d / e // after a division',
    ].join('\n')
    const out = stripComments(code)
    expect(out).toHaveLength(code.length)
    expect(out.split('\n')).toHaveLength(4)
    expect(out).not.toContain('innerHTML')
    expect(out).not.toContain('after a division')
    expect(out).toContain("'no // comment here'")
    expect(out).toContain(js('`x #{"//"} y`'))
    expect(out).toContain('/\\/\\/[/*]/.source')
    expect(out).toContain('const c = d / e')
  })

  test('follows nested template expressions', () => {
    const code = js('const s = `a #{f({ k: `b #{"c"}` })} d` // gone\nx.innerHTML = s')
    const out = stripComments(code)
    expect(out).not.toContain('gone')
    expect(out).toContain('x.innerHTML = s')
  })

  test('does not take a JSX closing tag for a regex', () => {
    const out = stripComments('const v = <p>{x}</p> // gone\nconst w = 1')
    expect(out).not.toContain('gone')
    expect(out).toContain('</p>')
  })
})

describe('codeRanges', () => {
  test('lists comments, strings, template segments and regexes in order', () => {
    const code = js("a='x';/*c*/b=`t#{d}u`;e=/r/g;// end")
    expect(codeRanges(code).map((r) => [r.kind, code.slice(r.from, r.to)])).toEqual([
      ['string', "'x'"],
      ['comment', '/*c*/'],
      ['template', js('t#{')],
      ['template', 'u`'],
      ['regex', '/r/'],
      ['comment', '// end'],
    ])
    const ranges = codeRanges(code)
    expect(rangeAt(ranges, code.indexOf('x'))?.kind).toBe('string')
    expect(rangeAt(ranges, code.indexOf('b'))).toBeUndefined()
    expect(rangeAt(ranges, code.indexOf('d'))).toBeUndefined()
  })

  test('tells a computed member key from a listed keyword', () => {
    const check = (code: string) => {
      const range = rangeAt(codeRanges(code), code.indexOf('eval'))
      if (range === undefined) throw new Error(`no literal around eval in ${code}`)
      return isComputedKey(code, range, 'eval')
    }
    for (const code of ['g["eval"]', "g[ 'eval' ]", 'g[`eval`]']) expect(check(code)).toBe(true)
    for (const code of ['["eval",1]', 'g["evaluate"]', 'x="eval"', 'g[`a eval`]', 'g[`#{x}eval`]'].map(js))
      expect(check(code)).toBe(false)
  })
})

describe('position', () => {
  test('is 1-based', () => {
    expect(position('ab\ncd', 0)).toEqual({ line: 1, column: 1 })
    expect(position('ab\ncd', 4)).toEqual({ line: 2, column: 2 })
  })
})

describe('scanSource', () => {
  test.each([
    ['inner-html', 'el.innerHTML = x'],
    ['inner-html', "el['innerHTML'] = x"],
    ['outer-html', 'el.outerHTML = x'],
    ['insert-adjacent-html', "el.insertAdjacentHTML('beforeend', x)"],
    ['document-write', 'document.write(x)'],
    ['document-write', 'document . writeln(x)'],
    ['document-write', "document['write'](x)"],
    ['eval', 'eval(x)'],
    ['eval', 'globalThis.eval(x)'],
    ['eval', 'const run = (0, eval)'],
    ['function-constructor', "new Function('return 1')"],
    ['function-constructor', "Function('return this')()"],
    ['string-timer', "setTimeout('alert(1)', 10)"],
    ['string-timer', 'setInterval(`tick()`, 10)'],
    ['dangerously-set-inner-html', 'return <div dangerouslySetInnerHTML={{ __html: x }} />'],
    ['new-worker', "new Worker('/w.js')"],
    ['new-worker', 'new SharedWorker(url)'],
    ['fetch', "fetch('/x')"],
    ['fetch', 'await globalThis.fetch(url)'],
    ['fetch', 'window.fetch (url)'],
    ['network-api', 'new XMLHttpRequest()'],
    ['network-api', "new WebSocket('wss://x')"],
    ['network-api', 'new EventSource(u)'],
    ['network-api', 'navigator.sendBeacon(u, b)'],
    ['service-worker-register', "navigator.serviceWorker.register('/sw.js')"],
    ['web-storage', "localStorage.setItem('k', v)"],
    ['web-storage', 'const s = window.sessionStorage'],
    ['trusted-types-policy', "trustedTypes.createPolicy('default', p)"],
  ])('flags %s in %s', (rule, code) => {
    expect(rules('src/app/x.tsx', code)).toEqual([rule])
  })

  test.each([
    ["const csp = \"script-src 'self' 'wasm-unsafe-eval'\""],
    ['// el.innerHTML is never used here'],
    ['/* new Function() */ const x = 1'],
    ['setTimeout(() => tick(), 10)'],
    ['setInterval(tick, 10)'],
    ['const evaluate = (x: number) => x'],
    ['obj.evaluation = 1'],
    ['type F = Function'],
    ['const f: Function = g'],
    ['x instanceof Function'],
    ['const prefetch = (u: string) => u'],
    ['prefetch(u)'],
    ['const textContent = "innerHTMLish"'],
    ['el.textContent = x'],
    ['await request(url, { purpose: "app" })'],
    ['createWorker(url)'],
  ])('passes %s', (code) => {
    expect(rules('src/app/x.ts', code)).toEqual([])
  })

  test('allows each construct only in its audited module', () => {
    expect(rules('src/security/net.ts', 'globalThis.fetch(u)')).toEqual([])
    expect(rules('src/sw.ts', 'event.respondWith(fetch(event.request))')).toEqual([])
    expect(rules('src/security/workers.ts', 'new Worker(u, o)')).toEqual([])
    expect(rules('src/pwa/register.ts', 'navigator.serviceWorker.register(u)')).toEqual([])
    expect(rules('src/app/prefs.ts', 'localStorage.getItem(k)')).toEqual([])
    expect(rules('src/security/tt.ts', "tt.createPolicy('aparte', r)")).toEqual([])
    expect(rules('src/ui/render/Sanitized.tsx', '<div dangerouslySetInnerHTML={h} />')).toEqual([])
    // An allowance is per construct: the sanitiser may not fetch, net.ts may not touch innerHTML.
    expect(rules('src/ui/render/Sanitized.tsx', 'fetch(u)')).toEqual(['fetch'])
    expect(rules('src/security/net.ts', 'el.innerHTML = x')).toEqual(['inner-html'])
    // A look-alike path is not the audited module.
    expect(rules('src/security/net.ts.bak.ts', 'fetch(u)')).toEqual(['fetch'])
    expect(rules('src/other/src/security/net.ts', 'fetch(u)')).toEqual(['fetch'])
  })

  test('reports file, line and column', () => {
    const [f] = scanSource('src/a.ts', 'const a = 1\n  // fetch(x)\n  x.innerHTML = y')
    expect(f).toMatchObject({ file: 'src/a.ts', line: 3, column: 5, rule: 'inner-html' })
  })
})

describe('isScannedSource', () => {
  test('covers code and skips tests and declarations', () => {
    expect(isScannedSource('src/a.ts')).toBe(true)
    expect(isScannedSource('src/a.tsx')).toBe(true)
    expect(isScannedSource('src/a.test.ts')).toBe(false)
    expect(isScannedSource('src/a.test.tsx')).toBe(false)
    expect(isScannedSource('src/a.d.ts')).toBe(false)
    expect(isScannedSource('src/a.css')).toBe(false)
  })
})

// Zod 4.6 as Vite 8 minifies it (see node_modules/zod/v4/core/util.js and doc.js).
const zodProbe =
  'var v=i(()=>{if($.jitless||typeof navigator<`u`&&navigator?.userAgent?.includes(`Cloudflare`))return!1;try{return Function(``),!0}catch{return!1}});'
const zodCompile = js(
  'compile(){let e=Function,t=this?.content??[``];return new e(...Object.keys(this.closed),`return function (#{this.args.join(`, `)}) {\n#{t.join(`\n`)}\n};`);return e(...Object.values(this.closed))}',
)

describe('scanBundle', () => {
  test('recognises the two Zod sites precisely', () => {
    const hits = scanBundle('dist/assets/core.js', `${zodProbe}${zodCompile}`)
    expect(hits.map((h) => [h.rule, h.known?.id, h.library])).toEqual([
      ['function-constructor', 'zod-allows-eval-probe', 'zod'],
      ['function-constructor', 'zod-doc-compile', 'zod'],
    ])
  })

  test('does not accept a probe without the jitless guard', () => {
    const unguarded = zodProbe.replace('$.jitless||', '')
    const [hit] = scanBundle('dist/a.js', unguarded)
    expect(hit?.known).toBeUndefined()
    expect(hit?.library).toBe('unknown (no source map)')
  })

  test('flags other evaluation and ignores member access and instanceof', () => {
    const code =
      'a=new Function("x","return x");b=eval(c);d=(0,eval)(e);f=Function.prototype.call;g=h instanceof Function'
    expect(scanBundle('dist/a.js', code).map((h) => h.rule)).toEqual(['eval', 'eval', 'function-constructor'])
    expect(scanBundle('dist/a.js', "x='wasm-unsafe-eval'")).toEqual([])
  })

  test('ignores names inside comments and literals: highlight.js keywords, Zod messages', () => {
    const highlight = js(
      'const _=[`break`,`cd`,`eval`,`exec`],n=`abs.accept.eof.eval.exec`,k={keyword:`call eval file`},q="eval",r=\'Function\',re=/eval|Function/g;',
    )
    expect(scanBundle('dist/highlight.js', highlight)).toEqual([])
    const zodJsonSchema = 'Ya=(e,t,n,r)=>{U(e,t,n,r,`Function types cannot be represented in JSON Schema`)}'
    expect(scanBundle('dist/schemas.js', zodJsonSchema)).toEqual([])
    expect(scanBundle('dist/a.js', '/* eval(x) */a=1;// new Function("")\nb=2')).toEqual([])
    // Template expressions are code again, and so is what follows a literal.
    expect(scanBundle('dist/a.js', js('a=`x #{eval(b)} y`;c=`eval`+eval(d)')).map((h) => h.column)).toEqual([8, 29])
  })

  test('still flags a literal used as a computed member key', () => {
    const code = js('a=globalThis["eval"](b);c=self[ `Function` ](d);e=window[\'eval\'];f=g["eval",h]')
    expect(scanBundle('dist/a.js', code).map((h) => h.rule)).toEqual(['eval', 'eval', 'function-constructor'])
  })

  test('recognises the lib0 constructor identity checks precisely', () => {
    const lib0 =
      'check(e,t){let n=e.constructor===Function&&e.length<=this.len;return n}lr=e=>{e.length===1&&e[0]?.constructor===Function&&(e=e[0]())}'
    expect(scanBundle('dist/workspace.js', lib0).map((h) => [h.known?.id, h.library])).toEqual([
      ['lib0-constructor-identity', 'lib0'],
      ['lib0-constructor-identity', 'lib0'],
    ])
    // A call, a different comparison or a bare reference is not the known site.
    for (const code of ['x=e.constructor===Function("return 1")', 'x=e.constructor==Function&&1', 'x=Function&&e']) {
      expect(scanBundle('dist/a.js', code)[0]?.known).toBeUndefined()
    }
    // Nor is the same text that a source map places in another package.
    const other = { sources: ['../node_modules/evil/index.js'], mappings: 'AAAA' }
    expect(scanBundle('dist/a.js', 'x=e.constructor===Function&&1', other)[0]?.known).toBeUndefined()
  })

  test('attributes hits through a source map', () => {
    // One generated line: column 0 maps to source 0, column 10 to source 1.
    const map = { sources: ['../src/app.ts', '../node_modules/@scope/pkg/index.js'], mappings: 'AAAA,UCAA' }
    const [hit] = scanBundle('dist/a.js', 'const a=1;new Function("")', map)
    expect(hit?.library).toBe('@scope/pkg')
    // A known Zod site that the map places in another package is not accepted.
    const wrong = { sources: ['../node_modules/evil/index.js'], mappings: 'AAAA' }
    expect(scanBundle('dist/a.js', zodProbe, wrong)[0]?.known).toBeUndefined()
  })
})

describe('source maps', () => {
  test('decodes base64 VLQ segments', () => {
    expect(decodeSegment('AAAA')).toEqual([0, 0, 0, 0])
    expect(decodeSegment('UCAA')).toEqual([10, 1, 0, 0])
    expect(decodeSegment('D')).toEqual([-1])
    expect(decodeSegment('gB')).toEqual([16])
  })

  test('finds the source of a generated position across lines', () => {
    const map = { sources: ['a.js', 'b.js', 'c.js'], mappings: 'AAAA,ECAA;AACA,ICAA' }
    expect(sourceAt(map, 0, 0)).toBe('a.js')
    expect(sourceAt(map, 0, 3)).toBe('b.js')
    expect(sourceAt(map, 1, 1)).toBe('b.js')
    expect(sourceAt(map, 1, 4)).toBe('c.js')
    expect(sourceAt(map, 5, 0)).toBeUndefined()
  })

  test('names packages', () => {
    expect(packageOf('../../node_modules/zod/v4/core/util.js')).toBe('zod')
    expect(packageOf('../node_modules/.bun/zod@4.6.7/node_modules/zod/v4/core/util.js')).toBe('zod')
    expect(packageOf('../node_modules/@vitejs/plugin-react/x.js')).toBe('@vitejs/plugin-react')
    expect(packageOf('../../src/main.tsx')).toBe('app (src/main.tsx)')
  })

  test('detects the jitless switch', () => {
    expect(setsJitless(['e({jitless:!0})'])).toBe(true)
    expect(setsJitless(['config({ jitless: true })'])).toBe(true)
    expect(setsJitless(['if(x.jitless)return'])).toBe(false)
  })
})

describe('checkIndexHtml', () => {
  const origin = 'https://maxgfr.github.io'
  const base = '/aparte/'
  const meta = (policy: string) =>
    `<meta http-equiv="Content-Security-Policy" content="${policy.replaceAll('"', '&quot;')}" />`
  const page = (head: string, body = '') =>
    `<!doctype html>\n<html><head>\n<meta charset="UTF-8" />\n${head}\n</head><body>${body}</body></html>`
  const good = page(
    `${meta(contentSecurityPolicy({ origin, base }))}\n<script type="module" crossorigin src="/aparte/assets/index-a1.js"></script>\n<link rel="modulepreload" href="/aparte/assets/core-b2.js">\n<link rel="manifest" href="/aparte/manifest.webmanifest">\n<link rel="canonical" href="https://maxgfr.github.io/aparte/">`,
  )
  const ruleIds = (html: string, expected = {}) => checkIndexHtml(html, 'dist/index.html', expected).map((f) => f.rule)

  test('passes the production page', () => {
    expect(checkIndexHtml(good)).toEqual([])
    expect(checkIndexHtml(good, 'dist/index.html', { origin, base })).toEqual([])
  })

  test('accepts a production policy built for another origin (the e2e preview)', () => {
    const local = good.replace(
      meta(contentSecurityPolicy({ origin, base })),
      meta(contentSecurityPolicy({ origin: 'http://localhost:4173', base })),
    )
    expect(ruleIds(local.replace('https://maxgfr.github.io/aparte/"', '/aparte/"'))).toEqual([])
    expect(ruleIds(local, { origin })).toContain('csp-meta')
  })

  test('refuses the dev policy, a missing policy, a placeholder and two policies', () => {
    const dev = good.replace(
      meta(contentSecurityPolicy({ origin, base })),
      meta(contentSecurityPolicy({ origin, base, dev: true })),
    )
    expect(ruleIds(dev)).toContain('csp-meta')
    expect(ruleIds(page('<script type="module" src="/aparte/assets/a.js"></script>'))).toContain('csp-meta')
    expect(ruleIds(page(meta('%APARTE_CSP%')))).toContain('csp-meta')
    const twice = good.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n${meta("default-src 'none'")}`)
    expect(ruleIds(twice)).toContain('csp-meta')
  })

  test('refuses a weakened production policy and names the directive', () => {
    const weak = contentSecurityPolicy({ origin, base }).replace(
      "'wasm-unsafe-eval'",
      "'wasm-unsafe-eval' 'unsafe-eval'",
    )
    const [f] = checkIndexHtml(good.replace(meta(contentSecurityPolicy({ origin, base })), meta(weak)))
    expect(f?.message).toContain('script-src')
  })

  test('requires the policy before what it governs', () => {
    const late = good
      .replace(`${meta(contentSecurityPolicy({ origin, base }))}\n`, '')
      .replace('</head>', `${meta(contentSecurityPolicy({ origin, base }))}\n</head>`)
    const [f] = checkIndexHtml(late)
    expect(f?.message).toContain('<script> comes before the CSP <meta>')
  })

  test('refuses inline code and styles', () => {
    expect(ruleIds(good.replace('</head>', '<script>alert(1)</script></head>'))).toEqual(['inline-script'])
    expect(ruleIds(good.replace('</head>', '<style>p{}</style></head>'))).toEqual(['inline-style'])
    expect(ruleIds(good.replace('<body>', '<body style="color:red">'))).toEqual(['inline-style'])
    expect(ruleIds(good.replace('<body>', '<body onload="go()">'))).toEqual(['inline-handler'])
  })

  test('refuses src and href that leave the origin', () => {
    expect(ruleIds(good.replace('</head>', '<script src="https://cdn.example/x.js"></script></head>'))).toEqual([
      'external-url',
    ])
    expect(ruleIds(good.replace('</head>', '<link rel="stylesheet" href="//fonts.example/css"></head>'))).toEqual([
      'external-url',
    ])
    expect(ruleIds(good.replace('</head>', "<link rel=icon href='http://maxgfr.github.io/x.png'></head>"))).toEqual([
      'external-url',
    ])
    expect(ruleIds(good.replace('<body>', '<body><img srcset="/a.png 1x, https://t.example/p.png 2x">'))).toEqual([
      'external-url',
    ])
    expect(ruleIds(good.replace('<body>', '<body><a href="javascript:go()">x</a>'))).toEqual(['external-url'])
    // Commented-out markup is not the page.
    expect(ruleIds(good.replace('<body>', '<body><!-- <script src="https://cdn.example/x.js"></script> -->'))).toEqual(
      [],
    )
  })
})
