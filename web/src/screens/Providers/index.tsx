import { useMemo, useState } from 'react'
import { Redirect } from 'wouter'
import { useKeyedProviders, useProviders, useSession, useSessionState } from '../../app/chat.tsx'
import { isCallable, LOCAL_PRESETS, needsKey, serviceName } from '../../app/providers.tsx'
import { newProviderPath, paths, providerPath } from '../../app/routes.ts'
import { useVault } from '../../app/vault.tsx'
import { RECOMMENDED_PROVIDERS, sortedProviders } from '../../core/ai/catalog.ts'
import { useT } from '../../i18n/react.tsx'
import styles from '../../ui/chat/Chat.module.css'
import { matches, queryWords } from '../../ui/chat/view.ts'
import { Field } from '../../ui/components/Field.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { DeviceSources, deviceServiceName } from './Local.tsx'

/** The providers of this vault, and where a new one comes from: the catalog, a local server, a custom endpoint. */
export default function Providers() {
  const t = useT()
  const { status } = useVault()
  const state = useSessionState()
  const session = useSession()
  const providers = useProviders()
  const keyed = useKeyedProviders()
  const [query, setQuery] = useState('')
  const catalog = session?.catalog ?? null
  const hosted = useMemo(() => {
    if (catalog === null) return []
    const words = queryWords(query)
    const all = sortedProviders(catalog)
    if (words.length === 0) return all.filter((p) => RECOMMENDED_PROVIDERS.includes(p.id))
    return all.filter((p) => matches(`${p.name} ${p.id}`, words))
  }, [catalog, query])

  if (status.state === 'absent') return <Redirect to={paths.welcome} replace />
  if (state.status !== 'open') {
    return (
      <Screen title={t('chat.providersTitle')}>
        <p className={styles.loading} role="status">
          {t('chat.sessionOpening')}
        </p>
      </Screen>
    )
  }
  return (
    <Screen title={t('chat.providersTitle')} subtitle={t('chat.providersLead')}>
      <ListGroup
        title={t('chat.providersYours')}
        footer={providers.length === 0 ? t('chat.providersEmpty') : undefined}
      >
        {providers.map((p) => {
          const keyState = !isCallable(p.kind)
            ? t('chat.providerUnsupported')
            : !needsKey(p)
              ? t('chat.providerKeyless')
              : keyed?.has(p.id)
                ? t('chat.providerKeyOnDevice')
                : t('chat.providerKeyMissing')
          return (
            <ListRow
              key={p.id}
              href={providerPath(p.id)}
              title={p.label}
              subtitle={`${deviceServiceName(t, p.kind) ?? serviceName(catalog, p) ?? t('chat.providerCustom')} · ${keyState}`}
            />
          )
        })}
      </ListGroup>

      <section className={styles.form} aria-labelledby="providers-hosted">
        <h2 id="providers-hosted" className={styles.sectionTitle}>
          {t('chat.providerHosted')}
        </h2>
        <Field
          label={t('chat.providerSearch')}
          hideLabel
          type="search"
          placeholder={t('chat.providerSearch')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoComplete="off"
        />
        {catalog === null ? (
          <p className={styles.muted} role="status">
            {t('chat.providerCatalogLoading')}
          </p>
        ) : (
          <ListGroup
            title={t('chat.providerHosted')}
            hideTitle
            footer={
              hosted.length === 0
                ? t('chat.providerSearchNone')
                : query === ''
                  ? t('chat.providerSearchHint')
                  : undefined
            }
          >
            {hosted.map((p) => (
              <ListRow key={p.id} href={newProviderPath({ from: 'catalog', id: p.id })} title={p.name} />
            ))}
          </ListGroup>
        )}
      </section>

      <ListGroup title={t('mcp.entry')}>
        <ListRow href={paths.mcp} title={t('mcp.entry')} subtitle={t('mcp.entryHint')} />
      </ListGroup>

      <ListGroup title={t('chat.providerLocal')}>
        {LOCAL_PRESETS.map((preset) => (
          <ListRow
            key={preset.id}
            href={newProviderPath({ from: 'local', id: preset.id })}
            title={preset.name}
            subtitle={preset.endpoint}
          />
        ))}
        <ListRow
          href={newProviderPath({ from: 'custom' })}
          title={t('chat.providerCustom')}
          subtitle={t('chat.providerCustomHint')}
        />
      </ListGroup>

      <DeviceSources />
    </Screen>
  )
}
