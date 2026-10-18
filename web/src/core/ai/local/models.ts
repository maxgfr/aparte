/*
 * The in-browser model service the model screen and the chat share: the device check, llm-models' ranking of the
 * pinned models for this GPU, the cache state of each model, downloads (after a storage check, with progress, stop and
 * resume), deletion, and the one engine (a worker) the chat runs on. The ranking of models for this device is
 * recommend.ts, loaded by the model screen only (it carries llm-models' WebLLM catalog).
 */
import {
  type DeviceVerdict,
  type LoadProgress,
  type LocalEngine,
  LocalModelError,
  type ModelCacheState,
  type PinnedModel,
  type SpaceVerdict,
  type StorageEstimate,
} from '../../contracts/local.ts'
import { modelBaseUrl, pinnedModel, WEBLLM_MODELS } from './catalog.ts'
import { checkSpace, type DetectEnv, detectDevice, modelFit } from './device.ts'
import { type CacheStorageLike, modelCacheState, removeModelFiles } from './pinnedCache.ts'

/** URLs of a model's cached files as the page reads them. */
function stateInput(model: PinnedModel) {
  return { baseUrl: modelBaseUrl(model), libUrl: model.lib.url, libBytes: model.lib.bytes, totalBytes: model.bytes }
}

/** Whether a cached URL belongs to `model`: under its pinned base URL, or its library when no other model shares it. */
function belongsTo(model: PinnedModel): (url: string) => boolean {
  const base = modelBaseUrl(model)
  const shared = WEBLLM_MODELS.some((m) => m.id !== model.id && m.lib.url === model.lib.url)
  return (url) => url.startsWith(base) || (!shared && url === model.lib.url)
}

export interface LocalModels {
  detect(): Promise<DeviceVerdict>
  state(modelId: string): Promise<ModelCacheState>
  /** The origin's storage use, or null when the browser does not say. */
  estimate(): Promise<StorageEstimate | null>
  /** Whether what remains of a download fits next to the vault. */
  space(modelId: string): Promise<SpaceVerdict>
  /**
   * Downloads what the cache lacks, then loads the model (so it is checked end to end). Refuses with `no-space` when
   * the space check fails, with `unavailable` when the GPU cannot run it. An abort stops it; calling it again resumes.
   */
  download(modelId: string, onProgress?: (p: LoadProgress) => void, signal?: AbortSignal): Promise<void>
  /** Deletes the model's files and frees the engine if it held this model. */
  remove(modelId: string): Promise<void>
  /** The engine the chat streams through; it loads cached models only. */
  engine(): LocalEngine
  /** Stops the engine (the worker and its GPU memory); the next call starts it again. */
  release(): void
}

export interface LocalModelsDeps {
  readonly env: () => DetectEnv
  /** Starts an engine (a worker); called again after the previous one was stopped. */
  readonly startEngine: () => LocalEngine
  readonly caches: () => Pick<CacheStorageLike, 'open' | 'has'> | undefined
  readonly storage: () => { estimate(): Promise<StorageEstimate> } | undefined
}

export function createLocalModels(deps: LocalModelsDeps): LocalModels {
  let engine: LocalEngine | null = null
  /** The model the engine holds or is loading, and whether that load may download. */
  let current: { id: string; ready: Promise<void> } | null = null

  const drop = () => {
    engine?.dispose()
    engine = null
    current = null
  }
  const getEngine = () => {
    engine ??= deps.startEngine()
    return engine
  }
  const caches = () => {
    const c = deps.caches()
    if (!c) throw new LocalModelError('unavailable', 'This browser has no Cache Storage')
    return c
  }
  const model = (id: string): PinnedModel => {
    const m = pinnedModel(id)
    if (!m) throw new LocalModelError('unsupported-model', `${id} is not a model this build pins`)
    return m
  }
  const estimate = async () => {
    try {
      return (await deps.storage()?.estimate()) ?? null
    } catch {
      return null
    }
  }
  const state = (id: string) => modelCacheState(caches(), stateInput(model(id)))
  const space = async (id: string, s?: ModelCacheState) => {
    const st = s ?? (await state(id))
    if (st.complete) return checkSpace(await estimate(), 0, st.cachedBytes)
    return checkSpace(await estimate(), Math.max(0, st.totalBytes - st.cachedBytes), st.cachedBytes)
  }

  /** Loads `id` into the engine (one model at a time: another one stops the engine first). */
  const ensureLoaded = (
    id: string,
    download: boolean,
    onProgress?: (p: LoadProgress) => void,
    signal?: AbortSignal,
  ) => {
    if (current?.id === id) return current.ready
    if (current) drop()
    const ready = getEngine()
      .load(id, { download, ...(onProgress ? { onProgress } : {}), ...(signal ? { signal } : {}) })
      .catch((e: unknown) => {
        // Whatever state the engine is in now is unknown: start afresh next time.
        if (current?.ready === ready) drop()
        throw e
      })
    current = { id, ready }
    return ready
  }

  /** The engine of the chat: loads a cached model on first use, never downloads, then streams. */
  const chatEngine: LocalEngine = {
    load: (id, options) => ensureLoaded(id, false, options.onProgress, options.signal),
    chat: (request, signal) => getEngine().chat(request, signal),
    dispose: drop,
  }

  return {
    detect: () => detectDevice(deps.env()),
    state,
    estimate,
    space: (id) => space(id),
    async download(id, onProgress, signal) {
      const m = model(id)
      const verdict = await detectDevice(deps.env())
      if (!verdict.supported)
        throw new LocalModelError('unavailable', `WebGPU cannot run models here (${verdict.reason})`)
      const fit = modelFit(m, verdict.gpu)
      if (fit === 'f16' || fit === 'storage-binding') {
        throw new LocalModelError('unavailable', `This GPU cannot run ${m.name} (${fit})`)
      }
      const before = await state(id)
      if (!before.complete) {
        const room = await space(id, before)
        if (!room.ok) throw new LocalModelError('no-space', 'The download would not fit next to the vault')
      }
      // A load that was cache-only (from a chat) cannot download: start the engine afresh for this one.
      if (current !== null) drop()
      await ensureLoaded(id, true, onProgress, signal)
      if (!(await state(id)).complete) {
        throw new LocalModelError('engine', `${m.name} loaded but its files are not all in the cache`)
      }
    },
    async remove(id) {
      const m = model(id)
      if (current?.id === id) drop()
      await removeModelFiles(caches(), belongsTo(m))
    },
    engine: () => chatEngine,
    release: drop,
  }
}
