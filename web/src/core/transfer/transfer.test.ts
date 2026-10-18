/*
 * Imports and exports (core/transfer): each importer over a fixture of its app's export (branches, dropped tool
 * messages, leaf), the Aparté file's round trip over the real workspace (tree, leaf, statuses, usage, deletions and
 * blob bytes), and the Markdown and HTML renderings (escaping, the CSP, injected parts left out).
 */
import { describe, expect, test } from 'bun:test'
import { type Bytes, InvalidInputError } from '../contracts/crypto.ts'
import type { BlobPort, Id, Message, Thread, Workspace } from '../contracts/workspace.ts'
import { utf8 } from '../crypto/bytes.ts'
import { cryptoRng } from '../crypto/rng.ts'
import { writeZip } from '../sync/providers/zip.ts'
import { msg, newId, setup } from '../workspace/testkit.ts'
import {
  applyImport,
  buildTree,
  type ExportDocument,
  type ExportLabels,
  exportConversations,
  fromChatGpt,
  fromClaude,
  fromOpenWebUi,
  importCount,
  parseImport,
  toHtml,
  toMarkdown,
} from './index.ts'

const fixture = async (name: string): Promise<unknown> =>
  JSON.parse(await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text())

/** A blob store whose ids depend on a salt, as two vaults' keyed blob ids differ. */
function memoryBlobs(salt: string): BlobPort & { readonly map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>()
  return {
    map,
    async put(bytes) {
      const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', utf8(salt + Buffer.from(bytes).toString('hex'))),
      )
      const id = Buffer.from(digest).toString('hex').slice(0, 26)
      map.set(id, new Uint8Array(bytes))
      return id
    },
    async get(id) {
      const v = map.get(id)
      return v === undefined ? null : (new Uint8Array(v) as Bytes)
    },
  }
}

const LABELS: ExportLabels = {
  untitled: 'New chat',
  you: 'You',
  system: 'System',
  reasoning: 'Reasoning',
  image: 'Photo',
  tool: 'Tool',
  sources: 'Sources',
  exported: 'Exported from Aparté',
  lang: 'en-US',
}

const texts = (path: readonly Message[]) =>
  path.map((m) => `${m.role}:${m.parts.map((p) => (p.type === 'text' ? p.text : p.type)).join('|')}`)

describe('importers', () => {
  test('ChatGPT: the mapping tree becomes branches, tool rounds and hidden messages are dropped', async () => {
    const [conv, empty] = fromChatGpt(await fixture('chatgpt.json'))
    expect(empty?.messages).toEqual([])
    if (conv === undefined) throw new Error('missing')
    expect(conv.title).toBe('Packing for Lisbon')
    expect(conv.createdAt).toBe(1760000000123)
    expect(conv.system).toBe('')
    const byKey = new Map(conv.messages.map((m) => [m.key, m]))
    // u1 and u2 are siblings (two versions of the first question), both roots once the hidden system is dropped.
    expect(byKey.get('u1')?.parent).toBeNull()
    expect(byKey.get('u2')?.parent).toBeNull()
    expect(byKey.get('u2')?.text).toBe('[image]\n\nAnd the weather in late May?')
    // The tool call and its output are gone; the answer after them answers the question.
    expect(byKey.has('c1')).toBe(false)
    expect(byKey.has('t1')).toBe(false)
    expect(byKey.get('a2')?.parent).toBe('u2')
    expect(byKey.get('a1')?.createdAt).toBe(1760000020000)
    expect(conv.leaf).toBe('a2')
    // Parents first.
    const seen = new Set<string>()
    for (const m of conv.messages) {
      if (m.parent !== null) expect(seen.has(m.parent)).toBe(true)
      seen.add(m.key)
    }
  })

  test('Claude: linear exports chain in order, trees follow parent_message_uuid', async () => {
    const [linear, branched] = fromClaude(await fixture('claude.json'))
    expect(linear?.title).toBe('Sourdough starter')
    expect(linear?.messages.map((m) => [m.role, m.text, m.parent])).toEqual([
      ['user', 'How often do I feed a starter?\n\n[attachment: jar.jpg]', null],
      ['assistant', 'Once a day at room temperature.', 'm-1'],
      ['user', 'And in the fridge?', 'm-2'],
      ['assistant', 'Once a week.', 'm-3'],
    ])
    expect(linear?.leaf).toBe('m-4')
    expect(linear?.createdAt).toBe(Date.parse('2025-10-01T08:00:00Z'))
    expect(branched?.messages.filter((m) => m.parent === null).map((m) => m.key)).toEqual(['b-1', 'b-3'])
    expect(branched?.leaf).toBe('b-4')
  })

  test('Open WebUI: the history tree with its current branch, and the older flat list', async () => {
    const [tree, flat] = fromOpenWebUi(await fixture('openwebui.json'))
    expect(tree?.messages.map((m) => [m.key, m.parent])).toEqual([
      ['q1', null],
      ['r1', 'q1'],
      ['r2', 'q1'],
    ])
    expect(tree?.leaf).toBe('r2')
    expect(tree?.messages[1]?.createdAt).toBe(1759000005000)
    expect(flat?.messages.map((m) => m.text)).toEqual(['Hello', 'Hello, how can I help?'])
    expect(flat?.leaf).toBe('x2')
  })

  test('the tree survives hostile input: cycles, unknown parents, a lone system root', () => {
    const conv = buildTree(
      [
        { key: 's', parent: null, role: 'system', text: 'Be brief.', createdAt: 1 },
        { key: 'a', parent: 'b', role: 'user', text: 'loop a', createdAt: 2 },
        { key: 'b', parent: 'a', role: 'assistant', text: 'loop b', createdAt: 3 },
        { key: 'u', parent: 's', role: 'user', text: 'Hi', createdAt: 4 },
        { key: 'x', parent: 'nowhere', role: 'assistant', text: 'orphan', createdAt: null },
        { key: 'y', parent: 'u', role: 'user', text: 'bad \ud800 surrogate', createdAt: 5 },
      ],
      'missing',
      { title: 'T', createdAt: 0 },
    )
    expect(conv.system).toBe('')
    for (const m of conv.messages) expect(m.parent === null || conv.messages.some((p) => p.key === m.parent)).toBe(true)
    expect(conv.messages.find((m) => m.key === 'y')?.text).toBe('bad � surrogate')
    expect(conv.messages.find((m) => m.key === 'x')?.parent).toBeNull()
    const single = buildTree(
      [
        { key: 's', parent: null, role: 'system', text: 'Be brief.', createdAt: 1 },
        { key: 'u', parent: 's', role: 'user', text: 'Hi', createdAt: 2 },
        { key: 'a', parent: 'u', role: 'assistant', text: 'Hello.', createdAt: 3 },
        { key: 't', parent: 'a', role: 'tool', text: 'result', createdAt: 4 },
        { key: 'a2', parent: 't', role: 'assistant', text: 'And more.', createdAt: 5 },
      ],
      null,
      { title: 'T', createdAt: 0 },
    )
    expect(single.system).toBe('Be brief.')
    expect(single.messages.map((m) => [m.key, m.parent, m.text])).toEqual([
      ['u', null, 'Hi'],
      ['a', 'u', 'Hello.\n\nAnd more.'],
    ])
    expect(single.leaf).toBe('a')
  })

  test('parseImport detects the format, reads a zip, refuses anything else', async () => {
    const bytes = utf8(JSON.stringify(await fixture('chatgpt.json')))
    const parsed = await parseImport(bytes)
    expect(parsed.source).toBe('chatgpt')
    expect(importCount(parsed)).toBe(1)
    const zipped = await parseImport(
      writeZip([
        { name: 'chat.html', bytes: utf8('<html></html>') },
        { name: 'conversations.json', bytes: utf8(JSON.stringify(await fixture('claude.json'))) },
      ]),
    )
    expect(zipped.source).toBe('claude')
    expect((await parseImport(utf8(JSON.stringify(await fixture('openwebui.json'))))).source).toBe('openwebui')
    await expect(parseImport(utf8('{"hello": 1}'))).rejects.toThrow(InvalidInputError)
    await expect(parseImport(utf8('not json'))).rejects.toThrow(InvalidInputError)
    await expect(parseImport(writeZip([{ name: 'x.txt', bytes: utf8('x') }]))).rejects.toThrow(InvalidInputError)
  })

  test('an import writes the conversation with its branches and its leaf', async () => {
    const { ws } = await setup()
    ws.settings.set('defaultSystem', 'My default prompt')
    const parsed = await parseImport(utf8(JSON.stringify(await fixture('chatgpt.json'))))
    const result = await applyImport({ workspace: ws, blobs: memoryBlobs('x'), rng: cryptoRng() }, parsed)
    expect(result.failed).toBe(0)
    expect(result.conversations).toHaveLength(1)
    const id = result.conversations[0] as Id
    const conversation = ws.conversations.get(id)
    expect(conversation?.title).toBe('Packing for Lisbon')
    // The default prompt is not slipped into an imported chat.
    expect(conversation?.system).toBe('')
    expect(conversation?.model).toBeNull()
    const thread = await ws.thread(id)
    expect(texts(thread.path())).toEqual([
      'user:[image]\n\nAnd the weather in late May?',
      'assistant:Warm days around 24 °C, cooler evenings.',
    ])
    expect(thread.children(null)).toHaveLength(2)
    expect(thread.path()[1]?.createdAt).toBe(1760000120000)
    ws.close()
  })
})

/** A conversation with branches, a photo, a stopped and an errored answer, usage, a deletion and a large part. */
async function sample(ws: Workspace, blobs: BlobPort): Promise<{ id: Id; photo: Uint8Array; leaf: Id }> {
  const id = ws.conversations.create({ title: 'Round trip', system: 'Be exact.' })
  const thread = await ws.thread(id)
  const photo = crypto.getRandomValues(new Uint8Array(3000))
  const blob = await blobs.put(photo, 'image/jpeg')
  const big = { type: 'text', text: 'x'.repeat(20_000) }
  const ref = await blobs.put(utf8(JSON.stringify(big)), 'application/vnd.aparte.part+json')
  const [u1, a1, a2, u2, a3] = [newId(), newId(), newId(), newId(), newId()]
  thread.commit({
    ...msg(u1, null, 'user', 'Look at this'),
    parts: [{ type: 'image', blob, mediaType: 'image/jpeg', width: 40, height: 30, name: 'cat.jpg' }],
    createdAt: 1000,
  })
  thread.commit({
    ...msg(a1, u1, 'assistant', 'A cat.'),
    model: { provider: 'p1', id: 'm1' },
    usage: { input: 10, output: 3 },
    status: 'stopped',
    effort: 'high',
    parts: [
      {
        type: 'reasoning',
        text: 'Looking.',
        providerMeta: { anthropic: { type: 'thinking', signature: 'c2lnbmF0dXJl' } },
      },
      { type: 'text', text: 'A cat.' },
    ],
    createdAt: 2000,
  })
  thread.commit({
    ...msg(a2, u1, 'assistant', ''),
    parts: [],
    status: 'error',
    error: { code: 'rate-limit', message: 'slow down' },
    createdAt: 3000,
  })
  thread.commit({
    ...msg(u2, a1, 'user', 'More'),
    parts: [{ type: 'ref', partType: 'text', blob: ref, size: 20_000 }],
    createdAt: 4000,
  })
  thread.commit({ ...msg(a3, u2, 'assistant', 'Done.'), createdAt: 5000 })
  thread.delete(a2)
  thread.setLeaf(a3)
  return { id, photo, leaf: a3 }
}

describe('Aparté file', () => {
  test('round trip: tree, leaf, statuses, usage, deletions, signatures and blob bytes survive', async () => {
    const source = await setup()
    const sourceBlobs = memoryBlobs('source')
    const { id, photo } = await sample(source.ws, sourceBlobs)
    const doc = await exportConversations({ workspace: source.ws, blobs: sourceBlobs, clock: source.clock }, [id])
    expect(doc.missing).toEqual([])
    // Through bytes, as the file goes.
    const parsed = await parseImport(utf8(JSON.stringify(doc)))
    expect(parsed.source).toBe('aparte')
    expect(importCount(parsed)).toBe(1)

    const target = await setup()
    const targetBlobs = memoryBlobs('target')
    const result = await applyImport({ workspace: target.ws, blobs: targetBlobs, rng: cryptoRng() }, parsed)
    expect(result).toEqual({ conversations: [expect.any(String)], failed: 0 })
    const copy = target.ws.conversations.get(result.conversations[0] as Id)
    expect(copy?.title).toBe('Round trip')
    expect(copy?.system).toBe('Be exact.')
    const before = await source.ws.thread(id)
    const after = await target.ws.thread(copy?.id as Id)
    const shape = (t: Thread) =>
      t.all().map((m) => ({
        role: m.role,
        status: m.status,
        usage: m.usage,
        error: m.error,
        effort: m.effort,
        model: m.model,
        createdAt: m.createdAt,
        deleted: m.deletedAt !== undefined,
        depth: t.path(m.id).length,
        siblings: t.siblings(m.id).messages.length,
        types: m.parts.map((p) => p.type),
      }))
    expect(shape(after)).toEqual(shape(before).map((m, i) => (i === 3 ? { ...m, types: ['text'] } : m)))
    expect(texts(after.path()).at(-1)).toBe('assistant:Done.')
    expect(after.path()).toHaveLength(4)
    // The signature is replayed byte for byte.
    expect(after.all()[1]?.parts[0]).toEqual(before.all()[1]?.parts[0] as never)
    // The photo is in the target's blob store, under the target's own id.
    const image = after.all()[0]?.parts[0]
    if (image?.type !== 'image') throw new Error('no image')
    const original = before.all()[0]?.parts[0] as { blob: string } | undefined
    expect(image.blob).not.toBe(original?.blob as string)
    expect(await targetBlobs.get(image.blob)).toEqual(photo as Bytes)
    // The large part came inline.
    const large = after.all()[3]?.parts[0]
    expect(large !== undefined && large.type === 'text' ? large.text.length : 0).toBe(20_000)
    source.ws.close()
    target.ws.close()
  })

  test('a broken conversation in a file is skipped, the others import', async () => {
    const { ws, clock } = await setup()
    const doc: ExportDocument = {
      format: 'aparte-conversation',
      version: 1,
      exportedAt: clock.now(),
      blobs: { bad: { mediaType: 'image/png', data: '!!' } },
      missing: [],
      conversations: [
        {
          id: newId(),
          title: 'Good',
          system: '',
          tools: [],
          model: null,
          effort: null,
          pinned: false,
          archived: true,
          createdAt: 1,
          updatedAt: 1,
          leaf: null,
          messages: [
            {
              id: 'm1',
              parent: null,
              role: 'user',
              parts: [{ type: 'text', text: 'Hi' }],
              model: null,
              createdAt: 1,
              status: 'done',
            },
          ],
        },
        {
          id: newId(),
          title: 'Bad',
          system: '',
          tools: [],
          model: null,
          effort: null,
          pinned: false,
          archived: false,
          createdAt: 1,
          updatedAt: 1,
          leaf: null,
          messages: [
            { id: 'm1', parent: null, role: 'robot' as never, parts: [], model: null, createdAt: 1, status: 'done' },
          ],
        },
      ],
    }
    const result = await applyImport(
      { workspace: ws, blobs: memoryBlobs('t'), rng: cryptoRng() },
      { source: 'aparte', document: doc, count: 2 },
    )
    expect(result.failed).toBe(1)
    expect(ws.conversations.list({ archived: true }).map((c) => c.title)).toEqual(['Good'])
    expect(ws.conversations.list().map((c) => c.title)).toEqual([])
    ws.close()
  })
})

describe('Markdown and HTML', () => {
  test('the active branch, escaped, with photos inline and injected parts left out', async () => {
    const { ws } = await setup()
    const blobs = memoryBlobs('r')
    const { id } = await sample(ws, blobs)
    const thread = await ws.thread(id)
    const extra = newId()
    thread.commit({
      ...msg(extra, thread.path().at(-1)?.id ?? null, 'user', ''),
      parts: [
        { type: 'text', text: 'Hidden lore', injected: 'lorebook' } as never,
        { type: 'text', text: 'Is <script>alert(1)</script> fine?' },
      ],
    })
    const answer = newId()
    thread.commit({
      ...msg(answer, extra, 'assistant', ''),
      parts: [
        {
          type: 'text',
          text: 'Use <b>care</b> and [this](javascript:alert(1)) or [that](https://example.org) ![x](https://example.org/t.png)',
        },
      ],
    })
    thread.setLeaf(answer)
    const conversation = ws.conversations.get(id)
    if (conversation === undefined) throw new Error('missing')
    const deps = { blobs, labels: LABELS, modelName: () => 'Model' }
    const md = await toMarkdown(conversation, thread.path(), deps)
    expect(md.startsWith('# Round trip\n')).toBe(true)
    expect(md).toContain('## You\n\n[Photo: cat.jpg]')
    expect(md).toContain('## Model\n\nA cat.')
    expect(md).not.toContain('Hidden lore')
    expect(md).not.toContain('Looking.')
    const html = await toHtml(conversation, thread.path(), deps)
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;`)
    expect(html.toLowerCase()).not.toContain('<script')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('<b>care</b>')
    expect(html).toContain('&#60;b&#62;care&#60;/b&#62;')
    expect(html).toContain('<a href="https://example.org" rel="noopener noreferrer">that</a>')
    expect(html).not.toContain('src="https://')
    expect(html).toMatch(/<img src="data:image\/jpeg;base64,[A-Za-z0-9+/]+=*" alt="cat\.jpg"/)
    expect(html).toContain('<summary>Reasoning</summary>')
    expect(html).not.toContain('Hidden lore')
    expect(html).not.toContain('slow down')
    ws.close()
  })
})
