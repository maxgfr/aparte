/*
 * Contract of the skills (M5c): Agent Skills, a directory holding a `SKILL.md` (YAML frontmatter, then Markdown
 * instructions) and the files those instructions point to, imported from a public GitHub repository, a zip archive or
 * a folder, stored encrypted in the workspace and offered to the model by progressive disclosure. Implemented by
 * web/src/core/skills/*.ts:
 *
 *   frontmatter.ts  splitFrontmatter, parseFrontmatter   the YAML subset of crates/aparte-skills/src/frontmatter.rs
 *   parse.ts        parseSkillMd, validSkillName, skillBody   the rules of crates/aparte-skills/src/discover.rs `load`
 *   bundle.ts       encodeBundle, decodeBundle, keptPath, findSkillRoots, bundleOf
 *   import.ts       parseGitHubSource, importFromGitHub, importFromZip, importFromFiles
 *   tool.ts         skillTool, renderSkill, readSkillFile    the `skill` tool (crates/aparte-skills/src/tool.rs)
 *   context.ts      availableSkillsText, skillsPart          the list of skills sent in a user turn
 *   store.ts        installSkills, loadBundle                the workspace collection and its blobs
 *
 * Invariants:
 * - A `SKILL.md` reads the same here as in the CLI: the same frontmatter subset, the same name rule (1 to 64 lowercase
 *   letters, digits and single hyphens), a description required and its whitespace collapsed, the name defaulting to
 *   the directory's, `disable-model-invocation` and `allowed-tools` read the same way. Both read one shared fixture
 *   (web/src/core/skills/fixtures/ultrasearch) to the same expected values.
 * - A skill is an entity of the `skills` map of the index (spec/DATA-MODEL.md section 3): its name, description,
 *   source and switches, never its files. Its files are one encrypted blob (`files.blob`, media type
 *   SKILL_BUNDLE_TYPE), synced like every blob. Nothing of a skill is stored in plaintext.
 * - Skill content is untrusted: it came from the network or a file. The app never runs it and never follows it; it is
 *   shown as text and given to the model as data. A skill's scripts run only in the sandbox frames, through `run_js` and
 *   `run_python`, after the user approved that run with its code shown in full (contracts/sandbox.ts); never in the
 *   app's realm. `allowed-tools` is shown, never used to skip an approval.
 * - Progressive disclosure never changes a conversation's frozen prefix (spec/DATA-MODEL.md section 5): the `skill`
 *   tool has one fixed definition (its fingerprint does not depend on which skills exist), and the list of available
 *   skills travels in a user turn as an `injected: 'skills'` text part, appended again only when the list changed
 *   since the last one on the branch. The system prompt and the tool set are never touched.
 * - Every request of an import goes through web/src/security/net.ts with purpose `skills` (api.github.com and
 *   raw.githubusercontent.com, unauthenticated, public repositories only).
 */

import type { Bytes } from './crypto.ts'
import type { Entity } from './workspace.ts'

/** The media type of the blob that holds a skill's files. */
export const SKILL_BUNDLE_TYPE = 'application/vnd.aparte.skill+json' as const

/** Largest `SKILL.md` read (crates/aparte-skills `MAX_SKILL_BYTES`). */
export const MAX_SKILL_MD_BYTES = 512 * 1024
/** Longest name and description (the Agent Skills format). */
export const MAX_SKILL_NAME = 64
export const MAX_SKILL_DESCRIPTION = 1024
/** Largest file the `skill` tool returns; a longer one is cut (crates/aparte-skills `MAX_FILE_BYTES`). */
export const MAX_SKILL_FILE_CHARS = 100 * 1024
/** Files listed with a skill's instructions. */
export const MAX_LISTED_FILES = 60
/** What one skill may hold: files, bytes per file, bytes in all. Larger files are skipped and reported. */
export const SKILL_LIMITS = Object.freeze({
  maxFiles: 400,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 24 * 1024 * 1024,
})
/** Deepest directory level kept under a skill's directory (crates/aparte-skills `files`: three levels). */
export const MAX_SKILL_DEPTH = 3

/** Where a skill was imported from. `path` is the skill's directory inside the source, `''` for its root. */
export type SkillSource =
  /** A public GitHub repository, read at `commit` (the commit `ref` pointed to at import). */
  | {
      readonly kind: 'github'
      readonly repo: string
      readonly path: string
      readonly ref: string
      readonly commit: string
    }
  | { readonly kind: 'zip'; readonly name: string; readonly path: string }
  | { readonly kind: 'folder'; readonly name: string; readonly path: string }

/** The entity of the `skills` collection (contracts/extras.ts `CollectionTypes.skills`). */
export interface Skill {
  readonly name: string
  readonly description: string
  readonly source: SkillSource
  /** The bundle blob (`blob`, a manifest id: synced as a blob reference), its size in bytes and its file count. */
  readonly files: { readonly blob: string; readonly size: number; readonly count: number }
  /** Offered to the model; off keeps it installed and out of every list. */
  readonly enabled: boolean
  /** `disable-model-invocation`: only the user may invoke it; never offered to the model. */
  readonly disableModelInvocation?: boolean
  /** `allowed-tools`, as written: shown, never used to skip an approval. */
  readonly allowedTools?: readonly string[]
  readonly license?: string
  /** `metadata.version` (or `version`). */
  readonly version?: string
  /** What was off but not fatal at import (a name that differs from its directory, skipped files...). */
  readonly warnings?: readonly string[]
}

export type StoredSkill = Entity<Skill>

/** One file of a skill: its path relative to the skill's directory (`/` separated, no `..`), and its bytes. */
export interface SkillFile {
  readonly path: string
  readonly data: Bytes
}

/**
 * The bundle blob: UTF-8 JSON `{"v":1,"files":[{"path":"SKILL.md","text":"..."},{"path":"logo.png","base64":"..."}]}`,
 * files sorted by path. A file that is valid UTF-8 without NUL is stored as `text`, any other as standard base64.
 */
export interface SkillBundle {
  readonly v: 1
  readonly files: readonly (
    | { readonly path: string; readonly text: string }
    | { readonly path: string; readonly base64: string }
  )[]
}

/** A YAML value of the frontmatter subset: scalars stay strings (crates/aparte-skills `Value`). */
export type YamlValue =
  | null
  | string
  | readonly YamlValue[]
  /** A mapping, keys in order (a repeated key keeps its last value, at its last position). */
  | { readonly kind: 'map'; readonly entries: readonly (readonly [string, YamlValue])[] }

/** What a `SKILL.md` says, as read by `parseSkillMd`. */
export interface ParsedSkill {
  readonly name: string
  readonly description: string
  readonly disableModelInvocation: boolean
  readonly allowedTools: readonly string[]
  readonly license?: string
  readonly version?: string
  /** The body after the frontmatter, leading line breaks removed. */
  readonly body: string
  /** Fields that were off but not fatal, in the CLI's words. */
  readonly warnings: readonly string[]
}

/** A skill found in an import, ready to install. */
export interface ImportedSkill {
  readonly parsed: ParsedSkill
  readonly source: SkillSource
  /** Its files, `SKILL.md` included, sorted by path. */
  readonly files: readonly SkillFile[]
  /** Files left out, with why (too deep, too large, over the count or the total). Hidden files are not listed. */
  readonly skipped: readonly string[]
}

/** What an import found: the skills it can install, and a line for each `SKILL.md` it could not read. */
export interface ImportResult {
  readonly skills: readonly ImportedSkill[]
  readonly problems: readonly string[]
}

export type SkillErrorCode =
  /** The text does not start with a `---` block. */
  | 'no-frontmatter'
  /** The frontmatter is not the YAML subset. */
  | 'yaml'
  /** A required field is missing or malformed (the name, the description). */
  | 'invalid'
  /** Nothing in the source holds a `SKILL.md`. */
  | 'not-found'
  /** Over a limit (a `SKILL.md`, an archive). */
  | 'too-large'
  /** The source answered with an error, or could not be reached. */
  | 'network'
  /** GitHub's unauthenticated rate limit was hit. */
  | 'rate-limited'
  /** A source string that names no repository, a damaged archive. */
  | 'malformed'

export class SkillError extends Error {
  constructor(
    readonly code: SkillErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SkillError'
  }
}

/** Where a GitHub import reads from: `owner/repo`, an optional ref, and a directory inside it (`''` for the root). */
export interface GitHubSource {
  readonly owner: string
  readonly repo: string
  readonly ref: string | null
  readonly path: string
}

/** The skills of the workspace the `skill` tool and the skills list read. */
export interface SkillCatalog {
  /** Installed, not trashed, by name. */
  list(): readonly StoredSkill[]
  /** The files of a skill, from its blob; null when this device does not have the blob (yet). */
  files(skill: StoredSkill): Promise<readonly SkillFile[] | null>
}

/** The name the `skill` tool is registered under. */
export const SKILL_TOOL = 'skill' as const
