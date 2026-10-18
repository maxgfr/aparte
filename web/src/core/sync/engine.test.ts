import { describe, expect, test } from 'bun:test'
import { parseName } from '../crypto/names.ts'
import { msg } from '../workspace/testkit.ts'
import { FMT_NAME } from './engine.ts'
import { MemoryBucket, type MemoryStore } from './providers/memory.ts'
import { device, fakeKeyslots, indexJson, newId, noise, shardJson } from './testkit.ts'

/** Every name the bucket holds is an aparte/1 name. */
function onlyFormatNames(bucket: MemoryBucket): void {
  for (const name of bucket.names()) expect(parseName(name), name).not.toBeNull()
}

describe('two devices', () => {
  test('converge on conversations and messages, both ways', async () => {
    const bucket = new MemoryBucket()
    const a = await device(bucket)
    const b = await device(bucket)

    const conv = a.ws.conversations.create({ title: 'From A' })
    const thread = await a.ws.thread(conv)
    const first = newId()
    thread.commit(msg(first, null, 'user', 'hello from A'))
    thread.setLeaf(first)
    const upA = await a.sync()
    expect(upA.up).toBeGreaterThan(0)
    onlyFormatNames(bucket)
    expect(bucket.names()).toContain(FMT_NAME)
    expect(bucket.names().filter((n) => n.startsWith('keys/'))).toHaveLength(1)

    const downB = await b.sync()
    expect(downB.down).toBeGreaterThan(0)
    expect(b.ws.conversations.get(conv)?.title).toBe('From A')
    const threadB = await b.ws.thread(conv)
    expect(threadB.path().map((m) => m.parts)).toEqual([[{ type: 'text', text: 'hello from A' }]])

    // B answers; A sees it.
    const reply = newId()
    threadB.commit(msg(reply, first, 'assistant', 'hello from B'))
    threadB.setLeaf(reply)
    b.ws.conversations.update(conv, { title: 'Renamed on B' })
    await b.sync()
    await a.sync()
    expect(a.ws.conversations.get(conv)?.title).toBe('Renamed on B')
    expect((await a.ws.thread(conv)).path().map((m) => m.id)).toEqual([first, reply])
    expect(await indexJson(a.ws)).toEqual(await indexJson(b.ws))
    const shard = await a.ws.conversations.shardOf(conv)
    expect(await shardJson(a.ws, shard)).toEqual(await shardJson(b.ws, shard))
  })

  test('a round with nothing new uploads nothing and downloads nothing', async () => {
    const bucket = new MemoryBucket()
    const a = await device(bucket)
    a.ws.conversations.create({ title: 'x' })
    await a.sync()
    const before = bucket.names()
    expect(await a.sync()).toEqual({ down: 0, up: 0, deferred: 0 })
    expect(bucket.names()).toEqual(before)
  })

  test('what a device received survives a reload: the workspace replays the mirror', async () => {
    const bucket = new MemoryBucket()
    const a = await device(bucket)
    const b = await device(bucket)
    const conv = a.ws.conversations.create({ title: 'Kept' })
    await a.sync()
    await b.sync()
    await b.reload()
    expect(b.ws.conversations.get(conv)?.title).toBe('Kept')
    // A's own sealed changes too: the pending queue was sealed into a segment and replays from the mirror.
    await a.reload()
    expect(a.ws.conversations.get(conv)?.title).toBe('Kept')
    expect((await a.store.pending.list('index')).length).toBeLessThanOrEqual(1)
  })

  test('sealing keeps queue positions growing and never seals the same records twice', async () => {
    const bucket = new MemoryBucket()
    const a = await device(bucket)
    a.ws.conversations.create({ title: '1' })
    await a.ws.flush()
    expect(await a.engine.seal()).toBe(1)
    expect(await a.engine.seal()).toBe(0)
    const anchor = (await a.store.pending.list('index')).at(-1)?.n ?? 0
    a.ws.conversations.create({ title: '2' })
    await a.ws.flush()
    expect((await a.store.pending.list('index')).at(-1)?.n).toBe(anchor + 1)
    expect(await a.engine.seal()).toBe(1)
    const own = (await a.store.objects.names('d/')).filter((n) => parseName(n)?.type === 'segment')
    expect(own.map((n) => (parseName(n) as { seq: number }).seq).sort()).toEqual([1, 2])
  })

  test('photos travel as 2 MiB chunks and a manifest, uploaded before the segment that shows them', async () => {
    const bucket = new MemoryBucket()
    const order: string[] = []
    const a = await device(bucket, {
      remote: (inner) => ({
        ...inner,
        put: async (name, bytes) => {
          order.push(name)
          await inner.put(name, bytes)
        },
      }),
    })
    const b = await device(bucket)
    const photo = noise(5 * 1024 * 1024 + 17, 7)
    const blob = await a.blobs.put(photo, 'image/jpeg')
    const conv = a.ws.conversations.create({ title: 'Photo' })
    const thread = await a.ws.thread(conv)
    const id = newId()
    thread.commit(
      msg(id, null, 'user', 'look', { parts: [{ type: 'image', blob, mediaType: 'image/jpeg', width: 4, height: 3 }] }),
    )
    await a.sync()

    const chunks = order.filter((n) => n.startsWith('b/'))
    const manifest = order.findIndex((n) => n.startsWith('m/'))
    const segment = order.findIndex((n) => parseName(n)?.type === 'segment' && n.startsWith('d/'))
    expect(chunks).toHaveLength(3)
    expect(Math.max(...chunks.map((c) => order.indexOf(c)))).toBeLessThan(manifest)
    expect(order.indexOf(FMT_NAME)).toBe(0)
    expect(order.findIndex((n) => n.startsWith('keys/'))).toBeLessThan(manifest)
    expect(manifest).toBeLessThan(segment)

    await b.sync()
    expect(await b.blobs.get(blob)).toEqual(photo)
    const parts = (await b.ws.thread(conv)).get(id)?.parts
    expect(parts?.[0]).toMatchObject({ type: 'image', blob })
  })

  test('fifty photos from one device reach the other', async () => {
    const bucket = new MemoryBucket()
    const a = await device(bucket)
    const b = await device(bucket)
    const conv = a.ws.conversations.create({ title: 'Album' })
    const thread = await a.ws.thread(conv)
    const ids: string[] = []
    let parent: string | null = null
    for (let i = 0; i < 50; i++) {
      const blob = await a.blobs.put(noise(40_000 + i, i + 1), 'image/jpeg')
      ids.push(blob)
      const id = newId()
      thread.commit(
        msg(id, parent, 'user', `photo ${i}`, {
          parts: [{ type: 'image', blob, mediaType: 'image/jpeg', width: 1, height: 1 }],
        }),
      )
      parent = id
    }
    await a.sync()
    await b.sync()
    for (const [i, blob] of ids.entries()) expect(await b.blobs.get(blob)).toEqual(noise(40_000 + i, i + 1))
    expect((await b.ws.thread(conv)).all()).toHaveLength(50)
  })

  test('nothing readable reaches the store: no text, title or key in any object but the marker and keyslots', async () => {
    const bucket = new MemoryBucket()
    const a = await device(bucket)
    const canary = `canary-${crypto.randomUUID()}`
    const conv = a.ws.conversations.create({ title: `title ${canary}` })
    const thread = await a.ws.thread(conv)
    thread.commit(msg(newId(), null, 'user', `message ${canary}`))
    await a.blobs.put(new TextEncoder().encode(`photo ${canary}`), 'image/png')
    await a.sync()
    for (const name of bucket.names()) {
      const text = new TextDecoder('latin1').decode(bucket.read(name) as Uint8Array)
      expect(text.includes(canary), name).toBe(false)
      expect(name.includes(canary)).toBe(false)
    }
  })

  test('a third device relays objects between two stores', async () => {
    const one = new MemoryBucket()
    const two = new MemoryBucket()
    const a = await device(one)
    const c = await device(two)
    const bridge = await device(one)
    const { memoryStore } = await import('./providers/memory.ts')
    const second: MemoryStore = memoryStore(two, { id: 'second' })
    bridge.engine.addDestination(second, 'second')
    const conv = a.ws.conversations.create({ title: 'Relayed' })
    await a.sync()
    await bridge.sync()
    await bridge.ws.flush()
    await bridge.engine.round('second')
    await c.sync()
    expect(c.ws.conversations.get(conv)?.title).toBe('Relayed')
  })
})

describe('keyslots and the format marker', () => {
  test('a slot another device added comes in; one of another vault stops the destination', async () => {
    const bucket = new MemoryBucket()
    const slotA = 'a'.repeat(26)
    const slotB = `${'b'.repeat(25)}a`
    const a = await device(bucket, { keyslots: fakeKeyslots(undefined, [slotA]) })
    const b = await device(bucket, { keyslots: fakeKeyslots(undefined, [slotB]) })
    await a.sync()
    await b.sync()
    expect(b.keyslots.all.map((f) => f.name).sort()).toEqual([`keys/${slotA}.json`, `keys/${slotB}.json`])
    await a.sync()
    expect(a.keyslots.all).toHaveLength(2)

    const other = await device(bucket, { keyslots: fakeKeyslots('2'.repeat(25).concat('a'), [`${'c'.repeat(25)}a`]) })
    await expect(other.sync()).rejects.toMatchObject({ kind: 'incompatible' })
    expect(other.engine.status().dests[0]?.state).toBe('error')
  })

  test('a store of another format is refused before anything is written to it', async () => {
    const bucket = new MemoryBucket()
    bucket.write(FMT_NAME, new TextEncoder().encode('aparte/2\n'))
    const a = await device(bucket)
    a.ws.conversations.create({ title: 'x' })
    await expect(a.sync()).rejects.toMatchObject({ kind: 'incompatible' })
    expect(bucket.names()).toEqual([FMT_NAME])
  })
})

describe('checkpoints', () => {
  test('a loaded document gets a checkpoint; a new device starts from it and needs only later segments', async () => {
    const bucket = new MemoryBucket()
    const a = await device(bucket, { engine: { checkpointEvery: 4 } })
    for (let i = 0; i < 5; i++) {
      a.ws.conversations.create({ title: `c${i}` })
      await a.sync()
    }
    const checkpoints = bucket.names().filter((n) => parseName(n)?.type === 'checkpoint')
    expect(checkpoints.length).toBeGreaterThanOrEqual(1)
    a.ws.conversations.create({ title: 'after' })
    await a.sync()

    const c = await device(bucket)
    await c.sync()
    expect(await indexJson(c.ws)).toEqual(await indexJson(a.ws))
    const fetched = (await c.store.objects.names('d/')).filter((n) => parseName(n)?.type === 'segment')
    const all = bucket.names().filter((n) => parseName(n)?.type === 'segment')
    expect(fetched.length).toBeLessThan(all.length)
    await c.reload()
    expect(await indexJson(c.ws)).toEqual(await indexJson(a.ws))
  })
})

describe('the vault lock', () => {
  test('a round holds the vault lock while it runs; a locking vault starts no round', async () => {
    const bucket = new MemoryBucket()
    const holds: string[] = []
    let released = 0
    let locking = false
    const a = await device(bucket, {
      engine: {
        hold: (reason) => {
          if (locking) throw new Error('locking')
          holds.push(reason)
          return () => {
            released++
          }
        },
      },
    })
    a.ws.conversations.create({ title: 'held' })
    await a.sync()
    expect(holds).toEqual(['sync'])
    expect(released).toBe(1)
    locking = true
    await expect(a.sync()).rejects.toMatchObject({ code: 'locked' })
    expect(a.engine.status().dests[0]?.state).toBe('idle')
  })
})
