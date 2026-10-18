// Build time only: llm-models lists the providers and their models (models.dev and OpenRouter) and checks, with the
// CORS preflight a browser would send from the app's origin, which providers a web page can call. Those are
// src/core/ai/catalog.json, a lazily loaded chunk; every other provider (behind a proxy, or of a protocol no adapter
// speaks) goes to src/core/ai/catalog-all.json, a second chunk loaded only when the user asks for every provider.
// Run from web/: `bun scripts/build-catalog.ts`.
import { writeFile } from 'node:fs/promises'
import { listProviders, probeBrowserSupportAll, providerBaseUrl, setCacheEnabled } from 'llm-models'
import {
  CATALOG_VERSION,
  type Catalog,
  type CatalogProvider,
  type ForeignProvider,
  kindFor,
  OPENAI_COMPATIBLE_APIS,
  toCatalogModels,
} from '../src/core/ai/catalog.ts'
import { LOCAL_PRESETS } from '../src/core/ai/endpoints.ts'
import { DEFAULT_BASE_URLS } from '../src/core/ai/providers.ts'

const ORIGIN = 'https://maxgfr.github.io'
const OUT = new URL('../src/core/ai/catalog.json', import.meta.url)
const OUT_ALL = new URL('../src/core/ai/catalog-all.json', import.meta.url)
/** Gzipped bytes; the catalog is its own lazy chunk, fetched only by the screens that pick a model. */
const BUDGET = 200 * 1024
/** Gzipped bytes of the second chunk, fetched only when the user turns on every provider. */
const BUDGET_ALL = 400 * 1024
/** Provider ids llm-models' probe maps to a native protocol; called as OpenAI-compatible, they are probed as such. */
const NATIVE_IDS: ReadonlySet<string> = new Set(['anthropic', 'google', 'cohere'])
/** The only header a provider may require that our adapters send; any other one fails our header allowlist. */
const SENT_HEADERS: ReadonlySet<string> = new Set(['anthropic-dangerous-direct-browser-access'])
/** Servers that run on the user's machine: the app offers them as local presets, at their own address. */
const LOCAL_IDS: ReadonlySet<string> = new Set(LOCAL_PRESETS.map((p) => p.id))

setCacheEnabled(false)
const providers = await listProviders()
const proxied: CatalogProvider[] = []
const foreign: ForeignProvider[] = []
/** A provider a browser cannot call directly but an adapter of ours speaks to, given a base URL the user runs. */
const behindProxy = (p: (typeof providers)[number], kind: CatalogProvider['kind'], api: string | undefined) => {
  const models = toCatalogModels(p.id, p.models)
  if (models.length === 0 || LOCAL_IDS.has(p.id)) return
  proxied.push({
    id: p.id,
    name: p.name,
    kind,
    ...(api?.startsWith('https://') && api !== DEFAULT_BASE_URLS[kind] ? { api } : {}),
    ...(p.doc ? { doc: p.doc } : {}),
    reach: 'proxy',
    models,
  })
}
const targets = providers.flatMap((p) => {
  const listed = providerBaseUrl({ id: p.id, api: p.api ?? null, npm: p.npm ?? null }) ?? undefined
  const kind = kindFor({ id: p.id, npm: p.npm, api: listed })
  if (kind === undefined) {
    const models = toCatalogModels(p.id, p.models)
    if (models.length > 0) {
      foreign.push({
        id: p.id,
        name: p.name,
        ...(p.npm ? { npm: p.npm } : {}),
        ...(p.doc ? { doc: p.doc } : {}),
        models,
      })
    }
    return []
  }
  const found =
    (kind === 'openai-compatible' ? OPENAI_COMPATIBLE_APIS[p.id] : undefined) ?? listed ?? DEFAULT_BASE_URLS[kind]
  const api = found?.replace(/\/+$/, '')
  if (api === undefined || !api.startsWith('https://')) {
    behindProxy(p, kind, api)
    return []
  }
  const npm = kind === 'openai-compatible' ? '@ai-sdk/openai-compatible' : (p.npm ?? null)
  // The probe picks the protocol from the id as well as the package: probe the endpoint we will call.
  const id = kind === 'openai-compatible' && NATIVE_IDS.has(p.id) ? `${p.id}-openai-compatible` : p.id
  return [{ p, kind, api, target: { id, api, npm } }]
})
const support = await probeBrowserSupportAll(
  targets.map((t) => t.target),
  { origin: ORIGIN },
)
const kept: CatalogProvider[] = []
const refused: string[] = []
for (const { p, kind, api, target } of targets) {
  const s = support[target.id]
  const extraHeaders = Object.keys(s?.required_headers ?? {}).filter((h) => !SENT_HEADERS.has(h.toLowerCase()))
  if (!s?.callable || extraHeaders.length > 0) {
    refused.push(p.id)
    behindProxy(p, kind, api)
    continue
  }
  const models = toCatalogModels(p.id, p.models)
  if (models.length === 0) continue
  const entry: CatalogProvider = {
    id: p.id,
    name: p.name,
    kind,
    // A maker's own API keeps its default address; only the others are written out.
    ...(api !== DEFAULT_BASE_URLS[kind] ? { api } : {}),
    ...(p.doc ? { doc: p.doc } : {}),
    models,
  }
  kept.push(entry)
}
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)
kept.sort(byId)
proxied.sort(byId)
foreign.sort(byId)
const builtAt = new Date().toISOString()
// One provider per line: small to ship, and a refresh still reads as a per-provider diff.
const listing = (entries: readonly object[]) => entries.map((p) => `    ${JSON.stringify(p)}`).join(',\n')
const header = `{\n  "version": ${CATALOG_VERSION},\n  "builtAt": ${JSON.stringify(builtAt)},\n`
const catalog: Catalog = { version: CATALOG_VERSION, builtAt, providers: kept }
await writeFile(OUT, `${header}  "providers": [\n${listing(catalog.providers)}\n  ]\n}\n`)
await writeFile(
  OUT_ALL,
  `${header}  "providers": [\n${listing(proxied)}\n  ],\n  "foreign": [\n${listing(foreign)}\n  ]\n}\n`,
)
const sizes = async (url: URL, budget: number) => {
  const bytes = await Bun.file(url).bytes()
  const gzip = Bun.gzipSync(bytes).byteLength
  if (gzip > budget) throw new Error(`${url.pathname} is ${gzip} bytes gzipped, over the ${budget} byte budget`)
  return `${bytes.byteLength} bytes, ${gzip} gzipped`
}
const count = (list: readonly { models: readonly unknown[] }[]) => list.reduce((n, p) => n + p.models.length, 0)
console.log(
  `catalog.json: ${kept.length} browser-callable providers of ${providers.length} (${refused.length} refused by CORS), ${count(kept)} models, ${await sizes(OUT, BUDGET)}`,
)
console.log(
  `catalog-all.json: ${proxied.length} providers behind a proxy, ${foreign.length} of another protocol, ${count(proxied) + count(foreign)} models, ${await sizes(OUT_ALL, BUDGET_ALL)}`,
)
