/**
 * Pins the in-browser models the app offers (`bun run pin:models`): for each WebLLM model of the list below, the
 * Hugging Face commit its files are read from (`resolve/<commit>/`, never `main`), the commit of
 * mlc-ai/binary-mlc-llm-libs its compiled WebGPU library is read from, and the SHA-256 of every file the engine may
 * fetch. The worker refuses any other URL and checks every byte it caches or reads back against these digests
 * (src/workers/webllm.worker.ts, src/core/ai/local/pinnedCache.ts).
 *
 * Model facts (size, memory, context window, tool calling) come from llm-models' extract of the same WebLLM release,
 * which must match the installed @mlc-ai/web-llm. Large files are LFS objects whose pointer already names their
 * SHA-256; the small ones (configs, tokenizer, tensor list) are downloaded and hashed here.
 *
 * It also pins the embedding model of the transformers.js worker (src/workers/transformers.worker.ts) the same way.
 *
 * Writes src/core/ai/local/webllm-models.json (what the page needs), src/workers/webllm-files.json (the digests, which
 * only the worker loads) and src/workers/embedding-pins.json. Re-run it when the WebLLM version or a list changes, and
 * review the diff.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { prebuiltAppConfig } from '@mlc-ai/web-llm'
import { browserModelCatalog, listBrowserModels } from 'llm-models/browser'

/** The models offered, smallest first; each in its fp16 build and its fp32 build (for GPUs without shader-f16). */
const MODELS = [
  'SmolLM2-360M-Instruct-q4f16_1-MLC',
  'SmolLM2-360M-Instruct-q4f32_1-MLC',
  'Qwen3.5-0.8B-q4f16_1-MLC',
  'Qwen3.5-0.8B-q4f32_1-MLC',
  'Llama-3.2-1B-Instruct-q4f16_1-MLC',
  'Llama-3.2-1B-Instruct-q4f32_1-MLC',
  'Qwen3.5-2B-q4f16_1-MLC',
  'Qwen3.5-2B-q4f32_1-MLC',
  'gemma-4-E2B-it-q4f16_1-MLC',
  'gemma-4-E2B-it-q4f32_1-MLC',
  'Llama-3.2-3B-Instruct-q4f16_1-MLC',
  'Llama-3.2-3B-Instruct-q4f32_1-MLC',
  'Phi-4-mini-instruct-q4f16_1-MLC',
  'Phi-4-mini-instruct-q4f32_1-MLC',
  'Qwen3.5-4B-q4f16_1-MLC',
  'Qwen3.5-4B-q4f32_1-MLC',
  'Hermes-3-Llama-3.1-8B-q4f16_1-MLC',
  'Hermes-3-Llama-3.1-8B-q4f32_1-MLC',
]

/** The embedding model (sentence-transformers' all-MiniLM-L6-v2, ONNX export) and the files transformers.js reads. */
const EMBEDDING = {
  repo: 'Xenova/all-MiniLM-L6-v2',
  files: [
    'config.json',
    'tokenizer.json',
    'tokenizer_config.json',
    'special_tokens_map.json',
    'onnx/model_quantized.onnx',
  ],
}

/** Files of a model repository the engine never fetches. */
const SKIPPED = new Set(['.gitattributes', 'README.md'])

const LIBS_REPO = 'mlc-ai/binary-mlc-llm-libs'
const HF = 'https://huggingface.co'

interface TreeEntry {
  type: 'file' | 'directory'
  path: string
  size: number
  lfs?: { oid: string; size: number }
}

async function getJson<T>(url: string): Promise<{ body: T; next: string | null }> {
  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const link = res.headers.get('link') ?? ''
  const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null
  return { body: (await res.json()) as T, next }
}

async function sha256Of(url: string): Promise<{ sha256: string; size: number }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength }
}

async function tree(repo: string, commit: string): Promise<TreeEntry[]> {
  const out: TreeEntry[] = []
  let url: string | null = `${HF}/api/models/${repo}/tree/${commit}?recursive=true`
  while (url !== null) {
    const page: { body: TreeEntry[]; next: string | null } = await getJson<TreeEntry[]>(url)
    out.push(...page.body)
    url = page.next
  }
  return out.filter((e) => e.type === 'file')
}

/** `Qwen3.5 0.8B`, `Llama 3.2 3B Instruct`: the series and size llm-models reads from the id, and the build. */
function displayName(series: string, params: number | null, quantization: string): string {
  const size = params === null ? '' : ` ${params < 0.5 ? `${Math.round(params * 1000)}M` : `${params}B`}`
  return `${series}${size} (${quantization.replace(/_\d+$/, '')})`
}

async function main(): Promise<void> {
  const web = resolve(import.meta.dir, '..')
  const pkg = JSON.parse(readFileSync(join(web, 'node_modules/@mlc-ai/web-llm/package.json'), 'utf8')) as {
    version: string
  }
  const catalog = browserModelCatalog()
  if (catalog.source.version !== pkg.version)
    throw new Error(`llm-models describes WebLLM ${catalog.source.version}, the installed one is ${pkg.version}`)
  const described = new Map(listBrowserModels().map((m) => [m.id, m]))
  const records = new Map(prebuiltAppConfig.model_list.map((r) => [r.model_id, r]))

  const libs = await getJson<{ sha: string }>(`https://api.github.com/repos/${LIBS_REPO}/commits/main`)
  const libsCommit = libs.body.sha
  const models: unknown[] = []
  const files: Record<string, Record<string, string>> = {}

  for (const id of MODELS) {
    const record = records.get(id)
    const model = described.get(id)
    if (!record || !model) throw new Error(`${id} is not a model of WebLLM ${pkg.version}`)
    if (record.model !== model.hf_repo || record.model_lib !== model.model_lib)
      throw new Error(`${id}: llm-models and WebLLM disagree on its files`)
    const repo = new URL(record.model).pathname.replace(/^\/+|\/+$/g, '')
    const info = await getJson<{ sha: string }>(`${HF}/api/models/${repo}/revision/main`)
    const commit = info.body.sha
    const digests: Record<string, string> = {}
    let bytes = 0
    for (const entry of await tree(repo, commit)) {
      if (SKIPPED.has(entry.path)) continue
      if (entry.lfs) {
        digests[entry.path] = entry.lfs.oid
        bytes += entry.lfs.size
      } else {
        const hashed = await sha256Of(`${HF}/${repo}/resolve/${commit}/${entry.path}`)
        digests[entry.path] = hashed.sha256
        bytes += hashed.size
      }
    }
    if (!('mlc-chat-config.json' in digests)) throw new Error(`${id}: no mlc-chat-config.json at ${commit}`)
    const libPath = new URL(record.model_lib).pathname.replace(/^\/[^/]+\/[^/]+\/main\//, '')
    const libUrl = `https://raw.githubusercontent.com/${LIBS_REPO}/${libsCommit}/${libPath}`
    const lib = await sha256Of(libUrl)
    files[id] = Object.fromEntries(Object.entries(digests).sort(([a], [b]) => a.localeCompare(b)))
    models.push({
      id,
      name: displayName(model.series, model.params_b, model.quantization),
      series: model.series,
      repo,
      commit,
      lib: { url: libUrl, sha256: lib.sha256, bytes: lib.size },
      bytes: bytes + lib.size,
      vramMB: Math.round(model.vram_required_mb),
      contextWindow: model.context_window ?? 4096,
      tools: model.function_calling,
      reasoning: model.reasoning,
      f16: model.compute_dtype === 'f16',
      lowResource: model.low_resource_required,
    })
    console.log(`${id}: ${commit.slice(0, 10)}, ${Object.keys(digests).length} files, ${(bytes / 1e6).toFixed(0)} MB`)
  }

  const embedInfo = await getJson<{ sha: string }>(`${HF}/api/models/${EMBEDDING.repo}/revision/main`)
  const embedCommit = embedInfo.body.sha
  const embedTree = new Map((await tree(EMBEDDING.repo, embedCommit)).map((e) => [e.path, e]))
  const embedFiles: Record<string, string> = {}
  for (const path of EMBEDDING.files) {
    const entry = embedTree.get(path)
    if (!entry) throw new Error(`${EMBEDDING.repo}: no ${path} at ${embedCommit}`)
    embedFiles[path] = entry.lfs
      ? entry.lfs.oid
      : (await sha256Of(`${HF}/${EMBEDDING.repo}/resolve/${embedCommit}/${path}`)).sha256
  }
  console.log(`${EMBEDDING.repo}: ${embedCommit.slice(0, 10)}, ${EMBEDDING.files.length} files`)

  const header = {
    $comment:
      'Generated by web/scripts/pin-local-models.ts: the in-browser models the app offers, pinned to a commit. Do not edit by hand.',
  }
  writeFileSync(
    join(web, 'src/core/ai/local/webllm-models.json'),
    `${JSON.stringify({ ...header, webllm: pkg.version, libs: { repo: LIBS_REPO, commit: libsCommit }, models }, null, 2)}\n`,
  )
  writeFileSync(join(web, 'src/workers/webllm-files.json'), `${JSON.stringify({ ...header, files }, null, 2)}\n`)
  writeFileSync(
    join(web, 'src/workers/embedding-pins.json'),
    `${JSON.stringify({ ...header, repo: EMBEDDING.repo, commit: embedCommit, files: embedFiles }, null, 2)}\n`,
  )
}

if (import.meta.main) await main()
