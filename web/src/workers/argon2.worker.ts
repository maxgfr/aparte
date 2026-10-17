/*
 * Argon2id off the main thread. One worker runs one derivation: it receives the request, answers once and is
 * terminated by the caller, so the Argon2 memory (64 MiB by default) is released with it. The worker zeroes its copy
 * of the password, salt and secret before answering.
 */
import { type Argon2Request, type Argon2Response, computeArgon2id } from '../core/crypto/argon2Wasm.ts'
import { zero } from '../core/crypto/bytes.ts'

const scope = globalThis as unknown as DedicatedWorkerGlobalScope

scope.onmessage = async (event: MessageEvent<Argon2Request>) => {
  const request = event.data
  let response: Argon2Response
  let transfer: Transferable[] = []
  try {
    const tag = await computeArgon2id(request)
    response = { ok: true, tag }
    transfer = [tag.buffer]
  } catch (error) {
    const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : null
    response = { ok: false, code, message: error instanceof Error ? error.message : String(error) }
  } finally {
    zero(request?.password, request?.salt, request?.secret)
  }
  scope.postMessage(response, transfer)
}
