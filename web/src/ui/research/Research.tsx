import { Telescope } from 'lucide-react'
import { useEffect, useId, useMemo, useState } from 'react'
import { useSession } from '../../app/chat.tsx'
import { writePref } from '../../app/prefs.ts'
import { substitutedPath } from '../../app/research.ts'
import { usePref } from '../../app/usePref.ts'
import type { ModelDescriptor } from '../../core/contracts/ai.ts'
import type { StreamState } from '../../core/contracts/chat.ts'
import type {
  ReportLabels,
  ResearchBackendId,
  ResearchDepth,
  ResearchProgress,
  ResearchStep,
  ResearchTurn,
  Verification,
} from '../../core/contracts/research.ts'
import type { Message, Thread } from '../../core/contracts/workspace.ts'
import { BACKENDS, UNREACHABLE_BACKENDS } from '../../core/research/backends.ts'
import { researchProgress, researchTurn } from '../../core/research/history.ts'
import { reportHtml, reportMarkdown } from '../../core/research/report.ts'
import { verifyReport } from '../../core/research/verify.ts'
import { formatDate } from '../../i18n/format.ts'
import type { Key } from '../../i18n/index.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { isResearchMessage } from '../chat/view.ts'
import { Button } from '../components/Button.tsx'
import { IconButton } from '../components/IconButton.tsx'
import { Sheet } from '../components/Sheet.tsx'
import { SwitchRow } from '../components/Switch.tsx'
import { LinkSheet } from '../render/Sanitized.tsx'
import { fileStem, saveFile, today } from '../transfer/download.ts'
import styles from './Research.module.css'

/*
 * Deep research in the chat (core/contracts/research.ts): the composer control that turns it on and chooses its search
 * services, the progress of a research turn while it runs, and, under a report, its citation check, its sources and
 * its export as Markdown or as a self-contained HTML file. The report itself is the answer's sanitised Markdown; what
 * a page or the model wrote is shown as text, and links open through the link interstitial.
 */

const ENABLED_DEFAULT: readonly ResearchBackendId[] = BACKENDS.filter((b) => b.byDefault).map((b) => b.id)

/** The search services on for this device (app/prefs.ts `researchSources`), and their setter. */
export function useResearchSources(): readonly [
  ReadonlySet<ResearchBackendId>,
  (id: ResearchBackendId, on: boolean) => void,
] {
  const raw = usePref('researchSources')
  const on = useMemo(() => {
    const known = new Set<string>(BACKENDS.map((b) => b.id))
    const ids = raw === '' ? ENABLED_DEFAULT : raw.split(',').filter((id): id is ResearchBackendId => known.has(id))
    return new Set(ids.length === 0 ? ENABLED_DEFAULT : ids)
  }, [raw])
  const set = (id: ResearchBackendId, enable: boolean) => {
    const next = new Set(on)
    if (enable) next.add(id)
    else next.delete(id)
    // The last one stays on: research with no service at all would only have the model's own search.
    if (next.size === 0) return
    const sorted = [...next].sort()
    const isDefault =
      sorted.length === ENABLED_DEFAULT.length && [...ENABLED_DEFAULT].sort().every((d, i) => d === sorted[i])
    writePref('researchSources', isDefault ? '' : sorted.join(','))
  }
  return [on, set]
}

export interface ResearchButtonProps {
  readonly on: boolean
  /** The chat started without the research tools: research cannot be turned on in it. */
  readonly unavailable: boolean
  readonly model: ModelDescriptor | null
  readonly depth: ResearchDepth
  /** MCP tools that search, as the tool sheet names them. */
  readonly searchTools: readonly { readonly name: string; readonly title: string }[]
  readonly selectedSearchTools: ReadonlySet<string>
  /** The chat started: its tools, the MCP search tools included, are fixed. */
  readonly frozen: boolean
  readonly onChange: (on: boolean) => void
  readonly onSearchTool: (name: string, on: boolean) => void
}

/** The composer's Deep research control and its sheet. */
export function ResearchButton(props: ResearchButtonProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [sources, setSource] = useResearchSources()
  const webSearch = props.model?.capabilities.webSearch != null
  return (
    <>
      <IconButton
        icon={Telescope}
        label={props.on ? t('research.buttonOn') : t('research.button')}
        onClick={() => setOpen(true)}
        data-research={props.on ? 'on' : 'off'}
        aria-pressed={props.on}
      />
      <Sheet open={open} title={t('research.sheetTitle')} onClose={() => setOpen(false)}>
        <div className={styles.sheet}>
          <SwitchRow
            label={t('research.switchLabel')}
            hint={props.unavailable ? t('research.switchFrozen') : t('research.switchHint')}
            checked={props.on}
            disabled={props.unavailable}
            onChange={props.onChange}
          />
          <p className={styles.footnote}>{t('research.approvalNote')}</p>
          <p className={styles.footnote}>
            {t('research.depth', {
              queries: props.depth.queries,
              reads: props.depth.reads,
              rounds: props.depth.rounds,
            })}{' '}
            {t('research.depthHint')}
          </p>
          <p className={styles.footnote}>{webSearch ? t('research.webSearchOn') : t('research.webSearchOff')}</p>
          <section className={styles.group} aria-labelledby="research-sources">
            <h3 id="research-sources" className={styles.subtitle}>
              {t('research.sourcesTitle')}
            </h3>
            <p className={styles.footnote}>{t('research.sourcesHint')}</p>
            <div className={styles.switches}>
              {BACKENDS.map((b) => (
                <SwitchRow
                  key={b.id}
                  label={t(`research.backend_${b.id}` as Key)}
                  hint={`${t(`research.domain_${b.domain}` as Key)} · ${new URL(b.origins[0] ?? 'https://invalid').host}`}
                  checked={sources.has(b.id)}
                  onChange={(on) => setSource(b.id, on)}
                />
              ))}
            </div>
          </section>
          <section className={styles.group} aria-labelledby="research-mcp">
            <h3 id="research-mcp" className={styles.subtitle}>
              {t('research.mcpTitle')}
            </h3>
            {props.searchTools.length === 0 ? (
              <p className={styles.muted}>{t('research.mcpNone')}</p>
            ) : (
              <>
                <p className={styles.footnote}>{t('research.mcpHint')}</p>
                <div className={styles.switches}>
                  {props.searchTools.map((tool) => (
                    <SwitchRow
                      key={tool.name}
                      label={tool.title}
                      checked={props.selectedSearchTools.has(tool.name)}
                      disabled={props.frozen}
                      onChange={(on) => props.onSearchTool(tool.name, on)}
                    />
                  ))}
                </div>
              </>
            )}
          </section>
          <details className={styles.unreachable}>
            <summary>{t('research.unreachableTitle')}</summary>
            <p className={styles.footnote}>{t('research.unreachableHint')}</p>
            <ul className={styles.plainList}>
              {UNREACHABLE_BACKENDS.map((b) => (
                <li key={b.id}>
                  <span className={styles.mono}>{b.endpoint}</span> — {b.reason}
                </li>
              ))}
            </ul>
          </details>
        </div>
      </Sheet>
    </>
  )
}

const STEPS: readonly Exclude<ResearchStep, 'done'>[] = ['plan', 'search', 'read', 'write', 'verify']

/** Where a research turn stands while it runs: its steps, its counts, and a Stop. */
export function ResearchProgressPanel({ progress, onStop }: { progress: ResearchProgress; onStop: () => void }) {
  const t = useT()
  const now = progress.step === 'done' ? STEPS.length : STEPS.indexOf(progress.step)
  return (
    <section className={styles.progress} aria-label={t('research.progressLabel')} data-research-step={progress.step}>
      <ol className={styles.steps}>
        {STEPS.map((step, i) => {
          const state = i < now ? 'done' : i === now ? 'now' : 'waiting'
          return (
            <li key={step} className={styles.step} data-state={state}>
              <span className={styles.stepName}>{t(`research.step_${step}`)}</span>
              <span className="sr-only">
                {' '}
                {state === 'done'
                  ? t('research.stepDone')
                  : state === 'now'
                    ? t('research.stepNow')
                    : t('research.stepWaiting')}
              </span>
            </li>
          )
        })}
      </ol>
      <p className={styles.counts} role="status" aria-live="polite" data-research-counts="">
        {progress.rounds > 0 && <span>{t('research.rounds', { count: progress.rounds })} · </span>}
        {t('research.counts', { queries: progress.queries, results: progress.results, read: progress.read })}
        {progress.failed > 0 && <span> · {t('research.countsFailed', { count: progress.failed })}</span>}
      </p>
      <Button variant="secondary" onClick={onStop}>
        {t('research.stop')}
      </Button>
    </section>
  )
}

/**
 * The progress of the research turn streaming at the end of `path` (the branch on screen), or null when no research
 * turn runs: the counts come from the committed rounds (their large parts read from their blobs) and the live calls.
 */
export function useResearchProgress(path: readonly Message[], stream: StreamState | null): ResearchProgress | null {
  const session = useSession()
  const since = useMemo(() => {
    for (let i = path.length - 1; i >= 0; i--) {
      const m = path[i] as Message
      if (m.role === 'user') return isResearchMessage(m.parts) ? path.slice(i) : null
    }
    return null
  }, [path])
  const [committed, setCommitted] = useState<{ from: readonly Message[]; path: readonly Message[] } | null>(null)
  useEffect(() => {
    if (since === null || session === null) return
    let live = true
    substitutedPath(since, session.blobs).then(
      (resolved) => live && setCommitted({ from: since, path: resolved }),
      () => live && setCommitted({ from: since, path: since }),
    )
    return () => {
      live = false
    }
  }, [since, session])
  if (since === null || stream === null) return null
  const resolved = committed !== null && committed.from === since ? committed.path : since
  const streamingText = stream.phase === 'model' && stream.parts.some((p) => p.type === 'text' && p.text.trim() !== '')
  return researchProgress(resolved, {
    calls: stream.tools.map((c) => ({ name: c.name, status: c.status })),
    streamingText,
  })
}

export interface ResearchResult {
  readonly turn: ResearchTurn
  readonly verification: Verification
}

/**
 * The research turn an answer ends, with its citation check; null when the answer is not a research report (no research
 * playbook in the user message it answers, or it still calls tools).
 */
export function useResearchReport(thread: Thread, message: Message): ResearchResult | null {
  const session = useSession()
  const [result, setResult] = useState<{ id: string; value: ResearchResult | null } | null>(null)
  const candidate = useMemo(() => {
    if (message.role !== 'assistant' || message.status !== 'done') return null
    if (message.parts.some((p) => p.type === 'tool-call')) return null
    const path = thread.path(message.id)
    for (let i = path.length - 1; i >= 0; i--) {
      const m = path[i] as Message
      // The whole branch: a report may cite a source an earlier research turn read.
      if (m.role === 'user') return isResearchMessage(m.parts) ? path : null
    }
    return null
  }, [thread, message])
  useEffect(() => {
    if (candidate === null || session === null) return
    let live = true
    substitutedPath(candidate, session.blobs).then(
      (path) => {
        if (!live) return
        const turn = researchTurn(path, message.id)
        setResult({
          id: message.id,
          value:
            turn === null || turn.report === ''
              ? null
              : { turn, verification: verifyReport(turn.report, turn.sources, turn.snippets) },
        })
      },
      () => live && setResult({ id: message.id, value: null }),
    )
    return () => {
      live = false
    }
  }, [candidate, session, message.id])
  if (candidate === null || result === null || result.id !== message.id) return null
  return result.value
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** Under a research report: its citation check, the sources it read, and its exports. */
export function ResearchReportPanel({
  result,
  title,
  modelName,
}: {
  result: ResearchResult
  title: string
  modelName: string
}) {
  const t = useT()
  const locale = useLocale()
  const [link, setLink] = useState<string | null>(null)
  const headingId = useId()
  const { turn, verification: v } = result
  const quotesMissing = v.quotes.filter((q) => q.found === false)
  const unknown = v.citations.filter((c) => c.status === 'unknown')
  const walls = v.citations.filter((c) => c.status === 'wall')
  const badLinks = v.links.filter((l) => l.status !== 'fetched')
  const cited = new Set(v.citations.map((c) => c.id))
  const verdict =
    v.citations.length === 0
      ? t('research.verifyNoCitation')
      : v.ok
        ? t('research.verifyPassed')
        : t('research.verifyFailed')
  const labels: ReportLabels = {
    lang: locale,
    exported: t('research.exportedLine', { model: modelName, date: formatDate(locale, Date.now(), 'long') }),
    sources: t('research.sourcesTitleReport'),
    verification: t('research.exportVerification'),
    passed: t('research.exportPassed'),
    failed: t('research.exportFailed'),
    cited: t('research.exportCited'),
    unknownCitation: t('research.exportUnknownCitation'),
    unreadLink: t('research.exportUnreadLink'),
    quoteMissing: t('research.exportQuoteMissing'),
    numeralMissing: t('research.exportNumeralMissing'),
    uncited: t('research.exportUncited'),
    hints: t('research.exportHints'),
    wall: t('research.exportWall'),
    notRead: t('research.exportNotRead'),
  }
  const stem = `${fileStem(title, 'research')}-${today()}`
  return (
    <section className={styles.report} aria-labelledby={headingId} data-research-report={v.ok ? 'passed' : 'failed'}>
      <h3 id={headingId} className={styles.subtitle}>
        {t('research.verifyTitle')}
      </h3>
      <p className={styles.verdict} data-tone={v.ok ? 'ok' : 'alert'}>
        {verdict}
      </p>
      <ul className={styles.findings}>
        {v.citations.length > 0 && (
          <li>{t('research.citationsCount', { count: v.citations.reduce((n, c) => n + c.count, 0) })}</li>
        )}
        {unknown.map((c) => (
          <li key={`u:${c.id}`} data-tone="alert">
            {t('research.unknownCitation', { id: `[${c.id}]` })}
          </li>
        ))}
        {walls.map((c) => (
          <li key={`w:${c.id}`} data-tone="alert">
            {t('research.wallCitation', { id: `[${c.id}]` })}
          </li>
        ))}
        {badLinks.map((l) => (
          <li key={`l:${l.url}`} data-tone="alert">
            {l.status === 'snippet'
              ? t('research.snippetLink', { url: l.url })
              : t('research.unreadLink', { url: l.url })}
          </li>
        ))}
        {quotesMissing.map((q) => (
          <li key={`q:${q.text}`} data-tone="alert">
            {t('research.quoteMissing', { quote: q.text })}
          </li>
        ))}
        {v.numerals.map((n) => (
          <li key={`n:${n.claim}`} data-tone="warn">
            {t('research.numeralMissing', { figures: n.missing.join(', '), claim: n.claim })}
          </li>
        ))}
        {v.uncited.length > 0 && <li data-tone="warn">{t('research.uncited', { count: v.uncited.length })}</li>}
        {v.hints > 0 && <li>{t('research.hints', { count: v.hints })}</li>}
        {v.unused.length > 0 && <li>{t('research.unused', { count: v.unused.length })}</li>}
      </ul>
      {turn.sources.length > 0 && (
        <>
          <p className={styles.label}>{t('research.sourcesTitleReport')}</p>
          <ol className={styles.sources}>
            {turn.sources.map((s) => (
              <li key={s.id} data-source={s.id} data-cited={cited.has(s.id) ? 'yes' : 'no'}>
                <button type="button" className={styles.source} onClick={() => setLink(s.url)} data-href={s.url}>
                  <span className={styles.sourceId}>[{s.id}]</span>
                  <span className={styles.sourceTitle}>{s.title.trim() || hostOf(s.url)}</span>
                  <span className={styles.mono}>
                    {hostOf(s.url)} · {t(`research.sourceStatus_${s.status}`)}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
      <div className={styles.actions}>
        <Button
          variant="secondary"
          onClick={() => saveFile(reportMarkdown(turn, v, labels, title), `${stem}.md`, 'text/markdown')}
        >
          {t('research.exportMarkdown')}
        </Button>
        <Button
          variant="secondary"
          onClick={() => saveFile(reportHtml(turn, v, labels, title), `${stem}.html`, 'text/html')}
        >
          {t('research.exportHtml')}
        </Button>
      </div>
      <LinkSheet url={link} onClose={() => setLink(null)} />
    </section>
  )
}
