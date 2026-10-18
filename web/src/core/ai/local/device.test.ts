import { describe, expect, test } from 'bun:test'
import { checkSpace, detectDevice, modelFit, RESERVE_MIN_BYTES, UNKNOWN_MEMORY_BUDGET_MB } from './device.ts'
import { fakeGpu } from './fakes.ts'

const MiB = 1024 * 1024
const GiB = 1024 * MiB

describe('detectDevice', () => {
  test('no WebGPU, no adapter', async () => {
    expect(await detectDevice({})).toEqual({ supported: false, reason: 'no-webgpu' })
    expect(await detectDevice({ gpu: fakeGpu({ adapter: false }) })).toEqual({ supported: false, reason: 'no-adapter' })
  })

  test('a failing adapter request is no adapter', async () => {
    const gpu = { requestAdapter: async () => Promise.reject(new Error('lost')) }
    expect(await detectDevice({ gpu })).toEqual({ supported: false, reason: 'no-adapter' })
  })

  test('the budget follows the reported RAM, else the phone default', async () => {
    const known = await detectDevice({ gpu: fakeGpu(), deviceMemory: 8 })
    expect(known.supported && known.gpu.memoryBudgetMB).toBe(4096)
    const unknown = await detectDevice({ gpu: fakeGpu() })
    expect(unknown.supported && unknown.gpu.memoryBudgetMB).toBe(UNKNOWN_MEMORY_BUDGET_MB)
  })

  test('limits below WebLLM minimums are too little memory', async () => {
    const v = await detectDevice({ gpu: fakeGpu({ maxStorageBufferBindingSize: 64 * MiB }) })
    expect(v.supported).toBe(false)
    expect(!v.supported && v.reason).toBe('too-little-memory')
  })

  test('small storage bindings mark low resource; shader-f16 is read', async () => {
    const v = await detectDevice({ gpu: fakeGpu({ maxStorageBufferBindingSize: 256 * MiB, shaderF16: false }) })
    expect(v.supported && v.gpu.lowResource).toBe(true)
    expect(v.supported && v.gpu.shaderF16).toBe(false)
  })
})

describe('modelFit', () => {
  const gpu = { vendor: '', shaderF16: true, deviceMemoryGiB: 8, memoryBudgetMB: 4096, lowResource: false }
  test('fits, or why not', () => {
    expect(modelFit({ vramMB: 1000, f16: true, lowResource: true }, gpu)).toBeNull()
    expect(modelFit({ vramMB: 5000, f16: true, lowResource: true }, gpu)).toBe('memory')
    expect(modelFit({ vramMB: 1000, f16: true, lowResource: true }, { ...gpu, shaderF16: false })).toBe('f16')
    expect(modelFit({ vramMB: 1000, f16: false, lowResource: false }, { ...gpu, lowResource: true })).toBe(
      'storage-binding',
    )
  })
})

describe('checkSpace', () => {
  test('no estimate means no', () => {
    expect(checkSpace(null, 1, 0)).toEqual({ ok: false, reason: 'unknown' })
    expect(checkSpace({ usage: 1 }, 1, 0)).toEqual({ ok: false, reason: 'unknown' })
  })

  test('keeps at least 1 GiB, or what the vault uses, free after the download', () => {
    const quota = 10 * GiB
    expect(checkSpace({ usage: 0, quota }, quota - RESERVE_MIN_BYTES, 0).ok).toBe(true)
    expect(checkSpace({ usage: 0, quota }, quota - RESERVE_MIN_BYTES + 1, 0).ok).toBe(false)
    // 3 GiB used, of which 1 GiB is this model already: the vault's 2 GiB is the reserve.
    const v = checkSpace({ usage: 3 * GiB, quota }, 4 * GiB, GiB)
    expect(v).toEqual({ ok: true, needBytes: 4 * GiB, freeBytes: 7 * GiB })
    expect(checkSpace({ usage: 3 * GiB, quota }, 5 * GiB + 1, GiB).ok).toBe(false)
  })
})
