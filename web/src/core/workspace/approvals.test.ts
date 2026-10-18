/*
 * The tool approvals of the workspace (contracts/tools.ts `ToolApprovals`, spec/DATA-MODEL.md section 3.4): one key per
 * approval in the index document, kept encrypted across a reopen, tool snapshot sources, and the change notices.
 */
import { describe, expect, test } from 'bun:test'
import { InvalidInputError } from '../contracts/crypto.ts'
import { newId, reopen, setup } from './testkit.ts'

describe('tool approvals', () => {
  test('grant, look up by scope, list "always" first, revoke', async () => {
    const { ws } = await setup()
    const conv = newId()
    let notices = 0
    ws.subscribe('toolApprovals', () => notices++)
    ws.toolApprovals.grant({ approvalKey: 'mcp:srv:b', fingerprint: 'f1', conversation: conv })
    ws.toolApprovals.grant({ approvalKey: 'builtin:-:a', fingerprint: 'f2', conversation: null })
    expect(ws.toolApprovals.get('mcp:srv:b', conv)).toMatchObject({ fingerprint: 'f1', conversation: conv })
    expect(ws.toolApprovals.get('mcp:srv:b', null)).toBeUndefined()
    expect(ws.toolApprovals.get('mcp:srv:b', newId())).toBeUndefined()
    expect(ws.toolApprovals.list().map((a) => [a.approvalKey, a.conversation])).toEqual([
      ['builtin:-:a', null],
      ['mcp:srv:b', conv],
    ])
    // A new grant for a new fingerprint replaces the old one.
    ws.toolApprovals.grant({ approvalKey: 'builtin:-:a', fingerprint: 'f3', conversation: null })
    expect(ws.toolApprovals.get('builtin:-:a', null)?.fingerprint).toBe('f3')
    ws.toolApprovals.revoke('builtin:-:a', null)
    ws.toolApprovals.revoke('builtin:-:a', null)
    expect(ws.toolApprovals.get('builtin:-:a', null)).toBeUndefined()
    expect(notices).toBe(4)
    expect(Object.isFrozen(ws.toolApprovals.list())).toBe(true)
  })

  test('refuses malformed approvals', async () => {
    const { ws } = await setup()
    expect(() => ws.toolApprovals.grant({ approvalKey: '', fingerprint: 'f', conversation: null })).toThrow(
      InvalidInputError,
    )
    expect(() => ws.toolApprovals.grant({ approvalKey: 'k', fingerprint: 'f', conversation: 'not-an-id' })).toThrow(
      InvalidInputError,
    )
  })

  test('survive a reopen of the encrypted queue', async () => {
    const { ws, store, clock } = await setup()
    ws.toolApprovals.grant({ approvalKey: 'mcp:canary-server:tool', fingerprint: 'fp-canary', conversation: null })
    await ws.flush()
    ws.close()
    const again = await reopen(store, clock)
    expect(again.toolApprovals.get('mcp:canary-server:tool', null)?.fingerprint).toBe('fp-canary')
  })

  test('a snapshot may hold sandbox tools and the provider web search', async () => {
    const { ws } = await setup()
    const conv = ws.conversations.create({
      tools: [
        { name: 'web_search', source: 'provider', fingerprint: 'w' },
        { name: 'run_js', source: 'sandbox', origin: 'js', fingerprint: 'r' },
      ],
    })
    expect(ws.conversations.get(conv)?.tools.map((t) => t.source)).toEqual(['sandbox', 'provider'])
    expect(() =>
      ws.conversations.update(conv, { tools: [{ name: 'x', source: 'plugin' as never, fingerprint: 'f' }] }),
    ).toThrow(InvalidInputError)
  })
})
