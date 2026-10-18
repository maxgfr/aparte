/*
 * What a `SKILL.md` says: the rules of crates/aparte-skills/src/discover.rs `load`, field for field, so a skill
 * imported in the browser has the name, description and switches the CLI would give it.
 *
 * Invariants:
 * - Fatal: a file over MAX_SKILL_MD_BYTES (`too-large`), no frontmatter (`no-frontmatter`), a frontmatter outside the
 *   subset (`yaml`), a name that is not 1 to 64 lowercase letters, digits and single hyphens, or no description
 *   (`invalid`). Everything else that is off is a warning, worded as the CLI words it.
 * - The name defaults to the directory's; the description's whitespace is collapsed; `disable-model-invocation` that is
 *   not a boolean is taken as true (the safer reading: the skill is not offered to the model).
 * - Pure: the same text and directory name always give the same result.
 */

import {
  MAX_SKILL_DESCRIPTION,
  MAX_SKILL_MD_BYTES,
  MAX_SKILL_NAME,
  type ParsedSkill,
  SkillError,
  type YamlValue,
} from '../contracts/skills.ts'
import { parseFrontmatter, splitFrontmatter, yamlBool, yamlGet, yamlString } from './frontmatter.ts'

/** Whether a name follows the format: lowercase letters, digits and single hyphens, not at either end. */
export function validSkillName(name: string): boolean {
  return (
    name !== '' &&
    name.length <= MAX_SKILL_NAME &&
    /^[a-z0-9-]+$/.test(name) &&
    !name.startsWith('-') &&
    !name.endsWith('-') &&
    !name.includes('--')
  )
}

/** A string as Rust's `{:?}` writes it, near enough for messages. */
const quoted = (s: string): string => JSON.stringify(s)

/** Splits `Bash(git status:*), Read Write` on commas and spaces outside parentheses. */
function splitTools(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let depth = 0
  const push = () => {
    if (cur.trim() !== '') out.push(cur.trim())
    cur = ''
  }
  for (const c of s) {
    if (c === '(') {
      depth++
      cur += c
    } else if (c === ')') {
      depth = Math.max(0, depth - 1)
      cur += c
    } else if ((c === ',' || c === ' ' || c === '\t') && depth === 0) push()
    else cur += c
  }
  push()
  return out
}

function stringList(v: YamlValue | undefined): string[] {
  if (Array.isArray(v)) return v.filter((i): i is string => typeof i === 'string')
  if (typeof v === 'string') return splitTools(v)
  return []
}

/** The body of a `SKILL.md`: what follows its frontmatter, leading line breaks removed; the whole text without one. */
export function skillBody(text: string): string {
  const split = splitFrontmatter(text)
  return split === null ? text : split.body.replace(/^[\r\n]+/, '')
}

/** Reads a `SKILL.md` found in the directory named `dirName`. Throws SkillError when it cannot be loaded. */
export function parseSkillMd(text: string, dirName: string): ParsedSkill {
  if (new TextEncoder().encode(text).length > MAX_SKILL_MD_BYTES) {
    throw new SkillError('too-large', `SKILL.md is larger than ${MAX_SKILL_MD_BYTES / 1024} KiB`)
  }
  const split = splitFrontmatter(text)
  if (split === null) {
    throw new SkillError(
      'no-frontmatter',
      'SKILL.md has no YAML frontmatter (a first line `---`, the fields, then `---`)',
    )
  }
  const v = parseFrontmatter(split.frontmatter)
  const warnings: string[] = []
  const given = yamlString(yamlGet(v, 'name'))
  let name: string
  if (given === undefined) {
    warnings.push(`no \`name\` field: named after its directory, ${quoted(dirName)}`)
    name = dirName
  } else name = given.trim()
  if (!validSkillName(name)) {
    throw new SkillError(
      'invalid',
      `the name ${quoted(name)} is not 1 to ${MAX_SKILL_NAME} lowercase letters, digits and single hyphens`,
    )
  }
  if (name !== dirName) warnings.push(`the name ${quoted(name)} differs from its directory ${quoted(dirName)}`)
  const description = (yamlString(yamlGet(v, 'description')) ?? '').split(/\s+/).filter(Boolean).join(' ')
  if (description === '') {
    throw new SkillError('invalid', 'no `description` field: the model could not tell when to use it')
  }
  if ([...description].length > MAX_SKILL_DESCRIPTION) {
    warnings.push(`the description is longer than ${MAX_SKILL_DESCRIPTION} characters`)
  }
  const disable = yamlGet(v, 'disable-model-invocation')
  let disableModelInvocation = false
  if (disable !== undefined && disable !== null) {
    const b = yamlBool(disable)
    if (b === undefined) warnings.push('`disable-model-invocation` is not true or false: taken as true')
    disableModelInvocation = b ?? true
  }
  const tools = yamlGet(v, 'allowed-tools')
  const allowedTools = stringList(tools === undefined ? yamlGet(v, 'allowed_tools') : tools)
  const license = yamlString(yamlGet(v, 'license'))
  const metaVersion = yamlGet(yamlGet(v, 'metadata'), 'version')
  const version = yamlString(metaVersion === undefined ? yamlGet(v, 'version') : metaVersion)
  return {
    name,
    description,
    disableModelInvocation,
    allowedTools,
    ...(license === undefined ? {} : { license }),
    ...(version === undefined ? {} : { version }),
    body: split.body.replace(/^[\r\n]+/, ''),
    warnings,
  }
}
