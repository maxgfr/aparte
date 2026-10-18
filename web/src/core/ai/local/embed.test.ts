import { describe, expect, test } from 'bun:test'
import {
  connectEmbedder,
  EMBED_BATCH,
  type EmbedBackend,
  type EmbedWorkerLike,
  normalize,
  serveEmbedder,
  similarity,
} from './embed.ts'

/** A worker pair over structured clone, as postMessage does, serving `backend`. */
function start(backend: EmbedBackend) {
  const toWorker = new Set<(e: { data?: unknown }) => void>()
  const toPage = new Set<(e: { data?: unknown }) => void>()
  let terminated = false
  const send = (to: typeof toWorker, data: unknown) => {
    const copy = structuredClone(data)
    queueMicrotask(() => {
      if (!terminated) for (const l of to) l({ data: copy })
    })
  }
  serveEmbedder({ postMessage: (m) => send(toPage, m), addEventListener: (_t, l) => toWorker.add(l) }, backend)
  const worker: EmbedWorkerLike = {
    postMessage: (m) => send(toWorker, m),
    addEventListener: (type, l) => {
      if (type === 'message') toPage.add(l)
    },
    terminate: () => {
      terminated = true
    },
  }
  return worker
}

/** A deterministic "model": a 3-dimensional vector from the text's letters. */
const letters: EmbedBackend = {
  async embed(texts) {
    return texts.map((t) => normalize(new Float32Array([t.length, (t.match(/a/g) ?? []).length + 1, 1])))
  },
}

describe('embedder', () => {
  test('one unit vector per text, in order, across batches', async () => {
    let calls = 0
    const counting: EmbedBackend = {
      embed: async (texts) => {
        calls++
        return letters.embed(texts)
      },
    }
    let started = 0
    const embedder = connectEmbedder(() => {
      started++
      return start(counting)
    })
    const texts = Array.from({ length: EMBED_BATCH + 3 }, (_, i) => 'a'.repeat(i + 1))
    const vectors = await embedder.embed(texts)
    expect(vectors).toHaveLength(texts.length)
    for (const v of vectors) expect(Math.abs(similarity(v, v) - 1)).toBeLessThan(1e-5)
    expect(calls).toBe(2)
    expect(started).toBe(1)
    const [a, b] = await embedder.embed(['banana', 'banana'])
    expect(similarity(a as Float32Array, b as Float32Array)).toBeCloseTo(1, 5)
    embedder.dispose()
  })

  test('the worker’s failure rejects; a malformed answer is refused', async () => {
    const failing = connectEmbedder(() =>
      start({
        embed: async () => {
          throw new Error('model missing')
        },
      }),
    )
    await expect(failing.embed(['x'])).rejects.toThrow('model missing')
    const short = connectEmbedder(() => start({ embed: async () => [] }))
    await expect(short.embed(['x'])).rejects.toThrow('wrong number')
  })

  test('an aborted request rejects', async () => {
    const slow = connectEmbedder(() => start({ embed: () => new Promise(() => {}) }))
    const controller = new AbortController()
    const pending = slow.embed(['x'], controller.signal)
    controller.abort()
    await expect(pending).rejects.toBeDefined()
  })

  test('normalize and similarity', () => {
    expect([...normalize(new Float32Array([3, 4]))]).toEqual([0.6000000238418579, 0.800000011920929])
    expect([...normalize(new Float32Array([0, 0]))]).toEqual([0, 0])
    expect(() => similarity(new Float32Array(2), new Float32Array(3))).toThrow(RangeError)
  })
})
