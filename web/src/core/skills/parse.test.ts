/*
 * SKILL.md reading against the CLI: the shared fixtures of web/src/core/skills/fixtures, which
 * crates/aparte-skills/src/discover.rs reads too (the ultrasearch skill, and `cases.json`: frontmatter inputs and whole
 * SKILL.md files with what both readers must make of them), then the CLI's warning texts and limits.
 */
import { describe, expect, test } from 'bun:test'
import { MAX_SKILL_MD_BYTES, SkillError, type YamlValue } from '../contracts/skills.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { parseSkillMd, skillBody, validSkillName } from './parse.ts'

const fixtures = new URL('./fixtures/', import.meta.url)

interface Cases {
  readonly frontmatter: readonly { name: string; src: string; value?: unknown; errorLine?: number }[]
  readonly skills: readonly {
    name: string
    dir: string
    text: string
    error?: string
    skill?: {
      name: string
      description: string
      disableModelInvocation: boolean
      allowedTools: string[]
      license: string | null
      version: string | null
      warnings: number
      body: string
    }
  }[]
}

const cases = (await Bun.file(new URL('cases.json', fixtures)).json()) as Cases

/** The shared encoding of a YAML value: mappings as `{"map": [[key, value], ...]}`. */
function encode(v: YamlValue): unknown {
  if (v === null || typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(encode)
  return { map: (v as { entries: readonly (readonly [string, YamlValue])[] }).entries.map(([k, x]) => [k, encode(x)]) }
}

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof SkillError) return error.code
    throw error
  }
  return 'none'
}

describe('the fixtures the CLI reads too', () => {
  test('the ultrasearch skill', async () => {
    const text = await Bun.file(new URL('ultrasearch/SKILL.md', fixtures)).text()
    const expected = (await Bun.file(new URL('ultrasearch.expected.json', fixtures)).json()) as Record<string, unknown>
    const parsed = parseSkillMd(text, 'ultrasearch')
    const actual: Record<string, unknown> = {
      name: parsed.name,
      description: parsed.description,
      disableModelInvocation: parsed.disableModelInvocation,
      allowedTools: parsed.allowedTools,
      license: parsed.license ?? null,
      version: parsed.version ?? null,
      warnings: parsed.warnings,
    }
    expect(actual).toEqual(expected)
    expect(parsed.body.startsWith('# ultrasearch')).toBe(true)
    expect(skillBody(text)).toBe(parsed.body)
  })

  test.each(cases.frontmatter.map((c) => [c.name, c] as const))('frontmatter: %s', (_, c) => {
    if (c.errorLine !== undefined) {
      expect(() => parseFrontmatter(c.src)).toThrow(new RegExp(`^frontmatter line ${c.errorLine}: `))
    } else {
      expect(encode(parseFrontmatter(c.src))).toEqual(c.value)
    }
  })

  test.each(cases.skills.map((c) => [c.name, c] as const))('SKILL.md: %s', (_, c) => {
    if (c.error !== undefined) {
      expect(codeOf(() => parseSkillMd(c.text, c.dir))).toBe(c.error)
      return
    }
    const p = parseSkillMd(c.text, c.dir)
    expect({
      name: p.name,
      description: p.description,
      disableModelInvocation: p.disableModelInvocation,
      allowedTools: p.allowedTools,
      license: p.license ?? null,
      version: p.version ?? null,
      warnings: p.warnings.length,
      body: p.body,
    }).toEqual(c.skill as NonNullable<typeof c.skill>)
  })
})

describe('parseSkillMd', () => {
  test('names follow the format', () => {
    expect(validSkillName('ultrasearch') && validSkillName('pdf-tools') && validSkillName('a1')).toBe(true)
    for (const bad of ['', '-a', 'a-', 'a--b', 'A', 'a_b', 'a b', 'x'.repeat(65), 'é'])
      expect(validSkillName(bad)).toBe(false)
    expect(validSkillName('x'.repeat(64))).toBe(true)
  })

  test('warnings are worded as the CLI words them', () => {
    expect(parseSkillMd('---\ndescription: d\n---\n', 'from-dir').warnings).toEqual([
      'no `name` field: named after its directory, "from-dir"',
    ])
    expect(parseSkillMd('---\nname: demo\ndescription: d\n---\n', 'other').warnings).toEqual([
      'the name "demo" differs from its directory "other"',
    ])
    expect(
      parseSkillMd('---\nname: demo\ndescription: d\ndisable-model-invocation: [x]\n---\n', 'demo').warnings,
    ).toEqual(['`disable-model-invocation` is not true or false: taken as true'])
    expect(parseSkillMd(`---\nname: demo\ndescription: ${'é'.repeat(1025)}\n---\n`, 'demo').warnings).toEqual([
      'the description is longer than 1024 characters',
    ])
  })

  test('a SKILL.md over the size cap is refused, counted in UTF-8 bytes', () => {
    const head = '---\nname: demo\ndescription: d\n---\n'
    expect(codeOf(() => parseSkillMd(head + 'é'.repeat((MAX_SKILL_MD_BYTES - head.length) / 2 + 1), 'demo'))).toBe(
      'too-large',
    )
    expect(codeOf(() => parseSkillMd(head + 'x'.repeat(MAX_SKILL_MD_BYTES - head.length), 'demo'))).toBe('none')
  })

  test('allowed-tools wins over allowed_tools, even when empty', () => {
    expect(
      parseSkillMd('---\nname: a\ndescription: d\nallowed-tools:\nallowed_tools: [Read]\n---\n', 'a').allowedTools,
    ).toEqual([])
    expect(
      parseSkillMd('---\nname: a\ndescription: d\nallowed_tools: Read, Bash(a, b)\n---\n', 'a').allowedTools,
    ).toEqual(['Read', 'Bash(a, b)'])
  })

  test('the body keeps everything after the frontmatter but its leading line breaks', () => {
    expect(skillBody('---\nname: a\n---\r\n\n# A\n\nText\n')).toBe('# A\n\nText\n')
    expect(skillBody('# no frontmatter\n')).toBe('# no frontmatter\n')
  })
})
