import { Globe, Wrench } from 'lucide-react'
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react'
import { useRegisteredTools, useToolApprovals } from '../../app/chat.tsx'
import { useMcpServerName } from '../../app/mcp.tsx'
import type { ModelDescriptor } from '../../core/contracts/ai.ts'
import type { ToolCallState } from '../../core/contracts/chat.ts'
import type { ApprovalScope, ToolAnnotations } from '../../core/contracts/tools.ts'
import type { Part } from '../../core/contracts/workspace.ts'
import type { Key } from '../../i18n/index.ts'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../components/Button.tsx'
import { IconButton } from '../components/IconButton.tsx'
import { Segmented } from '../components/Segmented.tsx'
import { Sheet } from '../components/Sheet.tsx'
import { SwitchRow } from '../components/Switch.tsx'
import { LinkSheet } from '../render/Sanitized.tsx'
import styles from './Tools.module.css'

/*
 * Tools in the chat: the tool set of a chat (chosen before its first message, then fixed), each tool call as a recessed
 * card with its arguments and result, the approval a call waits for, the provider's web searches and the sources an
 * answer cites. Everything a model or a tool wrote is shown as text, never as markup; links open through the link
 * interstitial.
 */

type ResultPart = Extract<Part, { readonly type: 'tool-result' }>
type SourcePart = Extract<Part, { readonly type: 'source' }>

const BUILTIN_NAMES: Readonly<Record<string, Key>> = {
  current_time: 'tools.name_current_time',
  calculator: 'tools.name_calculator',
  search_conversations: 'tools.name_search_conversations',
  fetch_url: 'tools.name_fetch_url',
}

const BUILTIN_HINTS: Readonly<Record<string, Key>> = {
  current_time: 'tools.hint_current_time',
  calculator: 'tools.hint_calculator',
  search_conversations: 'tools.hint_search_conversations',
  fetch_url: 'tools.hint_fetch_url',
}

/**
 * What the interface calls a tool: a built-in by its translated name, any other by its own title (given, or the
 * registered tool's), else its name.
 */
export function useToolTitle(): (name: string, title?: string, source?: string | null) => string {
  const t = useT()
  const registered = useRegisteredTools()
  return (name, title, source) => {
    const key = source === 'builtin' || source === undefined ? BUILTIN_NAMES[name] : undefined
    if (key !== undefined) return t(key)
    return title ?? registered.find((r) => r.tool.name === name)?.tool.title ?? name
  }
}

/** One tool a chat may use, as the tool sheet lists it. */
export interface ToolOption {
  readonly name: string
  readonly title?: string
  readonly source: string
  readonly origin?: string
}

export interface ToolsButtonProps {
  readonly options: readonly ToolOption[]
  /** Names chosen (or, once frozen, the conversation's snapshot). */
  readonly selected: ReadonlySet<string>
  readonly webSearch: boolean
  /** The chat has started: its tools are fixed. */
  readonly frozen: boolean
  readonly model: ModelDescriptor | null
  /** Snapshot names that drifted or vanished since the chat started. */
  readonly drifted: readonly string[]
  readonly missing: readonly string[]
  readonly onToggle: (name: string, on: boolean) => void
  readonly onWebSearch: (on: boolean) => void
  readonly onRevoke: (approvalKey: string) => void
  /**
   * The user's correction of whether the model takes tools, offered when the catalog says it does not (or the user
   * already corrected it); null hides it.
   */
  readonly modelTools: { readonly checked: boolean; readonly onChange: (on: boolean) => void } | null
}

/** The Tools control of the composer and its sheet. */
export function ToolsButton(props: ToolsButtonProps) {
  const t = useT()
  const title = useToolTitle()
  const serverName = useMcpServerName()
  const [open, setOpen] = useState(false)
  const approvalsId = useId()
  const approvals = useToolApprovals().filter((a) => a.conversation === null)
  const canSearch = props.model?.capabilities.webSearch != null
  const takesTools = props.model?.capabilities.tools !== false
  const count = props.selected.size + (props.webSearch ? 1 : 0)
  const label = count === 0 ? t('tools.button') : t('tools.buttonOn', { count })
  return (
    <>
      <IconButton icon={Wrench} label={label} onClick={() => setOpen(true)} data-tools-count={count} />
      <Sheet open={open} title={t('tools.sheetTitle')} onClose={() => setOpen(false)}>
        <div className={styles.sheet}>
          <p className={styles.footnote}>{props.frozen ? t('tools.frozenHint') : t('tools.sheetIntro')}</p>
          {props.modelTools !== null ? (
            <SwitchRow
              label={t('tools.modelTools')}
              hint={t('tools.modelToolsHint')}
              checked={props.modelTools.checked}
              onChange={props.modelTools.onChange}
            />
          ) : (
            !takesTools && <p className={styles.warning}>{t('tools.noToolsModel')}</p>
          )}
          <div className={styles.switches}>
            <SwitchRow
              label={t('tools.webSearch')}
              hint={canSearch ? t('tools.webSearchHint') : t('tools.webSearchUnavailable')}
              checked={props.webSearch}
              disabled={props.frozen}
              onChange={props.onWebSearch}
            />
            {props.options.map((o) => {
              const hintKey = o.source === 'builtin' ? BUILTIN_HINTS[o.name] : undefined
              return (
                <SwitchRow
                  key={o.name}
                  label={title(o.name, o.title, o.source)}
                  hint={hintKey === undefined ? (serverName(o.origin) ?? o.origin) : t(hintKey)}
                  checked={props.selected.has(o.name)}
                  disabled={props.frozen}
                  onChange={(on) => props.onToggle(o.name, on)}
                />
              )
            })}
          </div>
          {props.drifted.map((name) => (
            <p key={`d:${name}`} className={styles.warning}>
              {t('tools.drifted', { name: title(name) })}
            </p>
          ))}
          {props.missing.map((name) => (
            <p key={`m:${name}`} className={styles.warning}>
              {t('tools.missing', { name: title(name) })}
            </p>
          ))}
          <section className={styles.approvals} aria-labelledby={approvalsId}>
            <h3 id={approvalsId} className={styles.subtitle}>
              {t('tools.approvalsTitle')}
            </h3>
            <p className={styles.footnote}>{t('tools.approvalsHint')}</p>
            {approvals.length === 0 ? (
              <p className={styles.muted}>{t('tools.approvalsEmpty')}</p>
            ) : (
              <ul className={styles.approvalList}>
                {approvals.map((a) => {
                  const [source = '', , name = a.approvalKey] = a.approvalKey.split(':')
                  const shown = title(name, undefined, source)
                  return (
                    <li key={a.approvalKey} className={styles.approvalRow}>
                      <span>{shown}</span>
                      <Button
                        variant="plain"
                        aria-label={t('tools.revokeLabel', { name: shown })}
                        onClick={() => props.onRevoke(a.approvalKey)}
                      >
                        {t('tools.revoke')}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </div>
      </Sheet>
    </>
  )
}

/** A box of code that scrolls, reachable by keyboard (set on the element: it is a scroll container, not a control). */
function CodeBox({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  useLayoutEffect(() => {
    if (ref.current) ref.current.tabIndex = 0
  }, [])
  return (
    <pre ref={ref} className={styles.code}>
      {children}
    </pre>
  )
}

/** A value as the card shows it: text as itself, anything else as indented JSON. */
function shown(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return String(value)
  }
}

const STATUS_KEYS: Readonly<Record<ToolCallState['status'] | 'pending', Key>> = {
  approval: 'tools.statusApproval',
  running: 'tools.statusRunning',
  done: 'tools.statusDone',
  failed: 'tools.statusFailed',
  denied: 'tools.statusDenied',
  refused: 'tools.statusRefused',
  skipped: 'tools.statusSkipped',
  pending: 'tools.statusPending',
}

const NOT_RUN_KEYS: Readonly<Record<string, Key>> = {
  denied: 'tools.notRunDenied',
  stopped: 'tools.notRunStopped',
  budget: 'tools.notRunBudget',
  undeclared: 'tools.notRunUndeclared',
  drifted: 'tools.notRunDrifted',
  missing: 'tools.notRunMissing',
  interrupted: 'tools.notRunInterrupted',
}

/** The status of a committed call, read from its result. */
function statusOf(result: ResultPart | undefined): ToolCallState['status'] | 'pending' {
  if (result === undefined) return 'pending'
  const notRun = (result.details as { notRun?: unknown } | undefined)?.notRun
  if (notRun === 'denied') return 'denied'
  if (notRun === 'stopped' || notRun === 'budget' || notRun === 'interrupted') return 'skipped'
  if (notRun === 'undeclared' || notRun === 'drifted' || notRun === 'missing') return 'refused'
  return result.isError ? 'failed' : 'done'
}

export function AnnotationChips({ annotations }: { annotations: ToolAnnotations }) {
  const t = useT()
  const chips: Key[] = [
    annotations.readOnly ? 'tools.readsOnly' : 'tools.changesThings',
    ...(annotations.destructive ? (['tools.destructive'] as const) : []),
    annotations.openWorld ? 'tools.openWorld' : 'tools.closedWorld',
  ]
  return (
    <span className={styles.chips}>
      {chips.map((key) => (
        <span
          key={key}
          className={styles.chip}
          data-tone={key === 'tools.readsOnly' || key === 'tools.closedWorld' ? 'calm' : 'alert'}
        >
          {t(key)}
        </span>
      ))}
    </span>
  )
}

export interface ToolCallCardProps {
  readonly call: Extract<Part, { readonly type: 'tool-call' }>
  readonly result?: ResultPart
  /** The live state of the call while its round runs. */
  readonly live?: ToolCallState
  readonly onApprove?: (callId: string, decision: ApprovalScope | 'deny') => void
}

/** One tool call: a recessed card, its arguments and result behind a disclosure, its approval inline. */
export function ToolCallCard({ call, result, live, onApprove }: ToolCallCardProps) {
  const t = useT()
  const title = useToolTitle()
  const serverName = useMcpServerName()
  const [scope, setScope] = useState<ApprovalScope>('once')
  const status = live?.status ?? statusOf(result)
  const name = title(call.name, live?.title, live?.source)
  const notRun = (result?.details as { notRun?: string } | undefined)?.notRun
  const notRunKey = notRun === undefined ? undefined : NOT_RUN_KEYS[notRun]
  const args = shown(call.input)
  const empty = call.input === null || (typeof call.input === 'object' && Object.keys(call.input).length === 0)
  const waiting = status === 'approval' && onApprove !== undefined
  return (
    <section
      className={styles.card}
      aria-label={t('tools.callLabel', { name })}
      data-tool-call={call.name}
      data-tool-status={status}
    >
      <p className={styles.cardHeader}>
        <Wrench size={16} strokeWidth={1.75} aria-hidden="true" />
        <span className={styles.cardName}>{name}</span>
        {live?.origin !== undefined && (
          <span className={styles.mono}>{t('tools.origin', { origin: serverName(live.origin) ?? live.origin })}</span>
        )}
        <span className={styles.status} data-tone={status} role={live ? 'status' : undefined}>
          {t(STATUS_KEYS[status])}
        </span>
      </p>
      {waiting ? (
        <div className={styles.approval}>
          <p className={styles.approvalTitle}>{t('tools.approveTitle', { name })}</p>
          <p className={styles.footnote}>{t('tools.approveBody')}</p>
          {live?.annotations && <AnnotationChips annotations={live.annotations} />}
          <p className={styles.label}>{t('tools.arguments')}</p>
          <CodeBox>{empty ? t('tools.argumentsEmpty') : args}</CodeBox>
          <Segmented
            label={t('tools.remember')}
            value={scope}
            onChange={setScope}
            options={[
              { value: 'once', label: t('tools.rememberOnce') },
              { value: 'conversation', label: t('tools.rememberConversation') },
              { value: 'always', label: t('tools.rememberAlways') },
            ]}
          />
          <div className={styles.approvalActions}>
            <Button variant="primary" onClick={() => onApprove(call.callId, scope)}>
              {t('tools.approve')}
            </Button>
            <Button variant="plain" onClick={() => onApprove(call.callId, 'deny')}>
              {t('tools.deny')}
            </Button>
          </div>
        </div>
      ) : (
        <details className={styles.details}>
          <summary className={styles.summary}>
            {result === undefined ? t('tools.arguments') : t('tools.argumentsAndResult')}
          </summary>
          <CodeBox>{empty ? t('tools.argumentsEmpty') : args}</CodeBox>
          {result !== undefined && (
            <>
              <p className={styles.label}>{t('tools.result')}</p>
              {notRunKey !== undefined ? (
                <p className={styles.footnote}>{t(notRunKey)}</p>
              ) : (
                <CodeBox>{shown(result.output)}</CodeBox>
              )}
            </>
          )}
        </details>
      )}
    </section>
  )
}

/** A provider's own web search in an answer: what it searched for (its results are the answer's sources). */
export function WebSearchNote({ block, live }: { block: unknown; live: boolean }) {
  const t = useT()
  const input = (block as { input?: { query?: unknown } } | null)?.input
  const query = typeof input?.query === 'string' ? input.query : ''
  return (
    <p className={styles.search}>
      <Globe size={16} strokeWidth={1.75} aria-hidden="true" />
      <span>
        {live ? t('tools.searching') : query === '' ? t('tools.searchedNoQuery') : t('tools.searched', { query })}
      </span>
    </p>
  )
}

/** Whether a part is a provider's own web search call (Anthropic `server_tool_use` of `web_search`). */
export function isWebSearchCall(part: Part): boolean {
  if (part.type !== 'provider') return false
  const block = part.block as { type?: unknown; name?: unknown } | null
  return block?.type === 'server_tool_use' && block.name === 'web_search'
}

/** The sources an answer cites, once each, as links behind the interstitial. */
export function SourcesList({ sources }: { sources: readonly SourcePart[] }) {
  const t = useT()
  const [link, setLink] = useState<string | null>(null)
  const seen = new Set<string>()
  const unique = sources.filter((s) => {
    if (s.url === undefined || seen.has(s.url)) return false
    seen.add(s.url)
    return true
  })
  if (unique.length === 0) return null
  return (
    <section className={styles.sources} aria-label={t('tools.sources')}>
      <p className={styles.label}>{t('tools.sources')}</p>
      <ol className={styles.sourceList}>
        {unique.map((s) => {
          let host = ''
          try {
            host = new URL(s.url as string).host
          } catch {
            host = ''
          }
          return (
            <li key={s.url}>
              <button
                type="button"
                className={styles.source}
                onClick={() => setLink(s.url as string)}
                data-href={s.url}
              >
                <span className={styles.sourceTitle}>{s.title?.trim() || t('tools.sourceUntitled')}</span>
                {host !== '' && <span className={styles.mono}>{host}</span>}
              </button>
            </li>
          )
        })}
      </ol>
      <LinkSheet url={link} onClose={() => setLink(null)} />
    </section>
  )
}
