import { useCallback, useId, useMemo, useState } from 'react'
import { Redirect } from 'wouter'
import { useCollection, useExternal, useSession, useSessionState } from '../../app/chat.tsx'
import { paths } from '../../app/routes.ts'
import {
  canPickDirectory,
  type PickedFile,
  pickDirectory,
  readDirectoryInput,
  skillsFetch,
  skippedCount,
} from '../../app/skills.ts'
import { useVault } from '../../app/vault.tsx'
import { type ImportResult, type Skill, SkillError, type StoredSkill } from '../../core/contracts/skills.ts'
import type { Entity } from '../../core/contracts/workspace.ts'
import { formatBytes } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Button, buttonClass } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { SwitchRow } from '../../ui/components/Switch.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import styles from './Skills.module.css'

/*
 * The skills of this vault (`/skills`): the installed ones with their switch, their details and Remove; the removed
 * ones, restorable; and the three imports (a public GitHub path, a zip, a folder). What a skill says is shown as text,
 * never as markup: it came from someone else.
 */

type Outcome = { readonly kind: 'done'; readonly text: string } | { readonly kind: 'error'; readonly text: string }

const EMPTY: readonly Entity<Skill>[] = []

/** The removed skills, kept in the collection's trash. */
function useTrashedSkills(): readonly Entity<Skill>[] {
  const session = useSession()
  const ws = session?.workspace ?? null
  const subscribe = useMemo(() => (ws === null ? null : (fn: () => void) => ws.subscribe('skills', fn)), [ws])
  const read = useCallback(() => (ws === null ? EMPTY : ws.collection('skills').list({ trashed: true })), [ws])
  return useExternal(subscribe, read)
}

function shortCommit(commit: string): string {
  return commit.slice(0, 7)
}

function SkillRow({ skill }: { readonly skill: StoredSkill }) {
  const t = useT()
  const locale = useLocale()
  const session = useSession()
  const [files, setFiles] = useState<readonly string[] | null>(null)
  const [confirming, setConfirming] = useState(false)
  const source = skill.source
  const from =
    source.kind === 'github'
      ? t('skills.sourceGithub', {
          repo: source.path === '' ? source.repo : `${source.repo}/${source.path}`,
          commit: shortCommit(source.commit),
        })
      : source.kind === 'zip'
        ? t('skills.sourceZip', { name: source.name })
        : t('skills.sourceFolder', { name: source.name })
  const userOnly = skill.disableModelInvocation === true
  return (
    <li className={styles.skill} data-skill={skill.name}>
      <div className={styles.skillHead}>
        <h3 className={styles.skillName}>{skill.name}</h3>
        <p className={styles.description}>{skill.description}</p>
        <p className={styles.meta}>
          {[
            from,
            t('skills.files', { count: skill.files.count }),
            formatBytes(locale, skill.files.size),
            ...(skill.version === undefined ? [] : [t('skills.version', { version: skill.version })]),
            ...(skill.license === undefined ? [] : [t('skills.license', { license: skill.license })]),
          ].join(' · ')}
        </p>
      </div>
      {userOnly ? (
        <p className={styles.note}>{t('skills.userOnly')}</p>
      ) : (
        <SwitchRow
          label={t('skills.enabled')}
          hint={skill.enabled ? t('skills.enabledHint') : t('skills.disabledHint')}
          checked={skill.enabled}
          onChange={(on) => session?.workspace.collection('skills').update(skill.id, { enabled: on })}
        />
      )}
      <details
        className={styles.details}
        onToggle={(e) => {
          if (!(e.currentTarget as HTMLDetailsElement).open || files !== null || session === null) return
          session.skills.files(skill).then(
            (list) => setFiles(list === null ? [] : list.map((f) => f.path)),
            () => setFiles([]),
          )
        }}
      >
        <summary>{t('skills.details')}</summary>
        {skill.allowedTools !== undefined && skill.allowedTools.length > 0 && (
          <p className={styles.note}>{t('skills.allowedTools', { tools: skill.allowedTools.join(', ') })}</p>
        )}
        <p className={styles.note}>{t('skills.scriptsNote')}</p>
        {skill.warnings !== undefined && skill.warnings.length > 0 && (
          <>
            <p className={styles.label}>{t('skills.warnings')}</p>
            <ul className={styles.plainList}>
              {skill.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </>
        )}
        {files !== null && (
          <ul className={styles.fileList} aria-label={t('skills.fileList', { name: skill.name })}>
            {files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
      </details>
      <div className={styles.actions}>
        {confirming ? (
          <>
            <p className={styles.note}>{t('skills.removeConfirm', { name: skill.name })}</p>
            <Button variant="danger" onClick={() => session?.workspace.collection('skills').trash(skill.id)}>
              {t('skills.remove')}
            </Button>
            <Button variant="plain" onClick={() => setConfirming(false)}>
              {t('chat.cancel')}
            </Button>
          </>
        ) : (
          <Button
            variant="plain"
            aria-label={t('skills.removeLabel', { name: skill.name })}
            onClick={() => setConfirming(true)}
          >
            {t('skills.remove')}
          </Button>
        )}
      </div>
    </li>
  )
}

/** The skills of this vault and their imports. */
export default function SkillsScreen() {
  const t = useT()
  const { status } = useVault()
  const state = useSessionState()
  const session = useSession()
  const skills = useCollection('skills')
  const trashed = useTrashedSkills()
  const [github, setGithub] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const zipId = useId()
  const folderId = useId()
  const sorted = useMemo(() => [...skills].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), [skills])

  if (status.state === 'absent') return <Redirect to={paths.home} replace />
  if (state.status !== 'open' || session === null) {
    return (
      <Screen title={t('skills.title')} back={paths.more}>
        <p className={styles.note} role="status">
          {t('chat.sessionOpening')}
        </p>
      </Screen>
    )
  }

  const explain = (error: unknown): string => {
    if (!(error instanceof SkillError)) return t('skills.errorStorage', { message: String(error) })
    switch (error.code) {
      case 'malformed':
        return t('skills.errorMalformed')
      case 'not-found':
        return t('skills.errorNotFound')
      case 'rate-limited':
        return t('skills.errorRateLimited')
      case 'too-large':
        return t('skills.errorTooLarge')
      case 'network':
        return t('skills.errorNetwork')
      default:
        return t('skills.errorInvalid', { message: error.message })
    }
  }

  /** Runs one import to its installed skills, and says how it went. */
  const run = async (load: () => Promise<ImportResult> | ImportResult) => {
    if (busy) return
    setBusy(true)
    setOutcome(null)
    try {
      const [result, store] = await Promise.all([load(), import('../../core/skills/store.ts')])
      const imported = result.skills
      await store.installSkills({ workspace: session.workspace, blobs: session.blobs }, imported)
      const skippedFiles = skippedCount(imported)
      const lines = [
        t('skills.imported', { count: imported.length }),
        t('skills.importedNames', { names: imported.map((s) => s.parsed.name).join(', ') }),
        ...(skippedFiles > 0 ? [t('skills.skippedFiles', { count: skippedFiles })] : []),
        ...result.problems,
      ]
      setOutcome({ kind: 'done', text: lines.join(' ') })
      return true
    } catch (error) {
      setOutcome({ kind: 'error', text: explain(error) })
      return false
    } finally {
      setBusy(false)
    }
  }

  const fromFolder = (picked: { name: string; files: PickedFile[] } | null) => {
    if (picked === null) return
    void run(async () => (await import('../../core/skills/import.ts')).importFromFiles(picked.files, picked.name))
  }

  return (
    <Screen title={t('skills.title')} subtitle={t('skills.lead')} back={paths.more}>
      <div className={styles.stack}>
        <section aria-labelledby="skills-installed" className={styles.section}>
          <h2 id="skills-installed" className={styles.sectionTitle}>
            {t('skills.installed')}
          </h2>
          {sorted.length === 0 ? (
            <p className={styles.note}>{t('skills.empty')}</p>
          ) : (
            <ul className={styles.skills}>
              {sorted.map((s) => (
                <SkillRow key={s.id} skill={s} />
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="skills-import" className={styles.section}>
          <h2 id="skills-import" className={styles.sectionTitle}>
            {t('skills.importTitle')}
          </h2>
          <p className={styles.note}>{t('skills.importHint')}</p>
          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault()
              const input = github.trim()
              if (input === '') return
              void run(async () => {
                const m = await import('../../core/skills/import.ts')
                return m.importFromGitHub(m.parseGitHubSource(input), skillsFetch)
              }).then((ok) => {
                if (ok) setGithub('')
              })
            }}
          >
            <Field
              label={t('skills.githubLabel')}
              hint={t('skills.githubHint')}
              placeholder={t('skills.githubPlaceholder')}
              value={github}
              onChange={(e) => setGithub(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              inputMode="url"
              enterKeyHint="go"
            />
            <Button type="submit" variant="primary" disabled={busy || github.trim() === ''} loading={busy}>
              {t('skills.githubImport')}
            </Button>
          </form>
          <div className={styles.actions}>
            <input
              id={zipId}
              className={styles.fileInput}
              type="file"
              accept=".zip,application/zip"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (file === undefined) return
                void run(async () => {
                  const [m, bytes] = await Promise.all([
                    import('../../core/skills/import.ts'),
                    file.arrayBuffer().then((b) => new Uint8Array(b)),
                  ])
                  return m.importFromZip(bytes, file.name)
                })
              }}
            />
            <label htmlFor={zipId} className={buttonClass({ variant: 'secondary' })} aria-disabled={busy}>
              {t('skills.zipImport')}
            </label>
            {canPickDirectory() ? (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  pickDirectory().then(fromFolder, (error: unknown) =>
                    setOutcome({ kind: 'error', text: explain(error) }),
                  )
                }}
              >
                {t('skills.folderImport')}
              </Button>
            ) : (
              <>
                <input
                  id={folderId}
                  className={styles.fileInput}
                  type="file"
                  disabled={busy}
                  // A directory input: every file of the picked folder, with its relative path.
                  {...{ webkitdirectory: '' }}
                  onChange={(e) => {
                    const list = e.target.files
                    if (list === null || list.length === 0) return
                    readDirectoryInput(list).then(fromFolder, (error: unknown) =>
                      setOutcome({ kind: 'error', text: explain(error) }),
                    )
                    e.target.value = ''
                  }}
                />
                <label htmlFor={folderId} className={buttonClass({ variant: 'secondary' })} aria-disabled={busy}>
                  {t('skills.folderImport')}
                </label>
              </>
            )}
          </div>
          {busy && (
            <p className={styles.note} role="status">
              {t('skills.importing')}
            </p>
          )}
          {outcome !== null && (
            <p
              className={outcome.kind === 'error' ? styles.error : styles.done}
              role={outcome.kind === 'error' ? 'alert' : 'status'}
              data-skill-import={outcome.kind}
            >
              {outcome.text}
            </p>
          )}
        </section>

        {trashed.length > 0 && (
          <ListGroup title={t('skills.trashedTitle')}>
            {trashed.map((s) => (
              <ListRow
                key={s.id}
                title={s.name}
                subtitle={s.description}
                trailing={
                  <Button
                    variant="plain"
                    aria-label={t('skills.restoreLabel', { name: s.name })}
                    onClick={() => session.workspace.collection('skills').restore(s.id)}
                  >
                    {t('skills.restore')}
                  </Button>
                }
              />
            ))}
          </ListGroup>
        )}
      </div>
    </Screen>
  )
}
