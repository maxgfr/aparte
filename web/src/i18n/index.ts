import type { about } from './en/about.ts'
import type { chat } from './en/chat.ts'
import type { common } from './en/common.ts'
import type { compare } from './en/compare.ts'
import type { knowledge } from './en/knowledge.ts'
import type { local } from './en/local.ts'
import type { mcp } from './en/mcp.ts'
import type { media } from './en/media.ts'
import type { research } from './en/research.ts'
import type { roleplay } from './en/roleplay.ts'
import type { sandbox } from './en/sandbox.ts'
import type { shell } from './en/shell.ts'
import type { skills } from './en/skills.ts'
import type { stats } from './en/stats.ts'
import type { sync } from './en/sync.ts'
import type { tools } from './en/tools.ts'
import type { transfer } from './en/transfer.ts'
import type { vault } from './en/vault.ts'

export interface Plural {
  readonly one: string
  readonly other: string
}

export type Message = string | Plural

/** Widened shape of a source namespace: same keys, any string values. Translations declare `satisfies Shape<…>`. */
export type Shape<T> = {
  readonly [K in keyof T]: T[K] extends string ? string : T[K] extends Plural ? Plural : never
}

/** The source language: English defines every key (and its types); it loads like any other locale. */
type Source = {
  readonly common: typeof common
  readonly shell: typeof shell
  readonly about: typeof about
  readonly vault: typeof vault
  readonly chat: typeof chat
  readonly tools: typeof tools
  readonly local: typeof local
  readonly sync: typeof sync
  readonly mcp: typeof mcp
  readonly transfer: typeof transfer
  readonly roleplay: typeof roleplay
  readonly compare: typeof compare
  readonly stats: typeof stats
  readonly knowledge: typeof knowledge
  readonly sandbox: typeof sandbox
  readonly media: typeof media
  readonly skills: typeof skills
  readonly research: typeof research
}
export type Namespace = keyof Source
const NAMESPACES: readonly Namespace[] = [
  'common',
  'shell',
  'about',
  'vault',
  'chat',
  'tools',
  'local',
  'sync',
  'mcp',
  'transfer',
  'roleplay',
  'compare',
  'stats',
  'knowledge',
  'sandbox',
  'media',
  'skills',
  'research',
]
export type Catalog = { readonly [N in Namespace]: Shape<Source[N]> }

/**
 * The interface languages this build ships. A new language adds its code here, a loader below and a default
 * region; the parity test then holds it to the English keys and placeholders.
 */
export const LOCALES = ['en', 'fr', 'de'] as const
export type BaseLocale = (typeof LOCALES)[number]
export type Locale = BaseLocale | 'pseudo'

/** Each language named in itself, as a language picker lists it (the same in every interface language). */
export const LOCALE_NAMES: { readonly [L in BaseLocale]: string } = { en: 'English', fr: 'Français', de: 'Deutsch' }

/**
 * No catalog ships in the initial bundle: the one locale in use is fetched once, before the first render (the
 * other languages never weigh on a device that does not use them).
 */
const loaded = new Map<Locale, Catalog>()

/** One namespace module of a locale, as each file exports it (`export const common = {…}`). */
type Module<N extends Namespace> = { readonly [K in N]: Shape<Source[N]> }
type Modules = { readonly [N in Namespace]: Promise<Module<N>> }

/** Joins a locale's namespace chunks (fetched in parallel) into its catalog. */
async function assemble(m: Modules): Promise<Catalog> {
  const [
    common,
    shell,
    about,
    vault,
    chat,
    tools,
    local,
    sync,
    mcp,
    transfer,
    roleplay,
    compare,
    stats,
    knowledge,
    sandbox,
    media,
    skills,
    research,
  ] = await Promise.all([
    m.common,
    m.shell,
    m.about,
    m.vault,
    m.chat,
    m.tools,
    m.local,
    m.sync,
    m.mcp,
    m.transfer,
    m.roleplay,
    m.compare,
    m.stats,
    m.knowledge,
    m.sandbox,
    m.media,
    m.skills,
    m.research,
  ])
  return {
    common: common.common,
    shell: shell.shell,
    about: about.about,
    vault: vault.vault,
    chat: chat.chat,
    tools: tools.tools,
    local: local.local,
    sync: sync.sync,
    mcp: mcp.mcp,
    transfer: transfer.transfer,
    roleplay: roleplay.roleplay,
    compare: compare.compare,
    stats: stats.stats,
    knowledge: knowledge.knowledge,
    sandbox: sandbox.sandbox,
    media: media.media,
    skills: skills.skills,
    research: research.research,
  }
}

const loaders: { readonly [L in Locale]: () => Promise<Catalog> } = {
  en: () =>
    assemble({
      common: import('./en/common.ts'),
      shell: import('./en/shell.ts'),
      about: import('./en/about.ts'),
      vault: import('./en/vault.ts'),
      chat: import('./en/chat.ts'),
      tools: import('./en/tools.ts'),
      local: import('./en/local.ts'),
      sync: import('./en/sync.ts'),
      mcp: import('./en/mcp.ts'),
      transfer: import('./en/transfer.ts'),
      roleplay: import('./en/roleplay.ts'),
      compare: import('./en/compare.ts'),
      stats: import('./en/stats.ts'),
      knowledge: import('./en/knowledge.ts'),
      sandbox: import('./en/sandbox.ts'),
      media: import('./en/media.ts'),
      skills: import('./en/skills.ts'),
      research: import('./en/research.ts'),
    }),
  fr: () =>
    assemble({
      common: import('./fr/common.ts'),
      shell: import('./fr/shell.ts'),
      about: import('./fr/about.ts'),
      vault: import('./fr/vault.ts'),
      chat: import('./fr/chat.ts'),
      tools: import('./fr/tools.ts'),
      local: import('./fr/local.ts'),
      sync: import('./fr/sync.ts'),
      mcp: import('./fr/mcp.ts'),
      transfer: import('./fr/transfer.ts'),
      roleplay: import('./fr/roleplay.ts'),
      compare: import('./fr/compare.ts'),
      stats: import('./fr/stats.ts'),
      knowledge: import('./fr/knowledge.ts'),
      sandbox: import('./fr/sandbox.ts'),
      media: import('./fr/media.ts'),
      skills: import('./fr/skills.ts'),
      research: import('./fr/research.ts'),
    }),
  de: () =>
    assemble({
      common: import('./de/common.ts'),
      shell: import('./de/shell.ts'),
      about: import('./de/about.ts'),
      vault: import('./de/vault.ts'),
      chat: import('./de/chat.ts'),
      tools: import('./de/tools.ts'),
      local: import('./de/local.ts'),
      sync: import('./de/sync.ts'),
      mcp: import('./de/mcp.ts'),
      transfer: import('./de/transfer.ts'),
      roleplay: import('./de/roleplay.ts'),
      compare: import('./de/compare.ts'),
      stats: import('./de/stats.ts'),
      knowledge: import('./de/knowledge.ts'),
      sandbox: import('./de/sandbox.ts'),
      media: import('./de/media.ts'),
      skills: import('./de/skills.ts'),
      research: import('./de/research.ts'),
    }),
  pseudo: async () => {
    const [{ pseudoCatalog }, en] = await Promise.all([import('./pseudo.ts'), loadCatalog('en')])
    return pseudoCatalog(en)
  },
}

/** The catalog of a locale once loaded. */
export function loadedCatalog(locale: Locale): Catalog | undefined {
  return loaded.get(locale)
}

/** Fetches a locale's catalog (once); a translator for it can then be created synchronously. */
export async function loadCatalog(locale: Locale): Promise<Catalog> {
  const have = loaded.get(locale)
  if (have) return have
  const catalog = await loaders[locale]()
  loaded.set(locale, catalog)
  return catalog
}

type KeysOf<N extends Namespace> = Extract<keyof Source[N], string>
export type Key = { [N in Namespace]: `${N}.${KeysOf<N>}` }[Namespace]

type PluralKey = {
  [N in Namespace]: { [K in KeysOf<N>]: Source[N][K] extends Plural ? `${N}.${K}` : never }[KeysOf<N>]
}[Namespace]

export type Params = Readonly<Record<string, string | number>>

export type Translate = {
  (key: Exclude<Key, PluralKey>, params?: Params): string
  (key: PluralKey, params: Params & { readonly count: number }): string
}

const PLACEHOLDER = /\{(\w+)\}/g

/** Fills `{name}` placeholders; a missing parameter stays visible as `{name}` rather than vanishing. */
export function interpolate(template: string, params: Params | undefined, format: (n: number) => string): string {
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = params?.[name]
    if (value === undefined) return match
    return typeof value === 'number' ? format(value) : value
  })
}

export function lookup(catalog: Catalog, key: string): Message | undefined {
  const dot = key.indexOf('.')
  const ns = key.slice(0, dot)
  const name = key.slice(dot + 1)
  if (!isNamespace(ns)) return undefined
  const table: Readonly<Record<string, Message>> = catalog[ns]
  return Object.hasOwn(table, name) ? table[name] : undefined
}

function isNamespace(value: string): value is Namespace {
  return NAMESPACES.some((n) => n === value)
}

/** Formatting region used when the device lists no regional variant of the interface language. */
const DEFAULT_REGION: Record<BaseLocale, string> = { en: 'en-US', fr: 'fr-FR', de: 'de-DE' }

/** A well-formed BCP-47 language tag (language plus optional subtags); anything else is ignored. */
const TAG = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/i

function deviceLanguages(): readonly string[] {
  return (typeof navigator === 'undefined' ? undefined : navigator.languages) ?? []
}

/**
 * Regional BCP-47 tag for a UI locale: the first device language of the same base (en-GB, en-AU…), else the
 * default region of that language. Applies to an explicitly picked language too. Pseudo is en-XA.
 */
export function regionalTag(locale: Locale, languages: readonly string[] = deviceLanguages()): string {
  if (locale === 'pseudo') return 'en-XA'
  for (const tag of languages) {
    if (TAG.test(tag) && tag.split('-')[0]?.toLowerCase() === locale) return tag
  }
  return DEFAULT_REGION[locale]
}

/** BCP-47 tag used by Intl for a locale: regional formats follow the device (pseudo formats like US English). */
export function intlTag(locale: Locale, languages: readonly string[] = deviceLanguages()): string {
  return locale === 'pseudo' ? 'en-US' : regionalTag(locale, languages)
}

/** A translator for a loaded locale (see `loadCatalog`). Unknown keys throw: a typo never ships silently. */
export function createTranslator(locale: Locale): Translate {
  const catalog = loaded.get(locale)
  if (catalog === undefined) throw new Error(`i18n: catalog "${locale}" is not loaded`)
  const tag = intlTag(locale)
  const rules = new Intl.PluralRules(tag)
  const numbers = new Intl.NumberFormat(tag)
  const translate = (key: string, params?: Params): string => {
    const english = loaded.get('en')
    const message = lookup(catalog, key) ?? (english === undefined ? undefined : lookup(english, key))
    if (message === undefined) throw new Error(`i18n: unknown key "${key}"`)
    let template: string
    if (typeof message === 'string') {
      template = message
    } else {
      const count = params?.count
      if (typeof count !== 'number') throw new Error(`i18n: plural key "${key}" needs a numeric count`)
      template = rules.select(count) === 'one' ? message.one : message.other
    }
    return interpolate(template, params, (n) => numbers.format(n))
  }
  return translate as Translate
}

export function isLocale(value: string | null | undefined): value is Locale {
  return value === 'pseudo' || LOCALES.some((l) => l === value)
}

export interface DetectInput {
  /** Explicit `?locale=` query value (the pseudo-locale is reached this way only). */
  readonly query?: string | null
  /** Locale chosen by the user on this device. */
  readonly stored?: string | null
  /** `navigator.languages`. */
  readonly languages?: readonly string[]
}

/** Query override, then device preference, then navigator.languages, then en. */
export function detectLocale(input: DetectInput): Locale {
  if (isLocale(input.query)) return input.query
  if (isLocale(input.stored) && input.stored !== 'pseudo') return input.stored
  for (const tag of input.languages ?? []) {
    const base = tag.toLowerCase().split('-')[0]
    if (isLocale(base) && base !== 'pseudo') return base
  }
  return 'en'
}

/** Reads the environment (if any) to detect the locale; safe without a DOM. */
export function detectFromEnvironment(stored?: string | null): Locale {
  const query = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('locale')
  const languages = typeof navigator === 'undefined' ? [] : navigator.languages
  return detectLocale({ query, stored, languages })
}

/** Languages written right to left, by base subtag; none ships yet, but `dir` follows the locale all the same. */
const RTL = new Set(['ar', 'fa', 'he', 'ur'])

/** Updates `<html lang>` and `<html dir>` when a document exists. */
export function applyDocumentLocale(locale: Locale): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.lang = regionalTag(locale)
  root.dir = RTL.has(locale) ? 'rtl' : 'ltr'
}
