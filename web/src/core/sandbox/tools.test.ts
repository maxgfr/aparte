import { describe, expect, test } from 'bun:test'
import type { RunRequest, RunResult, SandboxRunner } from '../contracts/sandbox.ts'
import type { ToolContext } from '../contracts/tools.ts'
import { utf8 } from '../crypto/bytes.ts'
import { autoApproved } from '../tools/policy.ts'
import { createToolRegistry } from '../tools/registry.ts'
import { artifactOfFence, artifactOfFile, hasScripts } from './artifacts.ts'
import { type ConversationFile, runJsTool, runPythonTool, runResult, sandboxTools } from './tools.ts'

const ok = (over: Partial<RunResult> = {}): RunResult => ({
  status: 'ok',
  stdout: '',
  stderr: '',
  truncated: false,
  files: [],
  images: [],
  packages: [],
  durationMs: 5,
  ...over,
})

function fakeRunner(answer: (request: RunRequest) => RunResult | Promise<RunResult> = () => ok()) {
  const requests: RunRequest[] = []
  const runner: SandboxRunner = {
    async run(request, signal) {
      requests.push(request)
      if (signal.aborted) throw Object.assign(new Error('stopped'), { name: 'AbortError' })
      return answer(request)
    },
    reset() {},
  }
  return { runner, requests }
}

const context = (signal = new AbortController().signal): ToolContext => ({
  conversationId: 'c'.repeat(26),
  callId: 'call_1',
  signal,
})

const photo: ConversationFile = {
  name: 'image-1.jpg',
  mediaType: 'image/jpeg',
  size: 3,
  read: async () => new Uint8Array([1, 2, 3]),
}

describe('the sandbox tools', () => {
  test('are sandbox tools that change things but stay on this device, and never run unasked', async () => {
    const { runner } = fakeRunner()
    const registry = createToolRegistry()
    for (const tool of sandboxTools({ runner })) await registry.register(tool)
    expect(registry.list().map((r) => [r.tool.name, r.approvalKey])).toEqual([
      ['run_js', 'sandbox:javascript:run_js'],
      ['run_python', 'sandbox:python:run_python'],
    ])
    for (const r of registry.list()) {
      expect(r.tool.annotations).toEqual({ readOnly: false, destructive: false, openWorld: false })
      expect(autoApproved(r.tool)).toBe(false)
    }
  })

  test('run_js passes the code, the time limit and the files named', async () => {
    const { runner, requests } = fakeRunner()
    const tool = runJsTool({ runner, files: async () => [photo] })
    const result = await tool.execute({ code: 'return 1', files: ['image-1.jpg'], timeout_seconds: 5 }, context())
    expect(result.isError).toBeUndefined()
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ language: 'javascript', code: 'return 1', limits: { timeoutMs: 5000 } })
    expect(requests[0]?.files?.map((f) => [f.name, f.mediaType, [...f.data]])).toEqual([
      ['image-1.jpg', 'image/jpeg', [1, 2, 3]],
    ])
  })

  test('run_python passes the packages asked for', async () => {
    const { runner, requests } = fakeRunner()
    await runPythonTool({ runner }).execute({ code: 'print(1)', packages: ['scikit-learn', 'scikit-learn'] }, context())
    expect(requests[0]).toMatchObject({ language: 'python', packages: ['scikit-learn'] })
  })

  test.each([
    [{}, 'Missing "code"'],
    [{ code: '   ' }, 'Missing "code"'],
    [{ code: 'x', files: 'a.csv' }, '"files" must be a list'],
    [{ code: 'x', timeout_seconds: 0 }, '"timeout_seconds"'],
    [{ code: 'x', timeout_seconds: 10_000 }, '"timeout_seconds"'],
    [null, 'must be an object'],
  ])('bad arguments %p are an error for the model, and nothing runs', async (input, message) => {
    const { runner, requests } = fakeRunner()
    const result = await runPythonTool({ runner }).execute(input, context())
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain(message)
    expect(requests).toHaveLength(0)
  })

  test('a file the conversation does not have is named with what it has', async () => {
    const { runner, requests } = fakeRunner()
    const result = await runJsTool({ runner, files: async () => [photo] }).execute(
      { code: 'x', files: ['secret.txt'] },
      context(),
    )
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('Available: "image-1.jpg"')
    expect(requests).toHaveLength(0)
  })

  test('an abort rejects, as every tool does', async () => {
    const { runner } = fakeRunner()
    const controller = new AbortController()
    controller.abort()
    await expect(runJsTool({ runner }).execute({ code: 'x' }, context(controller.signal))).rejects.toThrow()
  })

  test('a refused request is an error result', async () => {
    const tool = runJsTool({
      runner: {
        run: async () => {
          throw new Error('Not a plain file name')
        },
        reset() {},
      },
    })
    const result = await tool.execute({ code: 'x' }, context())
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('Not a plain file name')
  })
})

describe('runResult', () => {
  test('a JSON summary, then figures and image files as images, other files as files', () => {
    const png = { name: 'chart.png', mediaType: 'image/png', data: new Uint8Array([137, 80]) }
    const csv = { name: 'out.csv', mediaType: 'text/csv', data: utf8('a,b\n') }
    const figure = { name: 'figure-1.png', mediaType: 'image/png', data: new Uint8Array([1]) }
    const result = runResult(
      'python',
      ok({ stdout: 'hi\n', value: '42', files: [png, csv], images: [figure], packages: ['numpy'] }),
    )
    expect(result.isError).toBeUndefined()
    const [summary, ...rest] = result.content
    expect(summary).toEqual({
      type: 'json',
      value: {
        status: 'ok',
        note: 'The code ran to its end.',
        stdout: 'hi\n',
        value: '42',
        files: [
          { name: 'chart.png', mediaType: 'image/png', bytes: 2 },
          { name: 'out.csv', mediaType: 'text/csv', bytes: 4 },
        ],
        figures: ['figure-1.png'],
        packages: ['numpy'],
      },
    })
    expect(rest.map((c) => c.type)).toEqual(['image', 'image', 'file'])
    expect(rest[2]).toMatchObject({ type: 'file', name: 'out.csv', mediaType: 'text/csv' })
    expect(result.details).toEqual({ sandbox: { language: 'python', status: 'ok', durationMs: 5 } })
  })

  test('any status but ok is an error, with the reason in words', () => {
    for (const status of ['error', 'timeout', 'memory', 'cancelled', 'crashed', 'unavailable'] as const) {
      const result = runResult('javascript', ok({ status, error: 'boom' }))
      expect(result.isError).toBe(true)
      const value = (result.content[0] as unknown as { value: { note: string; error: string } }).value
      expect(value.note.length).toBeGreaterThan(10)
      expect(value.error).toBe('boom')
    }
  })
})

describe('artifacts', () => {
  test('fences that become artifacts', () => {
    expect(artifactOfFence('html', '<p>hi</p>')).toEqual({ kind: 'html', source: '<p>hi</p>' })
    expect(artifactOfFence('svg', '<svg viewBox="0 0 1 1"></svg>')?.kind).toBe('svg')
    expect(artifactOfFence('xml', '<?xml version="1.0"?>\n<svg></svg>')?.kind).toBe('svg')
    expect(artifactOfFence('xml', '<note></note>')).toBeNull()
    expect(artifactOfFence('mermaid', 'graph TD; A-->B')?.kind).toBe('mermaid')
    expect(artifactOfFence('html', 'just text')).toBeNull()
    expect(artifactOfFence('js', 'alert(1)')).toBeNull()
    expect(artifactOfFence('html', '   ')).toBeNull()
  })

  test('files that become artifacts', () => {
    expect(artifactOfFile('text/html', '<p>x</p>')?.kind).toBe('html')
    expect(artifactOfFile('image/svg+xml', '<svg/>')?.kind).toBe('svg')
    expect(artifactOfFile('text/csv', 'a,b')).toBeNull()
  })

  test('scripts are detected so Run is offered', () => {
    expect(hasScripts({ kind: 'html', source: '<p>hi</p>' })).toBe(false)
    expect(hasScripts({ kind: 'html', source: '<SCRIPT>x()</SCRIPT>' })).toBe(true)
    expect(hasScripts({ kind: 'html', source: '<img src=x onerror=alert(1)>' })).toBe(true)
    expect(hasScripts({ kind: 'html', source: '<a href="javascript:x()">' })).toBe(true)
    expect(
      hasScripts({ kind: 'html', source: '<meta http-equiv="refresh" content="0;url=https://evil.example">' }),
    ).toBe(true)
    expect(hasScripts({ kind: 'svg', source: '<svg onload="x()"></svg>' })).toBe(true)
    expect(hasScripts({ kind: 'mermaid', source: 'graph TD; A-->B; click A callback "x"' })).toBe(false)
  })
})
