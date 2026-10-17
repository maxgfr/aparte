/*
 * Argon2id (RFC 9106, version 0x13) for the keyslot layer. In the app each derivation runs in its own module worker
 * (src/workers/argon2.worker.ts), started through createWorker, so a 64 MiB, multi-second hash never blocks the UI.
 * Under `bun test`, which has no DOM worker to load a Vite chunk into, it runs in-process on the same code.
 *
 * The worker and its URL are imported dynamically and only on the worker path: core stays free of DOM modules at
 * load time, and the test runtime never resolves the Vite-only `?worker&url` specifier.
 */
import { type Argon2Fn, type Argon2Input, type Bytes, InvalidInputError } from '../contracts/crypto.ts'
import { type Argon2Request, type Argon2Response, checkArgon2Request, computeArgon2id } from './argon2Wasm.ts'
import { copy, zero } from './bytes.ts'

/** True only under Bun (the test runtime); the browser build always takes the worker path. */
const inProcess = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'

/** Rebuilds the error a worker reported, keeping its code when it is one of ours. */
function workerError(response: Extract<Argon2Response, { ok: false }>): Error {
  if (response.code === 'invalid-input') return new InvalidInputError(response.message)
  return new Error(`Argon2 worker failed: ${response.message}`)
}

async function inWorker(request: Argon2Request): Promise<Bytes> {
  const [{ createWorker }, { default: url }] = await Promise.all([
    import('../../security/workers.ts'),
    import('../../workers/argon2.worker.ts?worker&url'),
  ])
  const worker = createWorker(url, { name: 'argon2' })
  try {
    return await new Promise<Bytes>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<Argon2Response>) => {
        const response = event.data
        if (response.ok) {
          resolve(copy(response.tag))
          zero(response.tag)
        } else reject(workerError(response))
      }
      worker.onerror = (event: ErrorEvent) => {
        event.preventDefault()
        reject(new Error(`Argon2 worker failed: ${event.message}`))
      }
      worker.onmessageerror = () => reject(new Error('Argon2 worker sent an unreadable message'))
      // The copies are transferred, so no second copy of the password stays behind on this side.
      const transfer = [request.password.buffer, request.salt.buffer]
      if (request.secret) transfer.push(request.secret.buffer)
      worker.postMessage(request, transfer as Transferable[])
    })
  } finally {
    worker.terminate()
  }
}

export const argon2id: Argon2Fn = async (input: Argon2Input): Promise<Bytes> => {
  checkArgon2Request(input)
  // Private copies: the caller's arrays are never transferred, detached or zeroed.
  const request: Argon2Request = {
    password: copy(input.password),
    salt: copy(input.salt),
    secret: input.secret ? copy(input.secret) : undefined,
    m: input.m,
    t: input.t,
    p: input.p,
    length: input.length,
  }
  try {
    return inProcess ? await computeArgon2id(request) : await inWorker(request)
  } finally {
    // After a transfer these are detached and zeroing is a no-op; otherwise this clears the local copies.
    zero(request.password, request.salt, request.secret)
  }
}
