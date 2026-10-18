/*
 * Which pinned model suits this device, ranked by llm-models (its extract of the WebLLM catalog, with published memory
 * figures and benchmark scores). Loaded by the model screen only: it carries that catalog.
 */
import { type BrowserModel, listBrowserModels, recommendBrowserModel } from 'llm-models/browser'
import type { DeviceVerdict, PinnedModel } from '../../contracts/local.ts'
import { pinnedModel } from './catalog.ts'

export interface Recommendation {
  /** The best pinned model for this device, or null when none fits. */
  readonly model: PinnedModel | null
  /** llm-models' explanation of the pick, in English. */
  readonly reason: string
}

/**
 * The pinned model llm-models ranks best for this GPU (memory budget, fp16, storage bindings); null when none fits.
 * Only pinned ids are ranked: the catalog lists builds this app does not pin.
 */
export function recommend(gpu: DeviceVerdict, catalog: readonly BrowserModel[] = listBrowserModels()): Recommendation {
  if (!gpu.supported) return { model: null, reason: '' }
  const pinned = catalog.filter((m) => pinnedModel(m.id) !== undefined)
  const ranked = recommendBrowserModel(
    {
      vram_budget_mb: gpu.gpu.memoryBudgetMB,
      shader_f16: gpu.gpu.shaderF16,
      low_resource: gpu.gpu.lowResource,
    },
    pinned,
  )
  const model = ranked ? (pinnedModel(ranked.model.id) ?? null) : null
  return { model, reason: ranked?.reason ?? '' }
}
