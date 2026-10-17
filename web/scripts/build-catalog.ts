// Build time only: llm-models lists the providers and their models (models.dev and OpenRouter) and checks, with the
// CORS preflight a browser would send from the app's origin, which providers a web page can call. The result is
// src/core/ai/catalog.json, a lazily loaded chunk. Run from web/: `bun scripts/build-catalog.ts`.
import { writeFile } from 'node:fs/promises'
import { listProviders, probeBrowserSupportAll, providerBaseUrl, setCacheEnabled } from 'llm-models'
import {
  CATALOG_VERSION,
  type Catalog,
  type CatalogProvider,
  kindFor,
  OPENAI_COMPATIBLE_APIS,
  toCatalogModels,
} from '../src/core/ai/catalog.ts'
import { DEFAULT_BASE_URLS } from '../src/core/ai/providers.ts'

const ORIGIN = 'https://maxgfr.github.io'
const OUT = new URL('../src/core/ai/catalog.json', import.meta.url)
/** Gzipped bytes; the catalog is its own lazy chunk, fetched only by the screens that pick a model. */
const BUDGET = 200 * 1024
/** Provider ids llm-models' probe maps to a native protocol; called as OpenAI-compatible, they are probed as such. */
const NATIVE_IDS: ReadonlySet<string> = new Set(['anthropic', 'google', 'cohere'])
/** The only header a provider may require that our adapters send; any other one fails our header allowlist. */
const SENT_HEADERS: ReadonlySet<string> = new Set(['anthropic-dangerous-direct-browser-access'])

setCacheEnabled(false)
const providers = await listProviders()
const targets = providers.flatMap((p) => {
  const listed = providerBaseUrl({ id: p.id, api: p.api ?? null, npm: p.npm ?? null }) ?? undefined
  const kind = kindFor({ id: p.id, npm: p.npm, api: listed })
  if (kind === undefined) return []
  const found =
    (kind === 'openai-compatible' ? OPENAI_COMPATIBLE_APIS[p.id] : undefined) ?? listed ?? DEFAULT_BASE_URLS[kind]
  const api = found?.replace(/\/+$/, '')
  if (api === undefined || !api.startsWith('https://')) return []
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
kept.sort((a, b) => a.id.localeCompare(b.id))
const catalog: Catalog = { version: CATALOG_VERSION, builtAt: new Date().toISOString(), providers: kept }
// One provider per line: small to ship, and a refresh still reads as a per-provider diff.
const lines = catalog.providers.map((p) => `    ${JSON.stringify(p)}`).join(',\n')
await writeFile(
  OUT,
  `{\n  "version": ${catalog.version},\n  "builtAt": ${JSON.stringify(catalog.builtAt)},\n  "providers": [\n${lines}\n  ]\n}\n`,
)
const bytes = await Bun.file(OUT).bytes()
const gzip = Bun.gzipSync(bytes).byteLength
if (gzip > BUDGET) throw new Error(`catalog.json is ${gzip} bytes gzipped, over the ${BUDGET} byte budget`)
const models = kept.reduce((n, p) => n + p.models.length, 0)
console.log(
  `catalog.json: ${kept.length} browser-callable providers of ${providers.length} (${refused.length} refused by CORS), ${models} models, ${bytes.byteLength} bytes, ${gzip} gzipped`,
)
