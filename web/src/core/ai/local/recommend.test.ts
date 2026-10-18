import { describe, expect, test } from 'bun:test'
import { recommend } from './recommend.ts'

const gpu = (memoryBudgetMB: number, shaderF16 = true, lowResource = false) => ({
  supported: true as const,
  gpu: { vendor: '', shaderF16, deviceMemoryGiB: null, memoryBudgetMB, lowResource },
})

describe('recommend', () => {
  test('a pinned model that fits the budget, in the build the GPU runs', () => {
    const big = recommend(gpu(8192)).model
    expect(big).not.toBeNull()
    expect(big?.vramMB).toBeLessThanOrEqual(8192)
    const small = recommend(gpu(1024, false)).model
    expect(small).not.toBeNull()
    expect(small?.vramMB).toBeLessThanOrEqual(1024)
    expect(small?.f16).toBe(false)
    for (const m of [recommend(gpu(2048, true, true)).model]) expect(m?.lowResource).toBe(true)
  })

  test('nothing fits a tiny budget or an unsupported device', () => {
    expect(recommend(gpu(100)).model).toBeNull()
    expect(recommend({ supported: false, reason: 'no-webgpu' }).model).toBeNull()
  })
})
