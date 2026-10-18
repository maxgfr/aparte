import { describe, expect, test } from 'bun:test'
import { seededRng } from '../../crypto/rng.ts'
import { faultyStore } from './faulty.ts'
import { MemoryBucket, memoryStore } from './memory.ts'
import { remoteContract } from './remote.contract.ts'

remoteContract('memory', async () => {
  const bucket = new MemoryBucket()
  return { store: memoryStore(bucket), again: () => memoryStore(bucket) }
})

remoteContract('faulty memory, with no fault armed', async () => {
  const bucket = new MemoryBucket()
  return { store: faultyStore(memoryStore(bucket)), again: () => memoryStore(bucket) }
})

describe('the adversarial bucket', () => {
  test('hides, damages, rolls back', async () => {
    const bucket = new MemoryBucket()
    const store = memoryStore(bucket)
    await store.put('fmt/1', new Uint8Array([1, 2, 3]))
    const snapshot = bucket.snapshot()
    await store.put('keys/aaaaaaaaaaaaaaaaaaaaaaaaaa.json', new Uint8Array([4]))
    store.hide((name) => name.startsWith('keys/'))
    expect((await store.list()).map((e) => e.name)).toEqual(['fmt/1'])
    expect(await store.get({ name: 'keys/aaaaaaaaaaaaaaaaaaaaaaaaaa.json' })).toBeNull()
    store.hide(null)
    expect(bucket.corrupt('fmt/1')).toBe(true)
    expect(bucket.read('fmt/1')).not.toEqual(new Uint8Array([1, 2, 3]))
    bucket.restore(snapshot)
    expect(bucket.names()).toEqual(['fmt/1'])
    expect(bucket.read('fmt/1')).toEqual(new Uint8Array([1, 2, 3]))
  })

  test('random faults are deterministic for a seed', async () => {
    const run = async () => {
      const f = faultyStore(memoryStore(new MemoryBucket()))
      f.randomly(seededRng(4), { 'put-before': 0.5 })
      const out: boolean[] = []
      for (let i = 0; i < 20; i++)
        out.push(
          await f.put(`x${i}`, new Uint8Array([i])).then(
            () => true,
            () => false,
          ),
        )
      return out
    }
    expect(await run()).toEqual(await run())
  })
})
