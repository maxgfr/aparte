/*
 * The skills as the chat sees them, over the real workspace: installing (an entity and its sealed bundle blob, an
 * update for a name already installed), the catalog, the `skill` tool (fixed definition, offered skills only, paths
 * that stay inside, binary and long files), and the list of skills sent in user turns (appended only when it changed).
 */
import { describe, expect, test } from 'bun:test'
import {
  type ImportedSkill,
  MAX_SKILL_FILE_CHARS,
  SKILL_BUNDLE_TYPE,
  type SkillCatalog,
  type SkillFile,
  type StoredSkill,
} from '../contracts/skills.ts'
import type { ToolResult } from '../contracts/tools.ts'
import type { BlobPort, Message, Part } from '../contracts/workspace.ts'
import { fingerprintOf } from '../tools/fingerprint.ts'
import { autoApproved } from '../tools/policy.ts'
import { setup } from '../workspace/testkit.ts'
import { availableSkillsText, offeredSkills, skillsPart } from './context.ts'
import { parseSkillMd } from './parse.ts'
import { createSkillCatalog, installSkills } from './store.ts'
import { readSkillFile, renderSkill, skillTool } from './tool.ts'

const enc = new TextEncoder()
const f = (path: string, data: string | Uint8Array): SkillFile => ({
  path,
  data: typeof data === 'string' ? enc.encode(data) : new Uint8Array(data),
})

function memoryBlobs(): BlobPort & { readonly puts: { type: string; size: number }[] } {
  const store = new Map<string, Uint8Array>()
  const puts: { type: string; size: number }[] = []
  return {
    puts,
    async put(bytes, mediaType) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
      const id = Array.from(digest.subarray(0, 13), (b) => 'abcdefghijklmnopqrstuvwxyz'[b % 26])
        .join('')
        .padEnd(26, 'a')
      store.set(id, new Uint8Array(bytes))
      puts.push({ type: mediaType, size: bytes.length })
      return id
    },
    async get(id) {
      const b = store.get(id)
      return b === undefined ? null : new Uint8Array(b)
    },
  }
}

function imported(name: string, extra: Partial<ImportedSkill> = {}, frontmatter = ''): ImportedSkill {
  const md = `---\nname: ${name}\ndescription: Does ${name} things.\n${frontmatter}---\n# ${name}\nRun {baseDir}/scripts/run.py or \${CLAUDE_SKILL_DIR}/x and <skill-dir>/y.\n`
  return {
    parsed: parseSkillMd(md, name),
    source: { kind: 'github', repo: 'o/r', path: `skills/${name}`, ref: 'main', commit: 'c'.repeat(40) },
    files: [f('SKILL.md', md), f('references/guide.md', 'The guide.'), f('scripts/run.py', 'print(1)')],
    skipped: [],
    ...extra,
  }
}

const text = (r: ToolResult): string => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('')
const ctx = { conversationId: 'c', callId: 'k', signal: new AbortController().signal }

describe('installSkills and the catalog', () => {
  test('stores an entity and its bundle blob; installing the same name again updates it', async () => {
    const { ws } = await setup()
    const blobs = memoryBlobs()
    const [id] = await installSkills({ workspace: ws, blobs }, [
      imported('demo', { skipped: ['big.bin: larger than 4 MiB'] }, 'license: MIT\nallowed-tools: Read\n'),
    ])
    const stored = ws.collection('skills').get(id as string)
    expect(stored).toMatchObject({
      name: 'demo',
      description: 'Does demo things.',
      enabled: true,
      license: 'MIT',
      allowedTools: ['Read'],
      warnings: ['big.bin: larger than 4 MiB'],
      source: { kind: 'github', repo: 'o/r', path: 'skills/demo' },
      files: { count: 3 },
    })
    expect(blobs.puts).toEqual([{ type: SKILL_BUNDLE_TYPE, size: stored?.files.size as number }])
    // Nothing of the files sits in the entity.
    expect(JSON.stringify(stored)).not.toContain('The guide.')

    ws.collection('skills').update(id as string, { enabled: false })
    const [again] = await installSkills({ workspace: ws, blobs }, [imported('demo')])
    expect(again).toBe(id as string)
    const updated = ws.collection('skills').get(id as string)
    expect(updated?.enabled).toBe(false)
    expect(updated?.license).toBeUndefined()
    expect(updated?.warnings).toBeUndefined()
    expect(ws.collection('skills').list()).toHaveLength(1)

    const catalog = createSkillCatalog({ workspace: ws, blobs })
    const files = await catalog.files(updated as StoredSkill)
    expect(files?.map((x) => x.path)).toEqual(['SKILL.md', 'references/guide.md', 'scripts/run.py'])
    expect(catalog.list().map((s) => s.name)).toEqual(['demo'])
    ws.close()
  })

  test('a blob this device does not have reads as null', async () => {
    const { ws } = await setup()
    const catalog = createSkillCatalog({ workspace: ws, blobs: memoryBlobs() })
    const ghost = { name: 'x', files: { blob: 'a'.repeat(26), size: 1, count: 1 } } as StoredSkill
    expect(await catalog.files(ghost)).toBeNull()
    ws.close()
  })
})

/** A catalog over fixed skills. */
function catalogOf(skills: { skill: Partial<StoredSkill>; files: SkillFile[] | null }[]): SkillCatalog {
  const list = skills.map(
    (s, i) =>
      ({
        id: `id${i}`,
        createdAt: 0,
        updatedAt: 0,
        description: 'd',
        enabled: true,
        source: { kind: 'zip', name: 'x.zip', path: '' },
        files: { blob: `b${i}`, size: 1, count: 1 },
        ...s.skill,
      }) as StoredSkill,
  )
  return {
    list: () => list,
    files: async (skill) => skills[list.indexOf(skill)]?.files ?? null,
  }
}

describe('the skill tool', () => {
  const demo = imported('demo')
  const catalog = catalogOf([
    { skill: { name: 'demo' }, files: [...demo.files, f('img.png', new Uint8Array([1, 0, 2]))] },
    { skill: { name: 'off', enabled: false }, files: [] },
    { skill: { name: 'mine', disableModelInvocation: true }, files: [] },
    { skill: { name: 'ghost' }, files: null },
    { skill: { name: 'gone', deletedAt: 5 }, files: [] },
  ])

  test('one fixed definition, which runs unasked', async () => {
    const a = skillTool(catalog)
    const b = skillTool(catalogOf([]))
    expect(await fingerprintOf(a)).toBe(await fingerprintOf(b))
    expect(a.name).toBe('skill')
    expect(autoApproved(a)).toBe(true)
  })

  test('loads the instructions with the placeholders filled in and the files listed', async () => {
    const r = await skillTool(catalog).execute({ name: 'demo' }, ctx)
    expect(r.isError).toBeUndefined()
    const out = text(r)
    expect(out.startsWith('<skill name="demo" location="skills/demo/SKILL.md">\nBase directory: skills/demo\n')).toBe(
      true,
    )
    expect(out).toContain('Run skills/demo/scripts/run.py or skills/demo/x and skills/demo/y.')
    expect(out).toContain('Files:\n- references/guide.md\n- scripts/run.py\n- img.png')
    expect(out).toContain('run_python')
    expect(out.endsWith('</skill>')).toBe(true)
    expect(r.details).toEqual({ skill: 'demo' })
  })

  test('reads files inside the skill only', async () => {
    const tool = skillTool(catalog)
    expect(text(await tool.execute({ name: 'demo', path: 'references/guide.md' }, ctx))).toBe('The guide.')
    expect(text(await tool.execute({ name: 'demo', path: 'scripts' }, ctx))).toBe(
      'skills/demo/scripts is a directory:\nrun.py',
    )
    for (const path of ['../off/SKILL.md', '/etc/passwd', 'img.png', 'nope.md']) {
      const r = await tool.execute({ name: 'demo', path }, ctx)
      expect(r.isError, path).toBe(true)
    }
    expect(text(await tool.execute({ name: 'demo', path: '../x' }, ctx))).toContain('outside the skill directory')
    expect(text(await tool.execute({ name: 'demo', path: 'img.png' }, ctx))).toContain('binary')
  })

  test('only offered skills load', async () => {
    const tool = skillTool(catalog)
    for (const name of ['off', 'nope', 'gone']) {
      const r = await tool.execute({ name }, ctx)
      expect(r.isError).toBe(true)
      expect(text(r)).toContain('available: demo, ghost.')
    }
    expect(text(await tool.execute({ name: 'mine' }, ctx))).toContain('only be invoked by the user')
    expect(text(await tool.execute({ name: 'ghost' }, ctx))).toContain('not on this device yet')
    expect(text(await skillTool(catalogOf([])).execute({ name: 'x' }, ctx))).toContain('available: none.')
    const broken: SkillCatalog = { list: catalog.list, files: () => Promise.reject(new Error('bad')) }
    expect((await skillTool(broken).execute({ name: 'demo' }, ctx)).isError).toBe(true)
  })

  test('long files are cut, never inside a character', () => {
    const long = `${'a'.repeat(MAX_SKILL_FILE_CHARS - 1)}😀tail`
    const r = readSkillFile('demo', [f('long.md', long)], 'long.md')
    expect('text' in r && r.text.startsWith('a'.repeat(MAX_SKILL_FILE_CHARS - 1))).toBe(true)
    expect('text' in r && r.text).toContain('[cut at 100 KiB')
    expect('text' in r && r.text.includes('😀')).toBe(false)
  })

  test('render lists at most 60 files', () => {
    const files = [
      f('SKILL.md', '---\nname: x\n---\nBody'),
      ...Array.from({ length: 65 }, (_, i) => f(`f${i}.md`, 'x')),
    ]
    expect(renderSkill({ name: 'x' }, files)).toContain('- ... and 5 more\n\nBody\n</skill>')
  })
})

describe('the list of skills in user turns', () => {
  const skill = (name: string, more: Partial<StoredSkill> = {}) =>
    ({ id: name, name, description: `About <${name}> & more`, enabled: true, ...more }) as StoredSkill
  const userWith = (parts: Part[]): Message =>
    ({ id: 'm', conv: 'c', parent: null, role: 'user', parts, model: null, createdAt: 0, status: 'done' }) as Message

  test('offered: enabled, for the model, by name; escaped', () => {
    const list = [
      skill('b'),
      skill('a'),
      skill('off', { enabled: false }),
      skill('mine', { disableModelInvocation: true }),
    ]
    expect(offeredSkills(list).map((s) => s.name)).toEqual(['a', 'b'])
    const out = availableSkillsText(list)
    expect(out).toContain(
      '<name>a</name>\n<description>About &lt;a&gt; &amp; more</description>\n<location>skills/a/SKILL.md</location>',
    )
    expect(out).not.toContain('mine')
  })

  test('sent with the first message, then only when it changed', () => {
    expect(skillsPart([], [])).toBeNull()
    const first = skillsPart([], [skill('a')])
    expect(first).toMatchObject({ type: 'text', injected: 'skills' })
    const path = [userWith([{ type: 'text', text: 'hi' }, first as Part])]
    expect(skillsPart(path, [skill('a')])).toBeNull()
    const changed = skillsPart(path, [skill('a'), skill('b')])
    expect((changed as { text: string }).text).toContain('<name>b</name>')
    // Every skill removed: the model is told once, then nothing more.
    const none = skillsPart(path, [])
    expect((none as { text: string }).text).toContain('No skills are available any more')
    expect(skillsPart([...path, userWith([none as Part])], [])).toBeNull()
  })
})
