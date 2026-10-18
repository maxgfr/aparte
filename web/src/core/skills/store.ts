/*
 * Installed skills in the workspace: one entity of the `skills` collection per skill (contracts/skills.ts `Skill`),
 * its files in one encrypted bundle blob, and the catalog the `skill` tool and the settings screen read.
 *
 * Invariants:
 * - The entity holds what the lists need (name, description, source, switches) and the bundle's blob reference in
 *   `files.blob`, where the sync layer finds blob references (core/sync/updates.ts); the files themselves are only in
 *   the blob, sealed like every blob (core/media/blobs.ts). Nothing of a skill is stored in plaintext.
 * - Installing a skill whose name is installed already replaces that one (same id, its `enabled` kept): an update,
 *   not a second skill of the same name.
 * - The blobs are written before the entities, and the entities in one batch: a sync never names a blob this device
 *   has not stored.
 * - A bundle that does not decode is an error, never a partial skill; a blob this device does not have yet reads as
 *   null.
 */

import {
  type ImportedSkill,
  SKILL_BUNDLE_TYPE,
  type Skill,
  type SkillCatalog,
  type SkillFile,
  type StoredSkill,
} from '../contracts/skills.ts'
import type { BlobPort, EntityPatch, Id, Workspace } from '../contracts/workspace.ts'
import { decodeBundle, encodeBundle } from './bundle.ts'

export interface SkillStoreDeps {
  readonly workspace: Pick<Workspace, 'collection' | 'batch'>
  readonly blobs: BlobPort
}

const byName = (a: StoredSkill, b: StoredSkill) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1)

/** The fields of the entity of an imported skill whose bundle is `blob`. */
function fieldsOf(skill: ImportedSkill, blob: string, size: number, enabled: boolean): Skill {
  const p = skill.parsed
  const warnings = [...p.warnings, ...skill.skipped]
  return {
    name: p.name,
    description: p.description,
    source: { ...skill.source },
    files: { blob, size, count: skill.files.length },
    enabled,
    ...(p.disableModelInvocation ? { disableModelInvocation: true } : {}),
    ...(p.allowedTools.length > 0 ? { allowedTools: [...p.allowedTools] } : {}),
    ...(p.license === undefined ? {} : { license: p.license }),
    ...(p.version === undefined ? {} : { version: p.version }),
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/** Installs the skills (or updates the installed ones of the same names); returns their ids, in order. */
export async function installSkills(deps: SkillStoreDeps, imported: readonly ImportedSkill[]): Promise<Id[]> {
  const stored: { skill: ImportedSkill; blob: string; size: number }[] = []
  for (const skill of imported) {
    const bytes = encodeBundle(skill.files)
    stored.push({ skill, blob: await deps.blobs.put(bytes, SKILL_BUNDLE_TYPE), size: bytes.length })
  }
  const skills = deps.workspace.collection('skills')
  return deps.workspace.batch(() =>
    stored.map(({ skill, blob, size }) => {
      const existing = skills.list().find((s) => s.name === skill.parsed.name)
      if (existing === undefined) return skills.create(fieldsOf(skill, blob, size, true))
      const fields = fieldsOf(skill, blob, size, existing.enabled)
      // Optional fields the new version no longer has are removed.
      const patch: EntityPatch<Skill> = {
        disableModelInvocation: undefined,
        allowedTools: undefined,
        license: undefined,
        version: undefined,
        warnings: undefined,
        ...fields,
      }
      skills.update(existing.id, patch)
      return existing.id
    }),
  )
}

/** The workspace's skills, with their files read from their bundles (cached by blob for the session). */
export function createSkillCatalog(deps: {
  readonly workspace: Pick<Workspace, 'collection'>
  readonly blobs: BlobPort
}): SkillCatalog & { clear(): void } {
  const cache = new Map<string, Promise<readonly SkillFile[] | null>>()
  return {
    list() {
      return [...deps.workspace.collection('skills').list()].sort(byName)
    },
    files(skill) {
      const blob = skill.files.blob
      let files = cache.get(blob)
      if (files === undefined) {
        files = deps.blobs.get(blob).then((bytes) => (bytes === null ? null : decodeBundle(bytes)))
        // A blob not here yet, or one that failed, is read again next time.
        files.then(
          (f) => {
            if (f === null) cache.delete(blob)
          },
          () => cache.delete(blob),
        )
        cache.set(blob, files)
      }
      return files
    },
    clear() {
      cache.clear()
    },
  }
}
