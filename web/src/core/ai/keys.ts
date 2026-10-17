/*
 * Device-only provider keys (ProviderKeysModule in web/src/core/contracts/ai.ts). A key is a `provider-key` local
 * record under the provider id whose value is the UTF-8 JSON of spec/DATA-MODEL.md section 6, sealed by the vault's
 * LocalStore: it is never in plaintext at rest, never in a Yjs document and never logged.
 */
import type { ProviderKeys, ProviderSecret } from '../contracts/ai.ts'
import { InvalidInputError, TamperedError } from '../contracts/crypto.ts'
import type { LocalStore } from '../contracts/store.ts'

const PURPOSE = 'provider-key'

/** Surrounding whitespace or any control character: a key pasted with a newline or a stray space. */
const MALFORMED = /^\s|\s$|\p{Cc}/u

function checkKey(key: string): void {
  if (key.length === 0) throw new InvalidInputError('The API key is empty')
  if (MALFORMED.test(key)) throw new InvalidInputError('The API key has surrounding spaces or control characters')
}

function checkProviderId(providerId: string): void {
  if (providerId.length === 0) throw new InvalidInputError('The provider id is empty')
}

/** The key of a decrypted record. The record authenticated, so a wrong shape means it was not written by us. */
function parseSecret(providerId: string, bytes: Uint8Array): string {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (cause) {
    throw new TamperedError('The provider key record is not a key', { cause })
  }
  const secret = value as Partial<ProviderSecret> | null
  if (
    secret === null ||
    typeof secret !== 'object' ||
    secret.kind !== 'api-key' ||
    secret.provider !== providerId ||
    typeof secret.key !== 'string'
  ) {
    throw new TamperedError('The provider key record is not a key')
  }
  return secret.key
}

export function createProviderKeys(store: LocalStore): ProviderKeys {
  return {
    async get(providerId) {
      checkProviderId(providerId)
      const bytes = await store.get(PURPOSE, providerId)
      return bytes === null ? null : parseSecret(providerId, bytes)
    },
    async set(providerId, key) {
      checkProviderId(providerId)
      checkKey(key)
      const secret: ProviderSecret = { kind: 'api-key', provider: providerId, key }
      await store.put(PURPOSE, providerId, new TextEncoder().encode(JSON.stringify(secret)))
    },
    async delete(providerId) {
      checkProviderId(providerId)
      await store.delete(PURPOSE, providerId)
    },
    list() {
      return store.list(PURPOSE)
    },
  }
}
