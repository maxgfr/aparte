import { Trash2, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { Redirect, useLocation, useSearch } from 'wouter'
import { useKeyedProviders, useProviders, useSession, useSessionState, useSetting } from '../../app/chat.tsx'
import {
  baseUrlProblem,
  catalogProviderOf,
  initialModels,
  isCallable,
  isLocalEndpoint,
  KEY_PAGES,
  LOCAL_PRESETS,
  localPresetOf,
  modelsOf,
  needsKey,
  sameModel,
  serviceName,
} from '../../app/providers.tsx'
import { paths, providerPath, providerSourceOf } from '../../app/routes.ts'
import { useToast } from '../../app/toast.tsx'
import { useVault } from '../../app/vault.tsx'
import { findProvider, providerFields, sortedModels } from '../../core/ai/catalog.ts'
import { normalizeBaseUrl } from '../../core/ai/endpoints.ts'
import { DEFAULT_BASE_URLS } from '../../core/ai/providers.ts'
import type { ConnectionCheck, ProviderConfig } from '../../core/contracts/ai.ts'
import { useT } from '../../i18n/react.tsx'
import styles from '../../ui/chat/Chat.module.css'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { IconButton } from '../../ui/components/IconButton.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'

/*
 * One provider: its name and address, its key on this device, a connection test, and the models it offers. The key is
 * written only to the provider-key local record (encrypted, never synced, never in the workspace documents).
 */

/** Whether a key may be stored: no surrounding whitespace, no control character, not empty. */
function keyProblem(key: string): boolean {
  return key === '' || key.trim() !== key || /\p{Cc}/u.test(key)
}

/** The host a key is sent to, for the hint under the key field. */
function hostOf(provider: Pick<ProviderConfig, 'kind' | 'baseUrl'>): string {
  const url = provider.baseUrl ?? DEFAULT_BASE_URLS[provider.kind] ?? ''
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function useBaseUrlError(value: string): string | undefined {
  const t = useT()
  if (value === '') return undefined
  const problem = baseUrlProblem(value)
  if (problem === 'invalid-endpoint') return t('chat.providerBaseUrlInvalid')
  if (problem === 'insecure-endpoint') return t('chat.providerBaseUrlInsecure')
  return undefined
}

function LocalHelp() {
  const t = useT()
  const origin = location.origin
  return (
    <section className={styles.help} aria-labelledby="local-help">
      <h2 id="local-help" className={styles.helpTitle}>
        {t('chat.localHelpTitle')}
      </h2>
      <p>{t('chat.localHelpCors', { origin })}</p>
      <p>{t('chat.localHelpLna', { origin })}</p>
      <p>{t('chat.localHelpSafari')}</p>
    </section>
  )
}

/** Creating a provider (`/providers/new?catalog=…`, `?local=…` or `?custom`). */
export function NewProvider() {
  const t = useT()
  const session = useSession()
  const [, navigate] = useLocation()
  const source = providerSourceOf(useSearch())
  const catalog = session?.catalog ?? null
  const entry = source.from === 'catalog' && catalog !== null ? findProvider(catalog, source.id) : undefined
  const local = source.from === 'local' ? LOCAL_PRESETS.find((p) => p.id === source.id) : undefined
  const fields = entry !== undefined ? providerFields(entry) : undefined
  const custom = entry === undefined
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setLabel(fields?.label ?? local?.name ?? '')
    setBaseUrl(fields === undefined ? (local?.endpoint ?? '') : '')
  }, [fields?.label, local?.name, local?.endpoint, fields])
  const baseError = useBaseUrlError(baseUrl)
  if (session === null) return null
  if (source.from === 'catalog' && catalog === null) {
    return (
      <Screen title={t('chat.providerNew')} back={paths.providers}>
        <p className={styles.loading} role="status">
          {t('chat.providerCatalogLoading')}
        </p>
      </Screen>
    )
  }
  const kind = fields?.kind ?? 'openai-compatible'
  const target = { kind, baseUrl: custom ? baseUrl : fields?.baseUrl }
  const keyNeeded = needsKey(target)
  const keyError = key !== '' && keyProblem(key) ? t('chat.providerKeyInvalid') : undefined
  const normalized = custom ? normalizeBaseUrl(baseUrl) : null
  // A custom endpoint left unnamed is called by its host, which is how the user typed it.
  const name = label.trim() !== '' ? label.trim() : custom && normalized !== null ? new URL(normalized).host : ''
  const ready = name !== '' && (!custom || normalized !== null) && (!keyNeeded || key !== '') && keyError === undefined
  const title = entry?.name ?? local?.name ?? t('chat.providerCustom')
  const keyPage = KEY_PAGES[kind] ?? entry?.doc

  const create = async () => {
    if (!ready) return
    setBusy(true)
    try {
      const models = entry !== undefined ? initialModels(entry) : local?.model !== undefined ? [local.model] : []
      const id = session.workspace.providers.create({
        kind,
        label: name,
        syncKey: false,
        ...(fields?.baseUrl === undefined ? {} : { baseUrl: fields.baseUrl }),
        ...(fields?.preset === undefined ? {} : { preset: fields.preset }),
        ...(custom && normalized !== null ? { baseUrl: normalized, preset: local?.id ?? 'custom' } : {}),
        ...(models.length === 0 ? {} : { models, defaultModel: models[0] as string }),
      })
      if (key !== '') await session.keys.set(id, key)
      navigate(providerPath(id), { replace: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen title={title} back={paths.providers}>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <Field
          label={t('chat.providerName')}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          // A custom endpoint may stay unnamed: it is then called by the host shown here.
          placeholder={custom && normalized !== null ? new URL(normalized).host : undefined}
          required={!custom}
        />
        {custom && (
          <Field
            label={t('chat.providerBaseUrl')}
            hint={t('chat.providerBaseUrlHint')}
            error={baseError}
            type="url"
            inputMode="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value.trim())}
            autoComplete="off"
            spellCheck={false}
            required
          />
        )}
        <Field
          label={t('chat.providerKey')}
          hint={keyNeeded ? t('chat.providerKeyHint', { host: hostOf(target) }) : t('chat.providerKeyOptional')}
          error={keyError}
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        {keyPage !== undefined && (
          <ListGroup>
            <ListRow title={t('chat.providerKeyGet')} external={{ href: keyPage, note: t('common.opensInNewTab') }} />
          </ListGroup>
        )}
        <Button type="submit" variant="primary" loading={busy} disabled={!ready}>
          {t('chat.providerCreate')}
        </Button>
      </form>
      {(local !== undefined || isLocalEndpoint(baseUrl)) && <LocalHelp />}
    </Screen>
  )
}

function checkText(t: ReturnType<typeof useT>, check: ConnectionCheck): string {
  if (check.ok) {
    return check.models === undefined
      ? t('chat.providerTestOk')
      : t('chat.providerTestOkModels', { count: check.models.length })
  }
  switch (check.reason) {
    case 'auth':
      return t('chat.providerTestAuth', { status: check.status ?? 401 })
    case 'auth-or-network':
      return t('chat.providerTestAuthOrNetwork')
    case 'http':
      return t('chat.providerTestHttp', { status: check.status ?? 0 })
    case 'timeout':
      return t('chat.providerTestTimeout')
    case 'config':
      return t('chat.providerTestConfig')
    case 'insecure':
      return t('chat.providerTestInsecure')
  }
}

/** One provider's settings (`/providers/<id>`). */
export function EditProvider({ id }: { id: string }) {
  const t = useT()
  const toast = useToast()
  const session = useSession()
  const [, navigate] = useLocation()
  useProviders()
  const provider = session?.workspace.providers.get(id)
  const keyed = useKeyedProviders()
  const defaultModel = useSetting('defaultModel')
  const keyId = useId()
  const [label, setLabel] = useState(provider?.label ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '')
  const [key, setKey] = useState('')
  const [newModel, setNewModel] = useState('')
  const [testing, setTesting] = useState<'test' | 'refresh' | null>(null)
  const [result, setResult] = useState<string | null>(null)
  useEffect(() => {
    setLabel(provider?.label ?? '')
    setBaseUrl(provider?.baseUrl ?? '')
  }, [provider?.label, provider?.baseUrl])
  const baseError = useBaseUrlError(baseUrl)

  if (session === null) return null
  if (provider === undefined || provider.deletedAt !== undefined) {
    return (
      <Screen title={t('chat.providerNotFound')} back={paths.providers}>
        {null}
      </Screen>
    )
  }
  const catalog = session.catalog
  const entry = catalogProviderOf(catalog, provider)
  const local = localPresetOf(provider)
  const custom = provider.kind === 'openai-compatible' && entry === undefined
  const keyPage = KEY_PAGES[provider.kind] ?? entry?.doc
  const suggestions = entry === undefined ? [] : sortedModels(entry).map((m) => m.id)
  // The service under the title, unless the provider is simply named after it.
  const service = serviceName(catalog, provider) ?? t('chat.providerCustom')
  const hasKey = keyed?.has(provider.id) === true
  const keyNeeded = needsKey(provider)
  const keyError = key !== '' && keyProblem(key) ? t('chat.providerKeyInvalid') : undefined
  const models = modelsOf(provider)
  const update = (patch: Parameters<typeof session.workspace.providers.update>[1]) =>
    session.workspace.providers.update(provider.id, patch)

  const run = async (mode: 'test' | 'refresh') => {
    setTesting(mode)
    setResult(null)
    try {
      const apiKey = await session.keys.get(provider.id)
      const check = await session.modules.adapters.testConnection(provider, apiKey)
      const listed = check.ok && check.models !== undefined ? [...check.models].sort() : []
      if (mode === 'refresh' && listed.length > 0) {
        update({ models: listed })
        setResult(t('chat.providerModelsRefreshed', { count: listed.length }))
      } else {
        // A provider with no model yet (a custom endpoint) offers the ones its server lists.
        if (listed.length > 0 && models.length === 0) update({ models: listed })
        setResult(checkText(t, check))
      }
    } finally {
      setTesting(null)
    }
  }

  return (
    <Screen title={provider.label} subtitle={service === provider.label ? undefined : service} back={paths.providers}>
      {!isCallable(provider.kind) && <p className={styles.warningText}>{t('chat.providerUnsupported')}</p>}
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault()
          const patch: { label?: string; baseUrl?: string } = {}
          if (label.trim() !== '' && label.trim() !== provider.label) patch.label = label.trim()
          const normalized = custom ? normalizeBaseUrl(baseUrl) : null
          if (normalized !== null && normalized !== provider.baseUrl) patch.baseUrl = normalized
          if (Object.keys(patch).length > 0) update(patch)
        }}
      >
        <Field label={t('chat.providerName')} value={label} onChange={(e) => setLabel(e.target.value)} />
        {custom && (
          <Field
            label={t('chat.providerBaseUrl')}
            hint={t('chat.providerBaseUrlHint')}
            error={baseError}
            type="url"
            inputMode="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value.trim())}
            autoComplete="off"
            spellCheck={false}
          />
        )}
        <Button
          type="submit"
          variant="secondary"
          disabled={label.trim() === provider.label && (!custom || baseUrl === (provider.baseUrl ?? ''))}
        >
          {t('chat.save')}
        </Button>
      </form>

      <form
        className={styles.form}
        aria-labelledby={keyId}
        onSubmit={async (e) => {
          e.preventDefault()
          if (key === '' || keyError !== undefined) return
          await session.keys.set(provider.id, key)
          setKey('')
          toast(t('chat.providerKeySaved'))
        }}
      >
        <h2 id={keyId} className={styles.sectionTitle}>
          {t('chat.providerKey')}
        </h2>
        {hasKey && <p className={styles.footnote}>{t('chat.providerKeyStored')}</p>}
        <Field
          label={t('chat.providerKey')}
          hideLabel
          hint={keyNeeded ? t('chat.providerKeyHint', { host: hostOf(provider) }) : t('chat.providerKeyOptional')}
          error={keyError}
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <div className={styles.sheetActions}>
          <Button type="submit" variant="primary" disabled={key === '' || keyError !== undefined}>
            {t('chat.providerKeySave')}
          </Button>
          {hasKey && (
            <Button
              variant="plain"
              onClick={async () => {
                await session.keys.delete(provider.id)
                toast(t('chat.providerKeyRemoved'))
              }}
            >
              {t('chat.providerKeyRemove')}
            </Button>
          )}
        </div>
        {keyPage !== undefined && (
          <ListGroup>
            <ListRow title={t('chat.providerKeyGet')} external={{ href: keyPage, note: t('common.opensInNewTab') }} />
          </ListGroup>
        )}
      </form>

      <div className={styles.form}>
        <div className={styles.sheetActions}>
          <Button loading={testing === 'test'} disabled={testing !== null} onClick={() => void run('test')}>
            {t('chat.providerTest')}
          </Button>
          <Button
            variant="plain"
            loading={testing === 'refresh'}
            disabled={testing !== null}
            onClick={() => void run('refresh')}
          >
            {t('chat.providerModelsRefresh')}
          </Button>
        </div>
        <p className={styles.footnote} role="status" aria-live="polite">
          {testing !== null ? t('chat.providerTesting') : (result ?? '')}
        </p>
      </div>

      <section className={styles.form} aria-labelledby={`${keyId}-models`}>
        <h2 id={`${keyId}-models`} className={styles.sectionTitle}>
          {t('chat.providerModels')}
        </h2>
        <p className={styles.footnote}>
          {models.length === 0 ? t('chat.providerModelsEmpty') : t('chat.providerModelsHint')}
        </p>
        <ul className={styles.modelList}>
          {models.map((model) => {
            const ref = { provider: provider.id, id: model }
            const isDefault = sameModel(defaultModel, ref)
            return (
              <li key={model} className={styles.modelItem}>
                <span className={styles.modelId}>{model}</span>
                <span className={styles.modelItemActions}>
                  {isDefault ? (
                    <span className={styles.caption}>{t('chat.providerIsDefault')}</span>
                  ) : (
                    <Button variant="plain" onClick={() => session.workspace.settings.set('defaultModel', ref)}>
                      {t('chat.providerMakeDefault')}
                    </Button>
                  )}
                  <IconButton
                    icon={X}
                    label={t('chat.providerModelRemove', { model })}
                    onClick={() => update({ models: models.filter((m) => m !== model) })}
                  />
                </span>
              </li>
            )
          })}
        </ul>
        <form
          className={styles.inlineForm}
          onSubmit={(e) => {
            e.preventDefault()
            const id = newModel.trim()
            if (id === '' || models.includes(id)) return
            update({ models: [...models, id] })
            setNewModel('')
          }}
        >
          <Field
            label={t('chat.providerModelAdd')}
            value={newModel}
            onChange={(e) => setNewModel(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            list={suggestions.length > 0 ? `${keyId}-suggestions` : undefined}
          />
          {suggestions.length > 0 && (
            <datalist id={`${keyId}-suggestions`}>
              {suggestions
                .filter((m) => !models.includes(m))
                .map((m) => (
                  <option key={m} value={m} />
                ))}
            </datalist>
          )}
          <Button type="submit" variant="secondary" disabled={newModel.trim() === ''}>
            {t('chat.providerModelAddButton')}
          </Button>
        </form>
      </section>

      {(local !== undefined || isLocalEndpoint(provider.baseUrl)) && <LocalHelp />}

      <Button
        variant="danger"
        icon={<Trash2 size={18} strokeWidth={1.75} aria-hidden="true" />}
        onClick={async () => {
          await session.keys.delete(provider.id).catch(() => undefined)
          session.workspace.providers.trash(provider.id)
          toast(t('chat.providerDeleted'))
          navigate(paths.providers, { replace: true })
        }}
      >
        {t('chat.providerDelete')}
      </Button>
    </Screen>
  )
}

/** `/providers/new` and `/providers/<id>`. */
export default function ProviderScreen({ params }: { params?: { id?: string } }) {
  const t = useT()
  const { status } = useVault()
  const state = useSessionState()
  if (status.state === 'absent') return <Redirect to={paths.welcome} replace />
  if (state.status !== 'open') {
    return (
      <Screen title={t('chat.providersTitle')} back={paths.providers}>
        <p className={styles.loading} role="status">
          {t('chat.sessionOpening')}
        </p>
      </Screen>
    )
  }
  const id = params?.id === undefined ? 'new' : decodeURIComponent(params.id)
  return id === 'new' ? <NewProvider /> : <EditProvider key={id} id={id} />
}
