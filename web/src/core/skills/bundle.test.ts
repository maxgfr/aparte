/*
 * The bundle blob of a skill and the rules that make a skill out of a source's files: safe paths, kept paths (the
 * CLI's listing rules), skill roots, and the limits applied with SKILL.md first.
 */
import { describe, expect, test } from 'bun:test'
import { SKILL_LIMITS, SkillError, type SkillFile } from '../contracts/skills.ts'
import { bundleOf, decodeBundle, encodeBundle, findSkillRoots, keptPath, safeSkillPath } from './bundle.ts'

const enc = new TextEncoder()
const file = (path: string, data: string | Uint8Array): SkillFile => ({
  path,
  data: typeof data === 'string' ? enc.encode(data) : new Uint8Array(data),
})

describe('paths', () => {
  test('safe paths are relative and stay inside', () => {
    expect(safeSkillPath('./a/b.md')).toBe('a/b.md')
    expect(safeSkillPath('a\\b.md')).toBe('a/b.md')
    expect(safeSkillPath('dir/')).toBe('dir')
    for (const bad of ['', '/etc/passwd', '../x', 'a/../../b', 'a//b', 'a/./b', 'C:/x', 'a\0b', '.', './'])
      expect(safeSkillPath(bad)).toBeNull()
  })

  test('kept paths: no hidden file, no dependency folder, three folder levels at most', () => {
    expect(keptPath('SKILL.md')).toBe(true)
    expect(keptPath('a/b/c/file.txt')).toBe(true)
    expect(keptPath('a/b/c/d/file.txt')).toBe(false)
    for (const bad of ['.env', 'a/.git/config', 'node_modules/x.js', 'x/__pycache__/y.pyc', 'target/debug'])
      expect(keptPath(bad)).toBe(false)
  })

  test('skill roots: the outermost SKILL.md wins, hidden folders are skipped', () => {
    expect(
      findSkillRoots([
        'README.md',
        'skills/b/SKILL.md',
        'skills/a/SKILL.md',
        'skills/a/inner/SKILL.md',
        '.agents/skills/c/SKILL.md',
        'node_modules/x/SKILL.md',
        'skills/d/skill.md',
      ]),
    ).toEqual(['skills/a', 'skills/b'])
    expect(findSkillRoots(['SKILL.md', 'sub/SKILL.md'])).toEqual([''])
    expect(findSkillRoots(['README.md'])).toEqual([])
  })
})

describe('bundleOf', () => {
  test('keeps the files under the root, relative to it, SKILL.md first', () => {
    const entries = [
      { path: 'skills/a/scripts/run.py', size: 10 },
      { path: 'skills/a/SKILL.md', size: 10 },
      { path: 'skills/a/.hidden', size: 1 },
      { path: 'skills/a/a/b/c/d/deep.txt', size: 1 },
      { path: 'skills/b/SKILL.md', size: 10 },
    ]
    const { kept, skipped } = bundleOf(entries, 'skills/a')
    expect(kept.map((k) => k.path)).toEqual(['SKILL.md', 'scripts/run.py'])
    expect(kept[0]?.entry).toBe(entries[1] as (typeof entries)[number])
    expect(skipped).toEqual(['a/b/c/d/deep.txt: deeper than 3 folder levels'])
  })

  test('applies the limits, the instructions first', () => {
    const big = SKILL_LIMITS.maxFileBytes
    const entries = [
      { path: 'a.bin', size: big + 1 },
      { path: 'SKILL.md', size: 100 },
      ...Array.from({ length: 7 }, (_, i) => ({ path: `f${i}.bin`, size: big })),
    ]
    const { kept, skipped } = bundleOf(entries, '')
    expect(kept[0]?.path).toBe('SKILL.md')
    expect(skipped[0]).toBe('a.bin: larger than 4 MiB')
    // 24 MiB in all: SKILL.md and five full files fit, the sixth does not.
    expect(kept.length).toBe(6)
    expect(skipped.slice(1)).toEqual([
      'f5.bin: over the 24 MiB a skill may hold',
      'f6.bin: over the 24 MiB a skill may hold',
    ])
  })

  test('caps the number of files', () => {
    const entries = Array.from({ length: SKILL_LIMITS.maxFiles + 2 }, (_, i) => ({
      path: `f${String(i).padStart(4, '0')}`,
      size: 1,
    }))
    const { kept, skipped } = bundleOf(entries, '')
    expect(kept.length).toBe(SKILL_LIMITS.maxFiles)
    expect(skipped).toHaveLength(2)
    expect(skipped[0]).toContain('over the 400 files')
  })
})

describe('the bundle blob', () => {
  test('round-trips text and binary files, sorted by path', () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69])
    const files = [
      file('z.txt', 'zed'),
      file('img.png', new Uint8Array([137, 80, 78, 71, 0, 255])),
      file('bom.md', bom),
      file('SKILL.md', '---\nname: a\n---\n'),
    ]
    const bytes = encodeBundle(files)
    const json = JSON.parse(new TextDecoder().decode(bytes))
    expect(json.v).toBe(1)
    expect(json.files.map((f: { path: string }) => f.path)).toEqual(['SKILL.md', 'bom.md', 'img.png', 'z.txt'])
    expect(json.files[2]).toEqual({ path: 'img.png', base64: 'iVBORwD/' })
    expect(json.files[3]).toEqual({ path: 'z.txt', text: 'zed' })
    const back = decodeBundle(bytes)
    expect(back.map((f) => f.path)).toEqual(['SKILL.md', 'bom.md', 'img.png', 'z.txt'])
    expect([...(back.find((f) => f.path === 'bom.md')?.data ?? [])]).toEqual([...bom])
    expect([...(back.find((f) => f.path === 'img.png')?.data ?? [])]).toEqual([137, 80, 78, 71, 0, 255])
  })

  test('refuses unsafe or duplicate paths when encoding', () => {
    expect(() => encodeBundle([file('../x', 'a')])).toThrow(SkillError)
    expect(() => encodeBundle([file('a', 'a'), file('a', 'b')])).toThrow(SkillError)
  })

  test('refuses anything but a well-formed bundle', () => {
    const bad = [
      'not json',
      '[]',
      '{"v":2,"files":[]}',
      '{"v":1}',
      '{"v":1,"files":[{"path":"../a","text":"x"}]}',
      '{"v":1,"files":[{"path":"a","text":"x"},{"path":"a","text":"y"}]}',
      '{"v":1,"files":[{"path":"a"}]}',
      '{"v":1,"files":[{"path":"a","text":"x","base64":"eA=="}]}',
      '{"v":1,"files":[{"path":"a","base64":"e*=="}]}',
      '{"v":1,"files":[{"path":"a","base64":"eA="}]}',
      '{"v":1,"files":[{"path":"a","text":1}]}',
    ]
    for (const b of bad) {
      let code = 'none'
      try {
        decodeBundle(enc.encode(b))
      } catch (error) {
        code = (error as SkillError).code
      }
      expect(code, b).toBe('malformed')
    }
    expect(decodeBundle(enc.encode('{"v":1,"files":[]}'))).toEqual([])
  })
})
