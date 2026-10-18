/*
 * Image turns (web/src/core/contracts/media.ts) over the real workspace: the prompt and the answer are committed once
 * each, the image is stored as a blob of its prepared bytes, the lock and reload holds span the turn, a failure or a
 * stop is committed with its status, and nothing is written for a turn that cannot start.
 */
import { describe, expect, test } from 'bun:test'
import { InvalidInputError, InvalidStateError } from '../contracts/crypto.ts'
import { type GeneratedImage, type ImageTurnDeps, MediaError } from '../contracts/media.ts'
import type { BlobPort, ModelRef } from '../contracts/workspace.ts'
import { cryptoRng } from '../crypto/rng.ts'
import { eventually, setup } from '../workspace/testkit.ts'
import { createImageTurns } from './imageTurn.ts'

const MODEL: ModelRef = { provider: 'pg', id: 'gemini-2.5-flash-image' }
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

function memoryBlobs(): BlobPort & { readonly stored: Map<string, Uint8Array> } {
  const stored = new Map<string, Uint8Array>()
  return {
    stored,
    async put(bytes) {
      const id = `m${stored.size + 1}`
      stored.set(id, new Uint8Array(bytes))
      return id
    },
    async get(id) {
      const b = stored.get(id)
      return b === undefined ? null : new Uint8Array(b)
    },
  }
}

interface Harness {
  readonly deps: ImageTurnDeps
  readonly holds: string[]
  readonly released: string[]
  readonly blobs: ReturnType<typeof memoryBlobs>
  readonly prompts: string[]
  release(): void
}

async function harness(
  generate?: (signal: AbortSignal) => Promise<GeneratedImage>,
): Promise<Harness & { ws: Awaited<ReturnType<typeof setup>>['ws'] }> {
  const { ws, clock } = await setup()
  const holds: string[] = []
  const released: string[] = []
  const blobs = memoryBlobs()
  const prompts: string[] = []
  let gate: () => void = () => undefined
  const waiting = new Promise<void>((resolve) => {
    gate = resolve
  })
  const deps: ImageTurnDeps = {
    workspace: ws,
    blobs,
    holdLock: (reason) => {
      holds.push(`lock:${reason}`)
      return () => released.push(`lock:${reason}`)
    },
    holdReload: (reason) => {
      holds.push(`reload:${reason}`)
      return () => released.push(`reload:${reason}`)
    },
    generate: async (_model, prompt, signal) => {
      prompts.push(prompt)
      if (generate) return generate(signal)
      await waiting
      return { bytes: PNG, mediaType: 'image/png' }
    },
    prepare: async (image) => ({
      bytes: new Uint8Array([...image.bytes, 0xff]),
      mediaType: 'image/webp',
      width: 8,
      height: 6,
    }),
    rng: cryptoRng(),
    clock,
  }
  return { ws, deps, holds, released, blobs, prompts, release: () => gate() }
}

describe('image turns', () => {
  test('commit the prompt, then the stored image, holding the lock and the reload meanwhile', async () => {
    const h = await harness()
    const turns = createImageTurns(h.deps)
    const conv = h.ws.conversations.create({ model: MODEL })
    const seen: string[] = []
    turns.subscribe((id) => seen.push(id))
    const done = turns.run(conv, '  A lighthouse at dusk  ', MODEL)
    await eventually(() => turns.state(conv) !== null)
    expect(h.holds).toEqual(['lock:image-turn', 'reload:image-turn'])
    expect(h.released).toEqual([])
    expect(turns.running()).toEqual([conv])
    const thread = await h.ws.thread(conv)
    expect(thread.path().map((m) => m.role)).toEqual(['user'])
    expect(h.ws.conversations.get(conv)?.title).toBe('A lighthouse at dusk')
    h.release()
    await done
    expect(turns.state(conv)).toBeNull()
    expect(turns.running()).toEqual([])
    expect(h.released.sort()).toEqual(['lock:image-turn', 'reload:image-turn'])
    expect(h.prompts).toEqual(['A lighthouse at dusk'])
    const [user, answer] = thread.path()
    expect(user?.parts).toEqual([{ type: 'text', text: 'A lighthouse at dusk' }])
    expect(answer?.role).toBe('assistant')
    expect(answer?.status).toBe('done')
    expect(answer?.model).toEqual(MODEL)
    const part = answer?.parts[0]
    expect(part).toMatchObject({ type: 'image', mediaType: 'image/webp', width: 8, height: 6 })
    // Only the prepared bytes are stored.
    const stored = h.blobs.stored.get((part as { blob: string }).blob)
    expect([...(stored ?? [])]).toEqual([...PNG, 0xff])
    expect(seen.filter((id) => id === conv).length).toBeGreaterThanOrEqual(2)
  })

  test('a provider failure is committed as an error answer with its code', async () => {
    const h = await harness(async () => {
      throw new MediaError({ code: 'rate-limit', message: 'Slow down', retryable: true })
    })
    const turns = createImageTurns(h.deps)
    const conv = h.ws.conversations.create({ model: MODEL })
    await turns.run(conv, 'A cat', MODEL)
    const answer = (await h.ws.thread(conv)).path()[1]
    expect(answer?.status).toBe('error')
    expect(answer?.parts).toEqual([])
    expect(answer?.error).toEqual({ code: 'rate-limit', message: 'Slow down' })
    expect(h.released.sort()).toEqual(['lock:image-turn', 'reload:image-turn'])
  })

  test('an image the device cannot read is an error too', async () => {
    const h = await harness(async () => ({ bytes: PNG, mediaType: 'image/png' }))
    const turns = createImageTurns({ ...h.deps, prepare: async () => Promise.reject(new Error('decode')) })
    const conv = h.ws.conversations.create({ model: MODEL })
    await turns.run(conv, 'A cat', MODEL)
    expect((await h.ws.thread(conv)).path()[1]?.error).toEqual({ code: 'image-unreadable', message: '' })
    expect(h.blobs.stored.size).toBe(0)
  })

  test('stop and dispose commit the answer as stopped', async () => {
    const h = await harness(
      (signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError'))),
        ),
    )
    const turns = createImageTurns(h.deps)
    const conv = h.ws.conversations.create({ model: MODEL })
    const done = turns.run(conv, 'A dog', MODEL)
    await eventually(() => turns.state(conv) !== null)
    await expect(turns.run(conv, 'Another', MODEL)).rejects.toBeInstanceOf(InvalidStateError)
    turns.stop(conv)
    await done
    expect((await h.ws.thread(conv)).path()[1]?.status).toBe('stopped')

    const second = turns.run(conv, 'A bird', MODEL)
    await eventually(() => turns.state(conv) !== null)
    await turns.dispose()
    await second
    const path = (await h.ws.thread(conv)).path()
    expect(path.map((m) => m.status)).toEqual(['done', 'stopped', 'done', 'stopped'])
    await expect(turns.run(conv, 'After the lock', MODEL)).rejects.toBeInstanceOf(InvalidStateError)
  })

  test('writes nothing for a turn that cannot start', async () => {
    const h = await harness()
    const turns = createImageTurns(h.deps)
    const conv = h.ws.conversations.create({ model: MODEL })
    await expect(turns.run(conv, '   ', MODEL)).rejects.toBeInstanceOf(InvalidInputError)
    await expect(turns.run('aaaaaaaaaaaaaaaaaaaaaaaaaa', 'x', MODEL)).rejects.toBeInstanceOf(InvalidInputError)
    const locking = createImageTurns({
      ...h.deps,
      holdLock: () => {
        throw new InvalidStateError('locking')
      },
    })
    await expect(locking.run(conv, 'x', MODEL)).rejects.toBeInstanceOf(InvalidStateError)
    expect((await h.ws.thread(conv)).all()).toHaveLength(0)
    expect(h.holds).toEqual([])
  })
})
