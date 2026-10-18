/* The device-only MCP secrets (secrets.ts): sealed records, what can be stored, and records of another shape. */
import { describe, expect, test } from 'bun:test'
import { InvalidInputError, TamperedError } from '../contracts/crypto.ts'
import { setup } from '../workspace/testkit.ts'
import { createMcpSecrets, recordId } from './secrets.ts'

describe('MCP secrets', () => {
  test('round trip, sealed under the oauth-token purpose', async () => {
    const { store } = await setup()
    const secrets = createMcpSecrets(store)
    await secrets.set('srv', { kind: 'headers', headers: { 'X-Api-Token': 'value-canary' } })
    expect(await secrets.get('srv')).toEqual({ kind: 'headers', headers: { 'x-api-token': 'value-canary' } })
    expect(await store.list('oauth-token')).toEqual([recordId('srv')])
    await secrets.delete('srv')
    expect(await secrets.get('srv')).toBeNull()
  })

  test('refuses what a request cannot carry', async () => {
    const { store } = await setup()
    const secrets = createMcpSecrets(store)
    for (const bad of [
      { kind: 'bearer', token: '' },
      { kind: 'bearer', token: ' padded' },
      { kind: 'bearer', token: 'line\nbreak' },
      { kind: 'headers', headers: {} },
      { kind: 'headers', headers: { Cookie: 'a' } },
      { kind: 'headers', headers: { 'Bad Name': 'a' } },
      { kind: 'headers', headers: { 'mcp-session-id': 'a' } },
      { kind: 'headers', headers: { a: 'b', A: 'c' } },
      { kind: 'oauth', client: { clientId: 'x' } },
      { kind: 'other' },
    ]) {
      await expect(secrets.set('srv', bad as never)).rejects.toBeInstanceOf(InvalidInputError)
    }
  })

  test('a record of another server or shape is tampering', async () => {
    const { store } = await setup()
    const secrets = createMcpSecrets(store)
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v))
    await store.put(
      'oauth-token',
      recordId('a'),
      enc({ kind: 'mcp-auth', server: 'b', auth: { kind: 'bearer', token: 't' } }),
    )
    await expect(secrets.get('a')).rejects.toBeInstanceOf(TamperedError)
    await store.put(
      'oauth-token',
      recordId('a'),
      enc({ kind: 'mcp-auth', server: 'a', auth: { kind: 'bearer', token: '' } }),
    )
    await expect(secrets.get('a')).rejects.toBeInstanceOf(TamperedError)
  })
})
