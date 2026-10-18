/**
 * Static security gate (`bun run scan`). It fails on code that would break the app's security invariants:
 *
 * 1. In `src` (tests and declaration files aside): HTML injection sinks, JavaScript evaluation, string timers, and
 *    the browser APIs that must go through one audited module (network, workers, service worker registration,
 *    Web Storage, Trusted Types policies).
 * 2. In `dist`, once built: every place the shipped JavaScript could evaluate code, which the CSP blocks (an
 *    unexpected one is a feature broken in production, or a dependency to look at), leaving out text inside comments
 *    and literals but not a literal used as a computed member key; the production CSP `<meta>` in
 *    `index.html`, ahead of everything it governs; no inline script or style; no external URL in `src`/`href`.
 *
 * Comments are blanked before matching (so prose about `innerHTML` is fine) but strings are not, so
 * `el['innerHTML']` is still caught. The checks are text matches, not a type analysis: they catch the ordinary ways
 * of reaching a sink and make bypasses deliberate, visible code.
 */
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { contentSecurityPolicy, parsePolicy } from '../src/security/policy.ts'

export interface Finding {
  /** Path relative to `web/`. */
  file: string
  line: number
  column: number
  rule: string
  message: string
}

export interface SourceRule {
  id: string
  pattern: RegExp
  message: string
  /** Paths relative to `web/` where the construct is the audited implementation. */
  allow?: readonly string[]
}

/** Matched against `src` with comments blanked. Every pattern is global (`g`). */
export const SOURCE_RULES: readonly SourceRule[] = [
  { id: 'inner-html', pattern: /\binnerHTML\b/g, message: 'innerHTML parses HTML; build nodes with textContent' },
  { id: 'outer-html', pattern: /\bouterHTML\b/g, message: 'outerHTML parses HTML; build nodes with textContent' },
  {
    id: 'insert-adjacent-html',
    pattern: /\binsertAdjacentHTML\b/g,
    message: 'insertAdjacentHTML parses HTML; build nodes with textContent',
  },
  {
    id: 'document-write',
    pattern: /\bdocument\s*(?:\.\s*write(?:ln)?\b|\[\s*['"`]write(?:ln)?['"`]\s*\])/g,
    message: 'document.write parses HTML into the page',
  },
  // A '-' on either side is a CSP keyword such as 'wasm-unsafe-eval', not a call.
  {
    id: 'eval',
    pattern: /(?<![\w$-])eval\b(?![\w$-])/g,
    message: 'eval runs a string as code (and the CSP blocks it)',
  },
  {
    id: 'function-constructor',
    pattern: /(?<![\w$.])(?:new\s+)?Function\s*\(/g,
    message: 'the Function constructor runs a string as code (and the CSP blocks it)',
  },
  {
    id: 'string-timer',
    pattern: /\bset(?:Timeout|Interval|Immediate)\s*\(\s*['"`]/g,
    message: 'a timer given a string evaluates it; pass a function',
  },
  {
    id: 'dangerously-set-inner-html',
    pattern: /\bdangerouslySetInnerHTML\b/g,
    message: 'raw HTML goes only through the sanitised renderer (src/ui/render/Sanitized.tsx)',
    allow: ['src/ui/render/Sanitized.tsx'],
  },
  {
    id: 'new-worker',
    pattern: /\bnew\s+(?:Shared)?Worker\s*\(/g,
    message: 'workers start only through createWorker (src/security/workers.ts)',
    allow: ['src/security/workers.ts'],
  },
  {
    id: 'fetch',
    pattern: /(?<![\w$])fetch\s*\(/g,
    message: 'network requests go only through request() (src/security/net.ts)',
    allow: ['src/security/net.ts', 'src/sw.ts'],
  },
  {
    // A reference handed elsewhere (a library's `fetch` option) bypasses request() as surely as a call. `typeof` is a
    // type annotation, not a reference.
    id: 'fetch-reference',
    pattern: /(?<!typeof\s+)\b(?:globalThis|self|window)\s*(?:\.\s*fetch\b(?!\s*\()|\[\s*['"`]fetch['"`]\s*\])/g,
    message: 'the global fetch is used only by request() (src/security/net.ts); hand a library that wrapper instead',
    allow: ['src/security/net.ts', 'src/sw.ts'],
  },
  {
    // WebRTC is governed by no CSP directive: a peer connection (or the STUN host name it resolves) leaves the page.
    id: 'network-api',
    pattern:
      /\bnew\s+(?:(?:globalThis|self|window)\s*\.\s*)?(?:XMLHttpRequest|WebSocket|EventSource|WebTransport|(?:webkit)?RTCPeerConnection)\b|\b(?:sendBeacon|fetchLater)\s*\(/g,
    message: 'network access goes only through src/security/net.ts',
    allow: ['src/security/net.ts'],
  },
  {
    id: 'import-scripts',
    pattern: /\bimportScripts\s*\(/g,
    message: 'a classic worker loads code only from the pinned bytes the sandbox frames hand it',
    allow: ['src/sandbox/frame/js-worker.ts', 'src/sandbox/frame/py-worker.ts'],
  },
  {
    id: 'service-worker-register',
    pattern: /\bserviceWorker\s*\.\s*register\s*\(/g,
    message: 'the service worker is registered only by src/pwa/register.ts',
    allow: ['src/pwa/register.ts'],
  },
  {
    id: 'web-storage',
    pattern: /\b(?:localStorage|sessionStorage)\b/g,
    message: 'Web Storage is plaintext; only the UI preferences in src/app/prefs.ts may use it',
    allow: ['src/app/prefs.ts'],
  },
  {
    id: 'trusted-types-policy',
    pattern: /\bcreatePolicy\s*\(/g,
    message: 'Trusted Types policies are created only in src/security/tt.ts',
    allow: ['src/security/tt.ts'],
  },
]

/** Keywords after which a `/` starts a regular expression rather than a division. */
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
])

/** What a range of JavaScript text is, as far as the scans care: anything but code. */
export type RangeKind = 'comment' | 'string' | 'template' | 'regex'

/**
 * A comment or literal of a JavaScript text, `[from, to)`. A `string` range includes its quotes; a `template` range is
 * one text segment of a template literal, from just after its backtick or `}` to just after its closing backtick or
 * its `${`; a `regex` range includes its slashes (not its flags).
 */
export interface CodeRange {
  kind: RangeKind
  from: number
  to: number
}

/**
 * The comments and literals of a JavaScript text, in order. Strings, template literals (with nested `${}`) and
 * regular expression literals are told apart from code with the usual lexer heuristics (a `/` after an operator or a
 * keyword starts a regex), so a `//` inside a string is not taken for a comment and a quote inside a regex does not
 * open a string.
 */
export function codeRanges(code: string): CodeRange[] {
  const ranges: CodeRange[] = []
  const add = (kind: RangeKind, from: number, to: number) => {
    if (to > from) ranges.push({ kind, from, to: Math.min(to, code.length) })
  }
  /** Brace depth of each open `${` of a template literal; empty at top level. */
  const templates: number[] = []
  let depth = 0
  /** The last significant code character and identifier, to tell a regex from a division. */
  let prev = ''
  let prevWord = ''
  let i = 0

  const skipQuoted = (quote: string): void => {
    i++
    while (i < code.length && code[i] !== quote && code[i] !== '\n') i += code[i] === '\\' ? 2 : 1
    i++
  }
  /** Skips template text from `i` (just after a backtick or a closing `}`) to its end or its next `${`. */
  const skipTemplate = (): void => {
    const from = i
    while (i < code.length) {
      const c = code[i]
      if (c === '\\') i += 2
      else if (c === '`') {
        i++
        add('template', from, i)
        return
      } else if (c === '$' && code[i + 1] === '{') {
        i += 2
        add('template', from, i)
        templates.push(depth)
        depth++
        return
      } else i++
    }
    add('template', from, i)
  }

  while (i < code.length) {
    const c = code[i] as string
    const next = code[i + 1]
    if (c === '/' && next === '/') {
      const end = code.indexOf('\n', i)
      const stop = end === -1 ? code.length : end
      add('comment', i, stop)
      i = stop
    } else if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2)
      const stop = end === -1 ? code.length : end + 2
      add('comment', i, stop)
      i = stop
    } else if (c === "'" || c === '"') {
      const from = i
      skipQuoted(c)
      add('string', from, i)
      prev = c
      prevWord = ''
    } else if (c === '`') {
      i++
      skipTemplate()
      prev = '`'
      prevWord = ''
    } else if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%>~^'.includes(prev) || REGEX_AFTER_WORD.has(prevWord))) {
      // A regular expression literal: skip to its closing slash, honouring escapes and character classes. A '/'
      // after '<' is not one: it closes a JSX element.
      const from = i
      i++
      let inClass = false
      while (i < code.length && code[i] !== '\n') {
        const r = code[i]
        if (r === '\\') i++
        else if (r === '[') inClass = true
        else if (r === ']') inClass = false
        else if (r === '/' && !inClass) break
        i++
      }
      i++
      add('regex', from, i)
      prev = '/'
      prevWord = ''
    } else {
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (templates.length > 0 && templates[templates.length - 1] === depth) {
          templates.pop()
          i++
          skipTemplate()
          prev = '`'
          prevWord = ''
          continue
        }
      }
      if (/[\w$]/.test(c)) {
        let j = i
        while (j < code.length && /[\w$]/.test(code[j] as string)) j++
        prevWord = code.slice(i, j)
        prev = 'a'
        i = j
        continue
      }
      if (!/\s/.test(c)) {
        prev = c
        prevWord = ''
      }
      i++
    }
  }
  return ranges
}

/**
 * Blanks `//` and `/* *\/` comments with spaces, keeping every newline and every other character in place, so
 * offsets and line numbers still point into the original file. Strings, template literals and regular expression
 * literals are kept intact (so `el['innerHTML']` is still caught), and a `//` inside one is not taken for a comment.
 */
export function stripComments(code: string): string {
  const out = code.split('')
  for (const range of codeRanges(code)) {
    if (range.kind !== 'comment') continue
    for (let k = range.from; k < range.to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '
  }
  return out.join('')
}

/** 1-based line and column of an offset. */
export function position(code: string, offset: number): { line: number; column: number } {
  let line = 1
  let start = 0
  for (let k = code.indexOf('\n'); k !== -1 && k < offset; k = code.indexOf('\n', k + 1)) {
    line++
    start = k + 1
  }
  return { line, column: offset - start + 1 }
}

/** Findings of the source rules in one file (`file` relative to `web/`, with forward slashes). */
export function scanSource(file: string, code: string, rules: readonly SourceRule[] = SOURCE_RULES): Finding[] {
  const stripped = stripComments(code)
  const findings: Finding[] = []
  for (const rule of rules) {
    if (rule.allow?.includes(file)) continue
    for (const m of stripped.matchAll(rule.pattern)) {
      findings.push({ file, ...position(code, m.index), rule: rule.id, message: rule.message })
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column)
}

/** Source files the gate covers: code under `src`, not tests and not declaration files. */
export function isScannedSource(file: string): boolean {
  return /\.(?:ts|tsx|js|jsx|mjs|mts)$/.test(file) && !/\.test\.[jt]sx?$/.test(file) && !file.endsWith('.d.ts')
}

// ---------------------------------------------------------------------------------------------------------------
// Built JavaScript
// ---------------------------------------------------------------------------------------------------------------

/**
 * A code-evaluation site the build is known to contain and that never runs. Each is matched on the minified text
 * around the hit, as precisely as the minifier allows: a new or reshaped site fails the scan until someone looks.
 */
export interface KnownSite {
  id: string
  /** The package (as named in node_modules) the site belongs to. */
  library: string
  /** Why it never runs under the app's configuration. */
  reason: string
  /** Matched against the text that ends just before the hit. */
  before: RegExp
  /** Matched against the text that starts at the hit. */
  at: RegExp
  /** Accepted only if the bundle switches Zod to jitless mode (`config({ jitless: true })`). */
  needsJitless: boolean
}

export const KNOWN_SITES: readonly KnownSite[] = [
  {
    id: 'zod-allows-eval-probe',
    library: 'zod',
    reason: 'v4/core/util.js allowsEval: returns false before probing `new Function` when globalConfig.jitless is set',
    before:
      /\.jitless\|\|typeof navigator<[^;{}]{0,40}&&navigator\?\.userAgent\?\.includes\([^)]{0,20}\)\)return\s*!1;try\{return\s*(?:new\s+)?$/,
    at: /^Function\((?:``|""|'')\),!0\}catch(?:\([\w$]*\))?\{return\s*!1\}/,
    needsJitless: true,
  },
  {
    id: 'zod-doc-compile',
    library: 'zod',
    reason:
      'v4/core/doc.js Doc.compile: the object fast path, built only when JIT is on (jit = !globalConfig.jitless) and allowsEval holds',
    before: /compile\(\)\{(?:let|const|var)\s+[\w$]+=$/,
    at: /^Function,[\w$]+=this\?\.content\?\?\[(?:``|""|'')\];return new [\w$]+\(\.\.\.Object\.keys\(this\.closed\),`return function \(/,
    needsJitless: true,
  },
  {
    id: 'llm-models-zod-doc-compile',
    library: 'llm-models',
    reason:
      "the copy of zod 4.4 bundled into llm-models' browser build: Doc.compile, built only when JIT is on; that copy reads the same globalThis.__zod_globalConfig as the app's zod, which src/security/init.ts sets to jitless",
    before: /compile\(\)\{(?:let|const|var)\s+[\w$]+=$/,
    at: /^Function,[\w$]+=this\?\.args,[\w$]+=\[\.\.\.\(this\?\.content\?\?\[(?:``|""|'')\]\)\.map\(/,
    needsJitless: true,
  },
  {
    id: 'lib0-constructor-identity',
    library: 'lib0',
    reason:
      "logging.common.js (computeNoColorLoggingArgs, createModuleLogger) and schema.js ($Lambda.check) compare a value's constructor with Function (`x.constructor === Function`): an identity check, nothing is called or built",
    before: /(?:[\w$]|\])\??\.constructor===$/,
    at: /^Function&&/,
    needsJitless: false,
  },
]

export interface BundleHit extends Finding {
  /** What the hit belongs to: a package from the source map, a known site's package, or `unknown`. */
  library: string
  /** The known site it matches, when it does. */
  known?: KnownSite
  /** The minified text around the hit, for the report. */
  context: string
}

/** Code-evaluation constructs in minified output. `Function.x` member access and `instanceof Function` are not. */
const BUNDLE_PATTERNS: ReadonlyArray<{
  rule: string
  pattern: RegExp
  skip?: (code: string, index: number) => boolean
}> = [
  { rule: 'eval', pattern: /(?<![\w$-])eval\b(?![\w$-])/g },
  {
    rule: 'function-constructor',
    pattern: /(?<![\w$.])Function\b(?![\w$])/g,
    skip: (code, index) =>
      /^Function\s*\./.test(code.slice(index, index + 12)) || /instanceof\s*$/.test(code.slice(index - 12, index)),
  },
]

/** Whether some built chunk switches Zod to jitless mode, as `src/security/init.ts` does. */
export function setsJitless(chunks: Iterable<string>): boolean {
  for (const code of chunks) if (/\bjitless\s*:\s*(?:!0|true)\b/.test(code)) return true
  return false
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Decodes one source map segment (base64 VLQ) into its relative fields. */
export function decodeSegment(segment: string): number[] {
  const values: number[] = []
  let value = 0
  let shift = 0
  for (const ch of segment) {
    const digit = B64.indexOf(ch)
    if (digit === -1) throw new Error(`Invalid source map segment: ${segment}`)
    value += (digit & 31) << shift
    if (digit & 32) shift += 5
    else {
      values.push(value & 1 ? -(value >>> 1) : value >>> 1)
      value = 0
      shift = 0
    }
  }
  return values
}

/** The source file a generated position (0-based line and column) maps to, if the map covers it. */
export function sourceAt(
  map: { sources: string[]; mappings: string },
  line: number,
  column: number,
): string | undefined {
  const lines = map.mappings.split(';')
  let source = 0
  for (let l = 0; l <= line && l < lines.length; l++) {
    let col = 0
    let found: number | undefined
    for (const segment of (lines[l] as string).split(',')) {
      if (!segment) continue
      const fields = decodeSegment(segment)
      col += fields[0] ?? 0
      if (fields.length > 1) source += fields[1] ?? 0
      if (l === line && col <= column && fields.length > 1) found = source
    }
    if (l === line) return found === undefined ? undefined : map.sources[found]
  }
  return undefined
}

/** `zod` for `../node_modules/zod/v4/core/util.js`, `@scope/pkg` for scoped packages, else the app path. */
export function packageOf(source: string): string {
  const m = /.*node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(source)
  return m?.[1] ?? `app (${source.replace(/^(?:\.\.\/)+/, '')})`
}

/** The comment or literal that contains `index`, if any; `ranges` are in order and do not overlap. */
export function rangeAt(ranges: readonly CodeRange[], index: number): CodeRange | undefined {
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = ranges[mid] as CodeRange
    if (index < r.from) hi = mid - 1
    else if (index >= r.to) lo = mid + 1
    else return r
  }
  return undefined
}

/**
 * Whether a match inside a string or template literal still reaches the real function: a literal that is exactly
 * the name, alone between brackets, is a computed member access (`globalThis['eval']`, ``self[`Function`]``).
 */
export function isComputedKey(code: string, range: CodeRange, name: string): boolean {
  let open: number
  let text: string
  if (range.kind === 'string') {
    open = range.from
    text = code.slice(range.from + 1, range.to - 1)
  } else if (range.kind === 'template' && code[range.from - 1] === '`' && code[range.to - 1] === '`') {
    open = range.from - 1
    text = code.slice(range.from, range.to - 1)
  } else {
    return false
  }
  if (text !== name) return false
  return /\[\s*$/.test(code.slice(Math.max(0, open - 16), open)) && /^\s*\]/.test(code.slice(range.to, range.to + 16))
}

/**
 * Evaluation sites in one built chunk, each attributed and matched against the known sites. A match inside a
 * comment, a regular expression or a string or template literal is text, not code (highlight.js grammars list
 * `eval` among a language's keywords; Zod's JSON Schema errors name "Function types"), unless the literal is the
 * name used as a computed member key.
 */
export function scanBundle(
  file: string,
  code: string,
  map?: { sources: string[]; mappings: string },
  known: readonly KnownSite[] = KNOWN_SITES,
): BundleHit[] {
  const hits: BundleHit[] = []
  const ranges = codeRanges(code)
  for (const { rule, pattern, skip } of BUNDLE_PATTERNS) {
    for (const m of code.matchAll(pattern)) {
      if (skip?.(code, m.index)) continue
      const literal = rangeAt(ranges, m.index)
      if (literal !== undefined && !isComputedKey(code, literal, m[0])) continue
      const before = code.slice(Math.max(0, m.index - 240), m.index)
      const at = code.slice(m.index, m.index + 240)
      const site = known.find((k) => k.before.test(before) && k.at.test(at))
      const pos = position(code, m.index)
      const source = map ? sourceAt(map, pos.line - 1, pos.column - 1) : undefined
      const library = source ? packageOf(source) : (site?.library ?? 'unknown (no source map)')
      // With a source map, a known site must also come from the package it is known for.
      const matched = site && (!source || library === site.library) ? site : undefined
      hits.push({
        file,
        ...pos,
        rule,
        library,
        known: matched,
        context: code.slice(Math.max(0, m.index - 60), m.index + 60).replaceAll('\n', ' '),
        message: matched
          ? `${matched.library}: ${matched.reason}`
          : `${library}: code evaluation, blocked by the CSP (script-src has no 'unsafe-eval')`,
      })
    }
  }
  return hits
}

// ---------------------------------------------------------------------------------------------------------------
// dist/index.html
// ---------------------------------------------------------------------------------------------------------------

interface Tag {
  name: string
  attrs: Map<string, string>
  index: number
  /** For `<script>` and `<style>`: the text up to the closing tag. */
  body: string
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', '#39': "'", '#34': '"' }

function decodeEntities(value: string): string {
  return value.replace(/&(amp|quot|apos|lt|gt|#39|#34);/g, (_, e: string) => ENTITIES[e] ?? _)
}

/** The start tags of an HTML document (comments skipped), with decoded attribute values. */
export function parseTags(html: string): Tag[] {
  const tags: Tag[] = []
  const source = html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '))
  for (const m of source.matchAll(
    /<([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/g,
  )) {
    const name = (m[1] as string).toLowerCase()
    const attrs = new Map<string, string>()
    for (const a of (m[2] ?? '').matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      attrs.set((a[1] as string).toLowerCase(), decodeEntities(a[2] ?? a[3] ?? a[4] ?? ''))
    }
    let body = ''
    if (name === 'script' || name === 'style') {
      const close = source.indexOf(`</${name}`, m.index + m[0].length)
      body = source.slice(m.index + m[0].length, close === -1 ? undefined : close)
    }
    tags.push({ name, attrs, index: m.index, body })
  }
  return tags
}

/**
 * Checks the built page: one production CSP `<meta>`, before any script, style or link it must govern; no inline
 * script, style or event handler (the policy would block them); no `src`/`href` leaving the app's origin.
 * `expected` pins the origin and base when the build environment names them.
 */
export function checkIndexHtml(
  html: string,
  file = 'dist/index.html',
  expected: { origin?: string; base?: string } = {},
): Finding[] {
  const findings: Finding[] = []
  const report = (index: number, rule: string, message: string) =>
    findings.push({ file, ...position(html, index), rule, message })
  const tags = parseTags(html)

  if (html.includes('%APARTE_CSP%'))
    report(html.indexOf('%APARTE_CSP%'), 'csp-meta', 'the CSP placeholder was not replaced')
  const metas = tags.filter(
    (t) => t.name === 'meta' && t.attrs.get('http-equiv')?.toLowerCase() === 'content-security-policy',
  )
  let origin: string | undefined
  if (metas.length !== 1) {
    report(metas[1]?.index ?? 0, 'csp-meta', `expected exactly one CSP <meta>, found ${metas.length}`)
  } else {
    const meta = metas[0] as Tag
    const policy = meta.attrs.get('content') ?? ''
    const appSource = parsePolicy(policy).get('script-src')?.[0] ?? ''
    let base: string | undefined
    try {
      const url = new URL(appSource)
      origin = url.origin
      base = url.pathname
    } catch {
      report(
        meta.index,
        'csp-meta',
        `script-src does not start with the app's <origin><base>: ${appSource || '(empty)'}`,
      )
    }
    if (origin && base) {
      if (expected.origin && expected.origin !== origin) {
        report(meta.index, 'csp-meta', `the CSP is for origin ${origin}, the build environment says ${expected.origin}`)
      }
      if (expected.base && expected.base !== base) {
        report(meta.index, 'csp-meta', `the CSP is for base ${base}, the build environment says ${expected.base}`)
      }
      let production: string | undefined
      try {
        production = contentSecurityPolicy({ origin, base })
      } catch (e) {
        report(meta.index, 'csp-meta', (e as Error).message)
      }
      if (production !== undefined && policy !== production) {
        const want = parsePolicy(production)
        const got = parsePolicy(policy)
        const names = new Set([...want.keys(), ...got.keys()])
        const diff = [...names]
          .filter((n) => want.get(n)?.join(' ') !== got.get(n)?.join(' '))
          .map(
            (n) =>
              `${n}: got "${got.get(n)?.join(' ') ?? '(missing)'}", want "${want.get(n)?.join(' ') ?? '(absent)'}"`,
          )
        report(meta.index, 'csp-meta', `the CSP is not the production policy (${diff.join('; ') || 'directive order'})`)
      }
    }
    const governed = tags.find((t) => ['script', 'link', 'style', 'base', 'img', 'iframe'].includes(t.name))
    if (governed && governed.index < meta.index) {
      report(governed.index, 'csp-meta', `<${governed.name}> comes before the CSP <meta>, which does not govern it`)
    }
  }

  for (const tag of tags) {
    if (tag.name === 'script' && !tag.attrs.has('src')) {
      report(tag.index, 'inline-script', 'inline <script>: the CSP blocks it (no unsafe-inline, no hash)')
    }
    if (tag.name === 'style') report(tag.index, 'inline-style', 'inline <style>: the CSP blocks it')
    for (const [name, value] of tag.attrs) {
      if (name === 'style') report(tag.index, 'inline-style', `style attribute on <${tag.name}>: the CSP blocks it`)
      if (/^on[a-z]+$/.test(name))
        report(tag.index, 'inline-handler', `${name} handler on <${tag.name}>: the CSP blocks it`)
      if (name !== 'src' && name !== 'href' && name !== 'srcset') continue
      for (const url of name === 'srcset' ? value.split(',').map((s) => s.trim().split(/\s+/)[0] ?? '') : [value]) {
        if (/^\s*javascript:/i.test(url)) report(tag.index, 'external-url', `${name}="${url}" on <${tag.name}>`)
        if (!/^\s*(?:[a-z][a-z\d+.-]*:)?\/\//i.test(url)) continue
        let target: string | undefined
        try {
          target = new URL(url, origin ?? 'https://invalid.invalid').origin
        } catch {
          target = undefined
        }
        if (target !== origin) {
          report(tag.index, 'external-url', `${name}="${url}" on <${tag.name}> leaves the app's origin`)
        }
      }
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.column - b.column)
}

// ---------------------------------------------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------------------------------------------

function format(f: Finding): string {
  return `${f.file}:${f.line}:${f.column}  [${f.rule}]  ${f.message}`
}

async function main(): Promise<number> {
  const web = resolve(import.meta.dir, '..')
  const failures: Finding[] = []
  let sources = 0
  for await (const file of new Bun.Glob('src/**/*.{ts,tsx,js,jsx,mjs,mts}').scan({ cwd: web })) {
    const path = file.replaceAll('\\', '/')
    if (!isScannedSource(path)) continue
    sources++
    failures.push(...scanSource(path, await Bun.file(join(web, path)).text()))
  }
  console.log(`scan: ${sources} source files checked`)

  // An optional argument names another build directory; the default is web/dist.
  const dist = process.argv[2] ? resolve(process.argv[2]) : join(web, 'dist')
  if (!existsSync(dist)) {
    console.log('scan: no dist/, skipping the build checks (run `bun run build` first to include them)')
  } else {
    const chunks = new Map<string, string>()
    for await (const file of new Bun.Glob('**/*.{js,mjs}').scan({ cwd: dist })) {
      chunks.set(file.replaceAll('\\', '/'), await Bun.file(join(dist, file)).text())
    }
    const jitless = setsJitless(chunks.values())
    const allowed: BundleHit[] = []
    for (const [file, code] of chunks) {
      const mapFile = Bun.file(join(dist, `${file}.map`))
      const map = (await mapFile.exists())
        ? ((await mapFile.json()) as { sources: string[]; mappings: string })
        : undefined
      for (const hit of scanBundle(`dist/${file}`, code, map)) {
        if (hit.known && (!hit.known.needsJitless || jitless)) {
          allowed.push(hit)
        } else if (hit.known) {
          failures.push({ ...hit, message: `${hit.message}, but no chunk sets config({ jitless: true })` })
        } else {
          failures.push({ ...hit, message: `${hit.message}  …${hit.context}…` })
        }
      }
    }
    console.log(`scan: ${chunks.size} built scripts checked${jitless ? ' (Zod jitless mode is set)' : ''}`)
    for (const hit of allowed) console.log(`  known, never runs: ${hit.file}:${hit.line}:${hit.column}  ${hit.message}`)

    const index = join(dist, 'index.html')
    if (existsSync(index)) {
      const expected = { origin: process.env.VITE_ORIGIN, base: process.env.VITE_BASE }
      failures.push(...checkIndexHtml(await Bun.file(index).text(), relative(web, index) || index, expected))
      console.log('scan: dist/index.html checked')
    } else {
      failures.push({
        file: 'dist/index.html',
        line: 1,
        column: 1,
        rule: 'csp-meta',
        message: 'missing from the build',
      })
    }
  }

  if (failures.length > 0) {
    console.error(`\nscan: ${failures.length} problem${failures.length === 1 ? '' : 's'}`)
    for (const f of failures) console.error(`  ${format(f)}`)
    return 1
  }
  console.log('scan: clean')
  return 0
}

if (import.meta.main) process.exit(await main())
