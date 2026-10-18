import { describe, expect, test } from 'bun:test'
import type { SyncAlarm } from '../contracts/sync.ts'
import { parseName } from '../crypto/names.ts'
import { FakeClock } from '../workspace/testkit.ts'
import { MAX_BAD, WITHHOLD_MS } from './engine.ts'
import { MemoryBucket } from './providers/memory.ts'
import { device } from './testkit.ts'

/*
 * The anti-rollback rules of spec/FORMAT.md section 10.3, each played by a server that misbehaves on purpose:
 * rollback (force push), withheld segments, unreturned claims, forks, tampered objects, and trust on first use.
 */

const kinds = (alarms: readonly SyncAlarm[]) => alarms.map((a) => a.kind)

/** Names of the segments a bucket holds, with their parsed seq and device. */
const segments = (bucket: MemoryBucket) =>
  bucket
    .names()
    .map((name) => ({ name, parsed: parseName(name) }))
    .filter((x) => x.parsed?.type === 'segment') as {
    name: string
    parsed: { dtag: string; seq: number; stag: string }
  }[]

describe('rollback', () => {
  test('a store that goes back below what it listed raises the alarm, keeps local data, and is repaired', async () => {
    const bucket = new MemoryBucket()
    const a = await device(bucket)
    const b = await device(bucket)
    a.ws.conversations.create({ title: 'one' })
    await a.sync()
    const before = bucket.snapshot()
    const later = a.ws.conversations.create({ title: 'two' })
    await a.sync()
    await b.sync()
    expect(b.ws.conversations.get(later)?.title).toBe('two')

    bucket.restore(before) // a force push to an older state
    await b.sync()
    expect(kinds(b.engine.status().alarms)).toContain('rollback')
    // Nothing local is lost, and the device puts back what the store dropped.
    expect(b.ws.conversations.get(later)?.title).toBe('two')
    const c = await device(bucket)
    await c.sync()
    expect(c.ws.conversations.get(later)?.title).toBe('two')
  })

  test("a device's own segments count: dropping them after upload is a rollback too", async () => {
    const bucket = new MemoryBucket()
    const a = await device(bucket)
    a.ws.conversations.create({ title: 'mine' })
    await a.sync()
    const own = segments(bucket)
    expect(own.length).toBe(1)
    for (const { name } of own) bucket.remove(name)
    await a.sync()
    expect(kinds(a.engine.status().alarms)).toContain('rollback')
    expect(segments(bucket).length).toBe(1)
  })

  test('a dismissed alarm stays dismissed for the same finding', async () => {
    const bucket = new MemoryBucket()
    const a = await device(bucket)
    a.ws.conversations.create({ title: 'mine' })
    await a.sync()
    const snapshot = bucket.snapshot()
    a.ws.conversations.create({ title: 'more' })
    await a.sync()
    bucket.restore(snapshot)
    await a.sync()
    const [alarm] = a.engine.status().alarms
    expect(alarm?.kind).toBe('rollback')
    await a.engine.dismissAlarm(alarm?.id as string)
    expect(a.engine.status().alarms).toEqual([])
    bucket.restore(snapshot)
    await a.sync()
    expect(a.engine.status().alarms.filter((x) => x.id === alarm?.id)).toEqual([])
  })
})

describe('withholding', () => {
  test('a gap that persists across listings 10 minutes apart raises `withheld`; a passing one does not', async () => {
    const bucket = new MemoryBucket()
    const clock = new FakeClock()
    const a = await device(bucket, { clock })
    const b = await device(bucket, { clock })
    for (const title of ['1', '2', '3']) {
      a.ws.conversations.create({ title })
      await a.sync()
    }
    const second = segments(bucket).find((s) => s.parsed.seq === 2)?.name as string
    b.remote.hide((name) => name === second)
    await b.sync()
    expect(b.engine.status().alarms).toEqual([])
    clock.tick(WITHHOLD_MS - 1000)
    await b.sync()
    expect(b.engine.status().alarms).toEqual([])
    clock.tick(2000)
    await b.sync()
    expect(kinds(b.engine.status().alarms)).toEqual(['withheld'])
    // Once the store returns it, the gap closes and the data arrives.
    b.remote.hide(null)
    await b.sync()
    expect(
      await b.ws.conversations
        .list()
        .map((c) => c.title)
        .sort(),
    ).toEqual(['1', '2', '3'])
  })

  test('a segment another device has seen but the store never returns raises `unreturned`', async () => {
    const bucket = new MemoryBucket()
    const clock = new FakeClock()
    const a = await device(bucket, { clock })
    const b = await device(bucket, { clock })
    a.ws.conversations.create({ title: 'from A' })
    await a.sync()
    await b.sync()
    b.ws.conversations.create({ title: 'from B' })
    await b.sync() // B's segment says it has seen A's seq 1

    const aTag = await a.engine.deviceTag()
    const c = await device(bucket, { clock })
    c.remote.hide((name) => parseName(name)?.type === 'segment' && name.includes(`/s/${aTag}/`))
    await c.sync() // trust on first use: nothing to compare yet
    expect(c.engine.status().alarms).toEqual([])
    clock.tick(WITHHOLD_MS + 1000)
    await c.sync()
    expect(kinds(c.engine.status().alarms)).toContain('unreturned')
  })

  test('trust on first use: a new device that is never shown some data cannot tell', async () => {
    const bucket = new MemoryBucket()
    const clock = new FakeClock()
    const a = await device(bucket, { clock })
    a.ws.conversations.create({ title: 'hidden' })
    await a.sync()
    const c = await device(bucket, { clock })
    c.remote.hide((name) => parseName(name)?.type === 'segment')
    await c.sync()
    clock.tick(WITHHOLD_MS * 3)
    await c.sync()
    expect(c.engine.status().alarms).toEqual([])
  })
})

describe('forks', () => {
  test('a clone writing under the same device tag is found: the device takes a new id', async () => {
    const bucket = new MemoryBucket()
    const id = crypto.getRandomValues(new Uint8Array(16))
    const a = await device(bucket, { deviceId: id })
    const clone = await device(bucket, { deviceId: id })
    const tag = await a.engine.deviceTag()
    a.ws.conversations.create({ title: 'original' })
    await a.sync()
    clone.ws.conversations.create({ title: 'clone' })
    await clone.sync()
    expect(kinds(clone.engine.status().alarms)).toContain('fork')
    expect(await clone.engine.deviceTag()).not.toBe(tag)
    // A third device sees two segments for one (doc, device, seq).
    const c = await device(bucket)
    await c.sync()
    expect(kinds(c.engine.status().alarms)).toContain('fork')
    expect(
      c.ws.conversations
        .list()
        .map((x) => x.title)
        .sort(),
    ).toEqual(['clone', 'original'])
  })
})

describe('tampering', () => {
  test('an object that does not authenticate is never stored or applied, and raises `tampered` after retries', async () => {
    const bucket = new MemoryBucket()
    const a = await device(bucket)
    const b = await device(bucket)
    a.ws.conversations.create({ title: 'x' })
    await a.sync()
    const [seg] = segments(bucket)
    bucket.corrupt(seg?.name as string, 40)
    for (let i = 0; i < MAX_BAD; i++) await b.sync()
    expect(kinds(b.engine.status().alarms)).toContain('tampered')
    expect(await b.store.objects.get(seg?.name as string)).toBeNull()
    expect(b.ws.conversations.list()).toEqual([])
  })

  test('an object moved to another name does not open there', async () => {
    const bucket = new MemoryBucket()
    const a = await device(bucket)
    const b = await device(bucket)
    a.ws.conversations.create({ title: 'one' })
    await a.sync()
    a.ws.conversations.create({ title: 'two' })
    await a.sync()
    const [first, second] = segments(bucket).sort((x, y) => x.parsed.seq - y.parsed.seq)
    // The server serves the first segment's bytes under the second's name.
    bucket.write(second?.name as string, bucket.read(first?.name as string) as Uint8Array)
    for (let i = 0; i < MAX_BAD; i++) await b.sync()
    expect(b.ws.conversations.list().map((c) => c.title)).toEqual(['one'])
    expect(kinds(b.engine.status().alarms)).toContain('tampered')
  })
})
