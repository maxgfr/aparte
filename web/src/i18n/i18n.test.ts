import { describe, expect, test } from 'bun:test'
import { formatBytes, formatDuration, formatRelative } from './format.ts'
import {
  applyDocumentLocale,
  type Catalog,
  createTranslator,
  detectLocale,
  interpolate,
  intlTag,
  LOCALES,
  loadCatalog,
  type Message,
  regionalTag,
} from './index.ts'
import { pseudoize } from './pseudo.ts'

// Catalogs load on demand (only the locale in use is fetched by the app); the tests load every one shipped.
const en = await loadCatalog('en')
const others: Record<string, Catalog> = {}
for (const locale of LOCALES) if (locale !== 'en') others[locale] = await loadCatalog(locale)
const pseudo = await loadCatalog('pseudo')
const all: Record<string, Catalog> = { en, ...others, pseudo }

function flatten(catalog: Catalog): Map<string, Message> {
  const out = new Map<string, Message>()
  for (const [ns, table] of Object.entries(catalog)) {
    const entries: Readonly<Record<string, Message>> = table
    for (const [k, m] of Object.entries(entries)) out.set(`${ns}.${k}`, m)
  }
  return out
}

const texts = (m: Message): string[] => (typeof m === 'string' ? [m] : [m.one, m.other])

const placeholders = (m: Message): string[] =>
  [...new Set(texts(m).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1] ?? '')))].sort()

const source = flatten(en)

describe('catalogs', () => {
  // Every shipped locale and the pseudo-locale are held to the English keys, kinds and placeholders: a missing or
  // renamed placeholder in a translation would print raw braces or drop a value.
  for (const [name, catalog] of Object.entries({ ...others, pseudo })) {
    test(`${name} has the same keys, kinds and placeholders as en`, () => {
      const flat = flatten(catalog)
      expect([...flat.keys()].sort()).toEqual([...source.keys()].sort())
      for (const [key, m] of source) {
        const other = flat.get(key)
        expect(other).toBeDefined()
        if (other === undefined) continue
        expect([key, typeof other]).toEqual([key, typeof m])
        expect([key, placeholders(other)]).toEqual([key, placeholders(m)])
      }
    })
  }

  test('en is a shipped locale', () => {
    expect(LOCALES).toContain('en')
  })

  test('no empty strings anywhere', () => {
    for (const catalog of Object.values(all)) {
      for (const [key, m] of flatten(catalog)) {
        for (const s of texts(m)) expect([key, s.trim().length > 0]).toEqual([key, true])
      }
    }
  })

  test('plural messages reference {count}', () => {
    for (const [key, m] of source)
      if (typeof m !== 'string') expect([key, placeholders(m).includes('count')]).toEqual([key, true])
  })

  test('the product name keeps its accent', () => {
    expect(en.common.appName).toBe('Aparté')
  })
})

describe('t()', () => {
  test('looks up and interpolates', () => {
    const t = createTranslator('en')
    expect(t('shell.navAbout')).toBe('About')
    expect(t('about.originDedicated', { origin: 'https://aparte.example' })).toBe(
      'This copy runs on https://aparte.example, an address of its own.',
    )
  })

  test('unknown keys and inherited properties throw', () => {
    const t = createTranslator('en') as unknown as (k: string) => string
    expect(() => t('nope.key')).toThrow(/unknown key/)
    expect(() => t('common.missing')).toThrow(/unknown key/)
    expect(() => t('common.constructor')).toThrow(/unknown key/)
  })

  test('a translator needs its catalog loaded first', () => {
    // Every locale is loaded above, so the guard is exercised through the type-erased entry point.
    expect(() => createTranslator('xx' as unknown as 'en')).toThrow(/not loaded/)
  })

  test('interpolate formats numbers and keeps unknown placeholders visible', () => {
    expect(interpolate('{n} of {total}', { n: 1200 }, (x) => x.toLocaleString('en-US'))).toBe('1,200 of {total}')
  })

  test('pseudo locale accents, brackets and expands', () => {
    const out = pseudoize('Show answer {count}')
    expect(out.startsWith('[')).toBe(true)
    expect(out.endsWith(']')).toBe(true)
    expect(out).toContain('{count}')
    expect(out).toContain('Šĥóŵ')
    expect(out.length).toBeGreaterThanOrEqual(Math.ceil('Show answer {count}'.length * 1.35))
    expect(createTranslator('pseudo')('shell.navMore')).toBe(pseudoize('More'))
  })
})

describe('detectLocale', () => {
  test('query, then device preference, then navigator.languages, then en', () => {
    expect(detectLocale({ query: 'pseudo', stored: 'en' })).toBe('pseudo')
    expect(detectLocale({ stored: 'pseudo', languages: ['en-GB'] })).toBe('en')
    expect(detectLocale({ languages: ['ja', 'en-AU'] })).toBe('en')
    expect(detectLocale({ languages: ['ja'] })).toBe('en')
    expect(detectLocale({ query: 'klingon' })).toBe('en')
    expect(detectLocale({})).toBe('en')
  })

  test('French and German: picked, or from the device languages', () => {
    expect(detectLocale({ languages: ['ja', 'de-AT', 'en-US'] })).toBe('de')
    expect(detectLocale({ languages: ['fr-CA'] })).toBe('fr')
    expect(detectLocale({ stored: 'fr', languages: ['de-DE'] })).toBe('fr')
    expect(detectLocale({ stored: 'system', languages: ['de-DE'] })).toBe('de')
    expect(detectLocale({ query: 'de', stored: 'fr' })).toBe('de')
  })

  test('applyDocumentLocale is safe without a DOM', () => {
    expect(() => applyDocumentLocale('en')).not.toThrow()
  })
})

describe('regional formats', () => {
  test('first device language of the same base wins', () => {
    expect(intlTag('en', ['fr-FR', 'en-GB', 'en-US'])).toBe('en-GB')
  })

  test('no matching device language: the default region', () => {
    expect(intlTag('en', ['de-CH'])).toBe('en-US')
    expect(intlTag('en', [])).toBe('en-US')
  })

  test('French and German default to France and Germany', () => {
    expect(intlTag('fr', [])).toBe('fr-FR')
    expect(intlTag('de', ['en-GB'])).toBe('de-DE')
    expect(intlTag('fr', ['fr-CH'])).toBe('fr-CH')
  })

  test('malformed tags are skipped; pseudo stays en-XA for <html lang>', () => {
    expect(intlTag('en', ['en_GB!', 'en-AU'])).toBe('en-AU')
    expect(regionalTag('pseudo', ['en-GB'])).toBe('en-XA')
    expect(intlTag('pseudo', ['en-GB'])).toBe('en-US')
  })
})

describe('format', () => {
  test('bytes, relative time, durations', () => {
    expect(formatBytes('en', 968_000_000)).toBe('968 MB')
    expect(formatBytes('en', 2_400_000_000)).toBe('2.4 GB')
    expect(formatRelative('en', 3 * 86400_000, 0)).toBe('in 3 days')
    expect(formatRelative('en', -86400_000, 0)).toBe('yesterday')
    expect(formatDuration('en', 3_900_000)).toBe('1 hr 5 min')
  })
})
