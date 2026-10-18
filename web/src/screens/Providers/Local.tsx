import { Cpu, Download, Square, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useLocation } from 'wouter'
import { useSession } from '../../app/chat.tsx'
import { localModels, promptApi, WEBLLM_MODELS } from '../../app/local.ts'
import { modelsOf } from '../../app/providers.tsx'
import { newProviderPath, paths, providerPath } from '../../app/routes.ts'
import { useToast } from '../../app/toast.tsx'
import { providerFetch } from '../../core/ai/fetch.ts'
import { promptLanguages } from '../../core/ai/local/adapters.ts'
import { CHROME_AI_MODEL } from '../../core/ai/local/catalog.ts'
import { modelFit } from '../../core/ai/local/device.ts'
import { diagnoseServer, isSafari, type ServerVerdict } from '../../core/ai/local/diagnose.ts'
import type { ProviderConfig } from '../../core/contracts/ai.ts'
import {
  type DeviceVerdict,
  LocalModelError,
  type ModelCacheState,
  type PinnedModel,
  type PromptAvailability,
  type StorageEstimate,
} from '../../core/contracts/local.ts'
import { formatBytes, formatPercent } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import chatStyles from '../../ui/chat/Chat.module.css'
import { Button } from '../../ui/components/Button.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import styles from './Local.module.css'

/*
 * Models that run on this device: where they are added (the Models screen), the in-browser model manager (device
 * check, storage, download with progress and stop, deletion), Chrome's built-in model, and the diagnosis of a model
 * server on this computer. Downloads and the engine live in app/local.ts; the pinned list in core/ai/local.
 */

type T = ReturnType<typeof useT>

/** The "In this browser" group of the Models screen. */
export function DeviceSources() {
  const t = useT()
  const chrome = promptApi() !== undefined
  return (
    <ListGroup title={t('local.groupTitle')}>
      <ListRow
        href={newProviderPath({ from: 'device', id: 'webllm' })}
        title={t('local.webllmTitle')}
        subtitle={t('local.webllmSubtitle')}
      />
      <ListRow
        href={newProviderPath({ from: 'device', id: 'chrome-ai' })}
        title={t('local.chromeTitle')}
        subtitle={chrome ? t('local.chromeSubtitle') : t('local.chromeAbsent')}
      />
    </ListGroup>
  )
}

/** The service name of an on-device provider, or null for another kind. */
export function deviceServiceName(t: T, kind: ProviderConfig['kind']): string | null {
  if (kind === 'webllm') return t('local.serviceWebllm')
  if (kind === 'chrome-ai') return t('local.serviceChrome')
  return null
}

/** Adding an on-device provider (`/providers/new?device=webllm|chrome-ai`). */
export function NewDeviceProvider({ kind }: { kind: 'webllm' | 'chrome-ai' }) {
  const t = useT()
  const session = useSession()
  const [, navigate] = useLocation()
  if (session === null) return null
  const webllm = kind === 'webllm'
  const create = () => {
    const id = session.workspace.providers.create({
      kind,
      label: webllm ? t('local.webllmTitle') : t('local.chromeTitle'),
      syncKey: false,
      ...(webllm ? {} : { models: [CHROME_AI_MODEL], defaultModel: CHROME_AI_MODEL }),
    })
    navigate(providerPath(id), { replace: true })
  }
  return (
    <Screen title={webllm ? t('local.webllmTitle') : t('local.chromeTitle')} back={paths.providers}>
      <div className={chatStyles.form}>
        <p className={chatStyles.footnote}>{webllm ? t('local.newWebllmLead') : t('local.newChromeLead')}</p>
        <Button variant="primary" onClick={create}>
          {t('chat.providerCreate')}
        </Button>
      </div>
    </Screen>
  )
}

function deviceText(t: T, locale: ReturnType<typeof useLocale>, verdict: DeviceVerdict): string {
  if (verdict.supported) {
    const line = t('local.deviceOk', { memory: formatBytes(locale, verdict.gpu.memoryBudgetMB * 1_000_000) })
    return verdict.gpu.shaderF16 ? line : `${line} ${t('local.deviceNoF16')}`
  }
  if (verdict.reason === 'no-webgpu') return t('local.deviceNoWebgpu')
  if (verdict.reason === 'no-adapter') return t('local.deviceNoAdapter')
  return t('local.deviceTooLittle')
}

function errorText(t: T, error: unknown): string {
  if (error instanceof LocalModelError) {
    if (error.code === 'no-space') return t('local.errorNoSpace')
    if (error.code === 'unavailable') return t('local.errorUnavailable')
    if (error.code === 'integrity') return t('local.errorIntegrity')
  }
  return t('local.errorEngine', { message: error instanceof Error ? error.message : String(error) })
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

interface Running {
  readonly modelId: string
  readonly fraction: number
  readonly controller: AbortController
}

/** The in-browser models of a `webllm` provider: device, storage, and one row per pinned model. */
export function WebllmModels({ provider }: { provider: ProviderConfig }) {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const session = useSession()
  const titleId = useId()
  const [verdict, setVerdict] = useState<DeviceVerdict | null>(null)
  const [estimate, setEstimate] = useState<StorageEstimate | null | undefined>(undefined)
  const [states, setStates] = useState<ReadonlyMap<string, ModelCacheState>>(new Map())
  const [suggested, setSuggested] = useState<PinnedModel | null | undefined>(undefined)
  const [running, setRunning] = useState<Running | null>(null)
  const live = useRef(true)

  const refresh = useCallback(async () => {
    const service = localModels()
    const [v, e] = await Promise.all([service.detect(), service.estimate()])
    const entries = await Promise.all(
      WEBLLM_MODELS.map(async (m) => [m.id, await service.state(m.id).catch(() => null)] as const),
    )
    if (!live.current) return
    setVerdict(v)
    setEstimate(e)
    setStates(new Map(entries.filter((x): x is [string, ModelCacheState] => x[1] !== null)))
    const { recommend } = await import('../../core/ai/local/recommend.ts')
    if (live.current) setSuggested(recommend(v).model)
  }, [])

  useEffect(() => {
    live.current = true
    void refresh()
    return () => {
      live.current = false
    }
  }, [refresh])

  if (session === null) return null

  const download = async (model: PinnedModel) => {
    const controller = new AbortController()
    setRunning({ modelId: model.id, fraction: 0, controller })
    try {
      await localModels().download(
        model.id,
        (p) => live.current && setRunning((r) => (r?.modelId === model.id ? { ...r, fraction: p.fraction } : r)),
        controller.signal,
      )
      const now = modelsOf(provider)
      if (!now.includes(model.id)) {
        session.workspace.providers.update(provider.id, {
          models: [...now, model.id],
          ...(now.length === 0 ? { defaultModel: model.id } : {}),
        })
      }
      toast(t('local.downloadDone', { model: model.name }))
    } catch (e) {
      toast(isAbort(e) || controller.signal.aborted ? t('local.downloadStopped') : errorText(t, e))
    } finally {
      if (live.current) setRunning(null)
      await refresh()
    }
  }

  const remove = async (model: PinnedModel) => {
    try {
      await localModels().remove(model.id)
      const now = modelsOf(provider)
      if (now.includes(model.id)) {
        session.workspace.providers.update(provider.id, { models: now.filter((m) => m !== model.id) })
      }
      toast(t('local.deleted', { model: model.name }))
    } catch (e) {
      toast(errorText(t, e))
    } finally {
      await refresh()
    }
  }

  return (
    <>
      <section className={chatStyles.form} aria-labelledby={`${titleId}-device`}>
        <h2 id={`${titleId}-device`} className={chatStyles.sectionTitle}>
          {t('local.deviceTitle')}
        </h2>
        <p className={chatStyles.footnote} role="status">
          {verdict === null ? t('local.deviceChecking') : deviceText(t, locale, verdict)}
        </p>
        {estimate !== undefined && (
          <p className={chatStyles.footnote}>
            {estimate === null || estimate.usage === undefined || estimate.quota === undefined
              ? t('local.storageUnknown')
              : t('local.storageLine', {
                  used: formatBytes(locale, estimate.usage),
                  quota: formatBytes(locale, estimate.quota),
                })}
          </p>
        )}
        {verdict?.supported === true && suggested !== undefined && (
          <p className={chatStyles.footnote}>
            {suggested === null ? t('local.recommendNone') : t('local.recommended', { model: suggested.name })}
          </p>
        )}
      </section>

      <section className={chatStyles.form} aria-labelledby={`${titleId}-models`}>
        <h2 id={`${titleId}-models`} className={chatStyles.sectionTitle}>
          {t('local.modelsTitle')}
        </h2>
        <p className={chatStyles.footnote}>{t('local.modelsHint')}</p>
        <ul className={styles.models}>
          {WEBLLM_MODELS.map((model) => {
            const state = states.get(model.id)
            const fit = verdict?.supported === true ? modelFit(model, verdict.gpu) : null
            const busy = running?.modelId === model.id
            const complete = state?.complete === true
            const partial = !complete && state !== undefined && state.cachedBytes > 0
            const status = complete
              ? t('local.statusDownloaded')
              : partial
                ? t('local.statusPartial', {
                    done: formatBytes(locale, state.cachedBytes),
                    total: formatBytes(locale, state.totalBytes),
                  })
                : t('local.statusNone')
            return (
              <li key={model.id} className={styles.model} data-model={model.id}>
                <div className={styles.modelHead}>
                  <span className={styles.modelName}>
                    <Cpu size={16} strokeWidth={1.75} aria-hidden="true" />
                    {model.name}
                  </span>
                  <span className={chatStyles.badges}>
                    <span className={chatStyles.badge}>
                      {model.tools ? t('chat.badgeTools') : t('local.badgeNoTools')}
                    </span>
                    {model.reasoning && <span className={chatStyles.badge}>{t('chat.badgeReasoning')}</span>}
                  </span>
                </div>
                <span className={chatStyles.caption}>
                  {t('local.modelSize', {
                    size: formatBytes(locale, model.bytes),
                    memory: formatBytes(locale, model.vramMB * 1_000_000),
                  })}
                  {' · '}
                  {status}
                </span>
                {fit !== null && (
                  <span className={chatStyles.warningText}>
                    {fit === 'memory'
                      ? t('local.doesNotFitMemory')
                      : fit === 'f16'
                        ? t('local.doesNotFitF16')
                        : t('local.doesNotFitBinding')}
                  </span>
                )}
                {busy && (
                  <span className={styles.progressRow}>
                    <progress
                      className={styles.progress}
                      max={1}
                      value={running.fraction}
                      aria-label={t('local.downloadProgress', { model: model.name })}
                    />
                    <span className={chatStyles.caption} role="status" aria-live="polite">
                      {t('local.downloading', { model: model.name, percent: formatPercent(locale, running.fraction) })}
                    </span>
                  </span>
                )}
                <span className={chatStyles.sheetActions}>
                  {busy ? (
                    <Button
                      variant="secondary"
                      icon={<Square size={16} strokeWidth={1.75} aria-hidden="true" />}
                      onClick={() => running.controller.abort()}
                    >
                      {t('local.downloadStop')}
                    </Button>
                  ) : (
                    !complete && (
                      <Button
                        variant="secondary"
                        disabled={
                          running !== null || verdict?.supported !== true || fit === 'f16' || fit === 'storage-binding'
                        }
                        icon={<Download size={16} strokeWidth={1.75} aria-hidden="true" />}
                        onClick={() => void download(model)}
                        aria-label={
                          partial
                            ? t('local.downloadResumeNamed', { model: model.name })
                            : t('local.downloadNamed', { model: model.name })
                        }
                      >
                        {partial ? t('local.downloadResume') : t('local.download')}
                      </Button>
                    )
                  )}
                  {(complete || partial) && !busy && (
                    <Button
                      variant="plain"
                      icon={<Trash2 size={16} strokeWidth={1.75} aria-hidden="true" />}
                      onClick={() => void remove(model)}
                      aria-label={t('local.deleteNamed', { model: model.name })}
                    >
                      {t('local.delete')}
                    </Button>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      </section>
    </>
  )
}

/** Chrome's built-in model: whether this browser can run it, and its one-time download. */
export function ChromeAiStatus() {
  const t = useT()
  const locale = useLocale()
  const [availability, setAvailability] = useState<PromptAvailability | 'missing' | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const check = useCallback(async () => {
    const api = promptApi()
    if (api === undefined) {
      setAvailability('missing')
      return
    }
    setAvailability(await api.availability(promptLanguages()).catch(() => 'unavailable' as const))
  }, [])
  useEffect(() => {
    void check()
  }, [check])

  const download = async () => {
    const api = promptApi()
    if (api === undefined) return
    setProgress(0)
    try {
      const session = await api.create({
        ...promptLanguages(),
        monitor: (m) =>
          m.addEventListener('downloadprogress', (e) => setProgress((e as Event & { loaded?: number }).loaded ?? 0)),
      })
      session.destroy()
    } catch {
      // The status below says what Chrome thinks now.
    } finally {
      setProgress(null)
      await check()
    }
  }

  const text =
    availability === null
      ? t('local.chromeChecking')
      : availability === 'missing'
        ? t('local.chromeMissing')
        : availability === 'available'
          ? t('local.chromeAvailable')
          : availability === 'downloadable'
            ? t('local.chromeDownloadable')
            : availability === 'downloading'
              ? t('local.chromeDownloading')
              : t('local.chromeUnavailable')
  return (
    <section className={chatStyles.form} aria-label={t('local.chromeTitle')}>
      <p className={chatStyles.footnote} role="status">
        {progress === null ? text : t('local.chromeProgress', { percent: formatPercent(locale, progress) })}
      </p>
      {progress !== null && (
        <progress className={styles.progress} max={1} value={progress} aria-label={t('local.chromeDownload')} />
      )}
      {availability === 'downloadable' && progress === null && (
        <Button
          variant="secondary"
          icon={<Download size={16} strokeWidth={1.75} aria-hidden="true" />}
          onClick={() => void download()}
        >
          {t('local.chromeDownload')}
        </Button>
      )}
    </section>
  )
}

function verdictText(t: T, verdict: ServerVerdict, baseUrl: string, preset: string | undefined, origin: string) {
  switch (verdict.kind) {
    case 'ok':
      return [
        verdict.version === undefined
          ? t('local.diagOk', { count: verdict.models })
          : t('local.diagOkVersion', { version: verdict.version, count: verdict.models }),
      ]
    case 'http':
      return [t('local.diagHttp', { status: verdict.status })]
    case 'cors':
      return [
        t('local.diagCors'),
        preset === 'ollama'
          ? t('local.diagCorsOllama', { origin })
          : preset === 'lmstudio'
            ? t('local.diagCorsLmstudio')
            : preset === 'jan'
              ? t('local.diagCorsJan', { origin })
              : t('local.diagCorsOther', { origin }),
      ]
    case 'unreachable':
      return [t('local.diagUnreachable', { address: baseUrl })]
    case 'offline':
      return [t('local.diagOffline')]
  }
}

/** The help and diagnosis of a model server on this computer (Ollama, LM Studio, Jan, a custom loopback server). */
export function ServerDiagnosis({ baseUrl, preset }: { baseUrl: string; preset: string | undefined }) {
  const t = useT()
  const titleId = useId()
  const origin = location.origin
  const [running, setRunning] = useState(false)
  const [lines, setLines] = useState<readonly string[] | null>(null)
  const safari = isSafari(navigator.userAgent)
  const run = async () => {
    setRunning(true)
    setLines(null)
    try {
      const verdict = await diagnoseServer(baseUrl, preset, { get: providerFetch, online: navigator.onLine })
      setLines(verdictText(t, verdict, baseUrl, preset, origin))
    } finally {
      setRunning(false)
    }
  }
  return (
    <section className={chatStyles.help} aria-labelledby={titleId}>
      <h2 id={titleId} className={chatStyles.helpTitle}>
        {t('chat.localHelpTitle')}
      </h2>
      <p>{t('chat.localHelpCors', { origin })}</p>
      <p>{t('chat.localHelpLna', { origin })}</p>
      <p className={safari ? chatStyles.warningText : undefined}>{t('chat.localHelpSafari')}</p>
      <div className={chatStyles.sheetActions}>
        <Button variant="secondary" loading={running} disabled={baseUrl === ''} onClick={() => void run()}>
          {t('local.diagnoseRun')}
        </Button>
      </div>
      <div role="status" aria-live="polite" aria-label={t('local.diagnoseTitle')}>
        {running ? <p>{t('local.diagnoseRunning')}</p> : lines?.map((line) => <p key={line}>{line}</p>)}
      </div>
    </section>
  )
}
