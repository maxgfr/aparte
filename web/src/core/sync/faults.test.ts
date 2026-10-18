import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import { RemoteError } from '../contracts/sync.ts'
import { seededRng } from '../crypto/rng.ts'
import { FakeClock, msg } from '../workspace/testkit.ts'
import { type FaultyStore, faultyStore } from './providers/faulty.ts'
import { MemoryBucket } from './providers/memory.ts'
import { type Device, device, indexJson, newId, shardJson } from './testkit.ts'

/*
 * Injected faults (a store that loses, damages or refuses things) and a randomized simulation of devices writing and
 * syncing against a server that drops objects, rolls back and fails requests: once the faults stop, every device ends
 * with the same documents, and nothing a device wrote is ever lost.
 */

async function faulty(bucket: MemoryBucket, clock = new FakeClock()): Promise<{ dev: Device; faults: FaultyStore }> {
  let faults: FaultyStore | null = null
  const dev = await device(bucket, {
    clock,
    remote: (inner) => {
      faults = faultyStore(inner, { retryAfterMs: 30_000 })
      return faults
    },
  })
  return { dev, faults: faults as unknown as FaultyStore }
}

describe('injected faults', () => {
  test('a put the store lost is sent again by the next round', async () => {
    const bucket = new MemoryBucket()
    const { dev: a, faults } = await faulty(bucket)
    const b = await device(bucket)
    faults.inject('put-lost', 2)
    // The marker and the keyslot are confirmed by a listing: their loss fails the round, the next one sends them.
    await expect(a.sync()).rejects.toMatchObject({ kind: 'network' })
    await a.sync()
    const conv = a.ws.conversations.create({ title: 'lost once' })
    faults.inject('put-lost')
    await a.sync()
    await b.sync()
    expect(b.ws.conversations.get(conv)).toBeUndefined()
    await a.sync()
    await b.sync()
    expect(b.ws.conversations.get(conv)?.title).toBe('lost once')
  })

  test('a put that failed after storing, and a failing listing, only delay the round', async () => {
    const bucket = new MemoryBucket()
    const { dev: a, faults } = await faulty(bucket)
    a.ws.conversations.create({ title: 'x' })
    faults.inject('put-after')
    await expect(a.sync()).rejects.toBeInstanceOf(RemoteError)
    expect(a.engine.status().dests[0]?.state).toBe('backoff')
    faults.inject('list-fail')
    await expect(a.sync()).rejects.toMatchObject({ kind: 'network' })
    await a.sync()
    expect(a.engine.status().dests[0]).toMatchObject({ state: 'idle', queued: 0 })
  })

  test('rate limits, expired credentials and a full store each show as their own state', async () => {
    const bucket = new MemoryBucket()
    const { dev: a, faults } = await faulty(bucket)
    a.ws.conversations.create({ title: 'x' })
    faults.inject('rate-limit')
    await expect(a.sync()).rejects.toMatchObject({ kind: 'rate-limited', retryAfterMs: 30_000 })
    expect(a.engine.status().dests[0]?.state).toBe('backoff')
    faults.inject('auth')
    await expect(a.sync()).rejects.toMatchObject({ kind: 'auth' })
    expect(a.engine.status().dests[0]?.state).toBe('needs-auth')
    faults.inject('quota')
    await expect(a.sync()).rejects.toMatchObject({ kind: 'quota' })
    expect(a.engine.status().dests[0]?.state).toBe('error')
    await a.sync()
    expect(a.engine.status().dests[0]?.state).toBe('idle')
  })

  test('a damaged read is refused once and the next round reads the good copy', async () => {
    const bucket = new MemoryBucket()
    const a = await device(bucket)
    const { dev: b, faults } = await faulty(bucket)
    a.ws.conversations.create({ title: 'first' })
    await a.sync()
    await b.sync()
    const conv = a.ws.conversations.create({ title: 'read twice' })
    await a.sync()
    faults.inject('get-corrupt', 50)
    await b.sync()
    expect(b.ws.conversations.get(conv)).toBeUndefined()
    faults.heal()
    await b.sync()
    expect(b.ws.conversations.get(conv)?.title).toBe('read twice')
    expect(b.engine.status().alarms).toEqual([])
  })
})

const ops = fc.array(
  fc.oneof(
    {
      weight: 4,
      arbitrary: fc.record({
        type: fc.constant('write' as const),
        device: fc.nat(2),
        text: fc.string({ maxLength: 8 }),
      }),
    },
    { weight: 5, arbitrary: fc.record({ type: fc.constant('sync' as const), device: fc.nat(2) }) },
    { weight: 1, arbitrary: fc.record({ type: fc.constant('drop' as const), pick: fc.nat() }) },
    { weight: 1, arbitrary: fc.record({ type: fc.constant('snapshot' as const) }) },
    { weight: 1, arbitrary: fc.record({ type: fc.constant('rollback' as const) }) },
    { weight: 1, arbitrary: fc.record({ type: fc.constant('flaky' as const), device: fc.nat(2), seed: fc.nat() }) },
  ),
  { minLength: 5, maxLength: 24 },
)

describe('simulation against an adversarial server', () => {
  test('devices converge once the faults stop, and none loses what it wrote', async () => {
    await fc.assert(
      fc.asyncProperty(ops, async (script) => {
        const bucket = new MemoryBucket()
        const clock = new FakeClock()
        const devices = await Promise.all([0, 1, 2].map(() => faulty(bucket, clock)))
        const wrote: Map<number, Set<string>> = new Map([0, 1, 2].map((i) => [i, new Set()]))
        let snapshot = bucket.snapshot()
        for (const op of script) {
          clock.tick(1000)
          if (op.type === 'write') {
            const { dev } = devices[op.device] as { dev: Device }
            const conv = dev.ws.conversations.create({ title: `d${op.device}:${op.text}` })
            const thread = await dev.ws.thread(conv)
            thread.commit(msg(newId(), null, 'user', op.text))
            wrote.get(op.device)?.add(conv)
          } else if (op.type === 'sync') {
            await devices[op.device]?.dev.sync().catch((e) => {
              if (!(e instanceof RemoteError)) throw e
            })
          } else if (op.type === 'drop') {
            const names = bucket.names()
            if (names.length > 0) bucket.remove(names[op.pick % names.length] as string)
          } else if (op.type === 'snapshot') {
            snapshot = bucket.snapshot()
          } else if (op.type === 'rollback') {
            bucket.restore(snapshot)
          } else {
            devices[op.device]?.faults.randomly(seededRng(op.seed), {
              'put-lost': 0.1,
              'put-after': 0.1,
              'get-fail': 0.1,
              'get-corrupt': 0.1,
              'list-fail': 0.1,
              'rate-limit': 0.05,
            })
          }
          // A device never loses what it wrote, whatever the server does.
          for (const [i, convs] of wrote) {
            const ws = devices[i]?.dev.ws
            for (const conv of convs) expect(ws?.conversations.get(conv)).toBeDefined()
          }
        }
        for (const d of devices) d.faults.heal()
        for (let pass = 0; pass < 2; pass++) for (const d of devices) await d.dev.sync()
        const [first, ...rest] = devices.map((d) => d.dev)
        const reference = await indexJson((first as Device).ws)
        for (const other of rest) expect(await indexJson(other.ws)).toEqual(reference)
        for (const conv of [...wrote.values()].flatMap((s) => [...s])) {
          const shard = await (first as Device).ws.conversations.shardOf(conv)
          const expected = await shardJson((first as Device).ws, shard)
          for (const other of rest) expect(await shardJson(other.ws, shard)).toEqual(expected)
        }
      }),
      { numRuns: 25 },
    )
  }, 120_000)
})
