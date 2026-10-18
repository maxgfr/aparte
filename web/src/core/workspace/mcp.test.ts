/*
 * The MCP servers of the workspace (`mcp` map of the index, spec/DATA-MODEL.md section 3.5): validation, fixed
 * prefixes, tool choices, the trash, change notices, and secrets refused.
 */
import { describe, expect, test } from 'bun:test'
import { InvalidInputError } from '../contracts/crypto.ts'
import { reopen, setup } from './testkit.ts'

const SERVER = {
  name: 'GitHub',
  prefix: 'github',
  transport: 'http',
  url: 'https://api.example.org/mcp',
  auth: 'oauth',
} as const

describe('MCP servers', () => {
  test('create, read, update, list by name, trash; kept encrypted across a reopen', async () => {
    const ctx = await setup()
    let notices = 0
    ctx.ws.subscribe('mcp', () => notices++)
    const id = ctx.ws.mcp.create(SERVER)
    const b = ctx.ws.mcp.create({ ...SERVER, name: 'Atlas', prefix: 'atlas', auth: 'none', enabled: false })
    expect(ctx.ws.mcp.get(id)).toMatchObject({ ...SERVER, id, enabled: true, tools: [] })
    expect(ctx.ws.mcp.list().map((s) => s.name)).toEqual(['Atlas', 'GitHub'])
    ctx.ws.mcp.update(id, {
      name: 'GH',
      tools: [
        { name: 'z.tool', enabled: false, fingerprint: 'f2' },
        { name: 'get_token', enabled: true, fingerprint: 'f1' },
      ],
    })
    expect(ctx.ws.mcp.get(id)?.tools.map((t) => t.name)).toEqual(['get_token', 'z.tool'])
    expect(Object.isFrozen(ctx.ws.mcp.get(id))).toBe(true)
    ctx.ws.mcp.trash(b)
    expect(ctx.ws.mcp.list().map((s) => s.id)).toEqual([id])
    expect(ctx.ws.mcp.get(b)?.deletedAt).toBeNumber()
    expect(notices).toBe(4)
    await ctx.ws.flush()
    const again = await reopen(ctx.store, ctx.clock)
    expect(again.mcp.get(id)).toMatchObject({ name: 'GH', prefix: 'github' })
  })

  test('refuses malformed fields, a taken prefix, a fixed prefix, insecure or credentialed URLs and secrets', async () => {
    const { ws } = await setup()
    const id = ws.mcp.create(SERVER)
    const bad: unknown[] = [
      { ...SERVER, prefix: 'github' },
      { ...SERVER, prefix: 'Bad' },
      { ...SERVER, prefix: '1abc' },
      { ...SERVER, prefix: 'b', transport: 'stdio' },
      { ...SERVER, prefix: 'c', auth: 'magic' },
      { ...SERVER, prefix: 'd', url: 'http://example.org/mcp' },
      { ...SERVER, prefix: 'e', url: 'https://user:pass@example.org/mcp' },
      { ...SERVER, prefix: 'f', url: 'https://example.org/mcp?key=1' },
      { ...SERVER, prefix: 'g', name: '   ' },
      { ...SERVER, prefix: 'h', token: 'x' },
      { ...SERVER, prefix: 'i', name: 'sk-ant-api03-abcdefghijklmnopqrstuv' },
    ]
    for (const input of bad) expect(() => ws.mcp.create(input as never)).toThrow(InvalidInputError)
    expect(() => ws.mcp.update(id, { prefix: 'other' } as never)).toThrow(InvalidInputError)
    expect(() => ws.mcp.update(id, { tools: [{ name: 'a', enabled: 'yes', fingerprint: 'f' }] } as never)).toThrow(
      InvalidInputError,
    )
    expect(() =>
      ws.mcp.update(id, {
        tools: [
          { name: 'a', enabled: true, fingerprint: 'f' },
          { name: 'a', enabled: false, fingerprint: 'g' },
        ],
      }),
    ).toThrow(InvalidInputError)
    expect(() => ws.mcp.update('nope', { name: 'x' })).toThrow(InvalidInputError)
    // Loopback http is fine (a local server or the CLI bridge).
    expect(() => ws.mcp.create({ ...SERVER, prefix: 'local', url: 'http://127.0.0.1:7777/mcp' })).not.toThrow()
  })
})
