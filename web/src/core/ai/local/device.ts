/*
 * Whether this device can run an in-browser model, and whether a download fits. WebGPU exposes no memory figure, so
 * the budget is estimated from the RAM Chromium reports, or from the smallest device the app targets.
 */
import type {
  DeviceVerdict,
  GpuLike,
  GpuReport,
  PinnedModel,
  SpaceVerdict,
  StorageEstimate,
} from '../../contracts/local.ts'

const MiB = 1024 * 1024
const GiB = 1024 * MiB

/**
 * WebLLM refuses to start below these adapter limits (`detectGPUDevice`: 1 GiB buffers wanted, falling back to
 * 256 MiB buffers and 128 MiB storage bindings, 32 KiB of workgroup storage); below 1 GiB storage bindings only its
 * low-resource builds load.
 */
export const WEBLLM_MIN_BUFFER = 256 * MiB
export const WEBLLM_MIN_STORAGE_BINDING = 128 * MiB
export const WEBLLM_MIN_WORKGROUP_STORAGE = 32 * 1024
export const WEBLLM_FULL_STORAGE_BINDING = GiB
/** Share of RAM a model may take when the browser reports RAM (Apple GPUs share it with the system). */
export const GPU_SHARE_OF_RAM = 0.5
/** Budget when RAM is unknown (Safari never says): sized for a phone, whose pages are killed long before RAM is full. */
export const UNKNOWN_MEMORY_BUDGET_MB = 2048

export interface DetectEnv {
  readonly gpu?: GpuLike | undefined
  /** `navigator.deviceMemory`, in GiB (Chromium only). */
  readonly deviceMemory?: number | undefined
}

export async function detectDevice(env: DetectEnv): Promise<DeviceVerdict> {
  if (!env.gpu) return { supported: false, reason: 'no-webgpu' }
  let adapter: Awaited<ReturnType<GpuLike['requestAdapter']>>
  try {
    adapter = await env.gpu.requestAdapter({ powerPreference: 'high-performance' })
  } catch {
    adapter = null
  }
  if (!adapter) return { supported: false, reason: 'no-adapter' }
  const limits = adapter.limits
  const memory = typeof env.deviceMemory === 'number' && env.deviceMemory > 0 ? env.deviceMemory : null
  const gpu: GpuReport = {
    vendor: adapter.info?.vendor ?? '',
    shaderF16: adapter.features.has('shader-f16'),
    deviceMemoryGiB: memory,
    memoryBudgetMB: memory === null ? UNKNOWN_MEMORY_BUDGET_MB : Math.floor(memory * 1024 * GPU_SHARE_OF_RAM),
    lowResource: limits.maxStorageBufferBindingSize < WEBLLM_FULL_STORAGE_BINDING,
  }
  if (
    limits.maxBufferSize < WEBLLM_MIN_BUFFER ||
    limits.maxStorageBufferBindingSize < WEBLLM_MIN_STORAGE_BINDING ||
    limits.maxComputeWorkgroupStorageSize < WEBLLM_MIN_WORKGROUP_STORAGE
  ) {
    return { supported: false, reason: 'too-little-memory', gpu }
  }
  return { supported: true, gpu }
}

/** Why a pinned model would not run on this GPU, or null when it should. */
export function modelFit(
  model: Pick<PinnedModel, 'vramMB' | 'f16' | 'lowResource'>,
  gpu: GpuReport,
): 'memory' | 'f16' | 'storage-binding' | null {
  if (model.f16 && !gpu.shaderF16) return 'f16'
  if (gpu.lowResource && !model.lowResource) return 'storage-binding'
  if (model.vramMB > gpu.memoryBudgetMB) return 'memory'
  return null
}

/** After a download, the origin keeps at least this much free for the vault, or as much as it already uses. */
export const RESERVE_MIN_BYTES = GiB

/**
 * Whether `remainingBytes` fits: the vault shares the origin's quota, and a full quota would stop new changes from
 * being saved, so the free space after the download must still hold what the vault uses (and never less than 1 GiB).
 * Without an estimate nothing proves the space is there, so the answer is no.
 */
export function checkSpace(
  estimate: StorageEstimate | null,
  remainingBytes: number,
  cachedModelBytes: number,
): SpaceVerdict {
  if (!estimate || typeof estimate.usage !== 'number' || typeof estimate.quota !== 'number' || estimate.quota <= 0) {
    return { ok: false, reason: 'unknown' }
  }
  const freeBytes = Math.max(0, estimate.quota - estimate.usage)
  const reserve = Math.max(RESERVE_MIN_BYTES, Math.max(0, estimate.usage - cachedModelBytes))
  const needBytes = Math.max(0, remainingBytes)
  if (freeBytes - needBytes < reserve) return { ok: false, reason: 'not-enough-space', needBytes, freeBytes }
  return { ok: true, needBytes, freeBytes }
}
