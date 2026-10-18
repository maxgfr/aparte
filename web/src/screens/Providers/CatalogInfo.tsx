import { type CatalogModel, type Reach, sortedModels } from '../../core/ai/catalog.ts'
import { formatNumber } from '../../i18n/format.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import styles from '../../ui/chat/Chat.module.css'

/*
 * What the full llm-models list says about a provider a browser cannot call directly: its badge, why, and the models
 * it lists with their context, input and features, so a user can judge it before setting up a proxy.
 */

/** How many catalog models the provider screen lists before "and N more". */
const SHOWN_MODELS = 8

/** The badge of a provider a browser cannot call directly; nothing for one it calls directly. */
export function ReachBadge({ reach }: { reach: Reach }) {
  const t = useT()
  if (reach === 'direct') return null
  return (
    <span className={styles.badge} data-reach={reach}>
      {reach === 'proxy' ? t('chat.providerBadgeProxy') : t('chat.providerBadgeNone')}
    </span>
  )
}

/** The badge and the explanation of a provider behind a proxy, or of one no adapter speaks to. */
export function ReachNotice({ reach, name }: { reach: Exclude<Reach, 'direct'>; name: string }) {
  const t = useT()
  return (
    <div className={styles.form} data-reach-notice={reach}>
      <span className={styles.badges}>
        <ReachBadge reach={reach} />
      </span>
      <p className={styles.warningText}>
        {reach === 'proxy' ? t('chat.providerProxyExplain', { name }) : t('chat.providerForeignExplain', { name })}
      </p>
    </div>
  )
}

/** The first models llm-models lists for a provider, newest first, with what each accepts. */
export function CatalogModels({ provider }: { provider: { readonly models: readonly CatalogModel[] } }) {
  const t = useT()
  const locale = useLocale()
  const models = sortedModels(provider)
  const shown = models.slice(0, SHOWN_MODELS)
  return (
    <section className={styles.form} aria-labelledby="catalog-models">
      <h2 id="catalog-models" className={styles.sectionTitle}>
        {t('chat.providerCatalogModels')}
      </h2>
      <ul className={styles.modelList}>
        {shown.map((m) => (
          <li key={m.id} className={styles.modelItem}>
            <span>
              <span className={styles.modelId}>{m.name}</span>
              {m.ctx !== undefined && (
                <span className={styles.caption}>
                  {' · '}
                  {t('chat.contextWindow', { count: formatNumber(locale, m.ctx, 0) })}
                </span>
              )}
            </span>
            <span className={styles.badges}>
              {m.in?.includes('image') && <span className={styles.badge}>{t('chat.badgeVision')}</span>}
              {m.in?.includes('pdf') && <span className={styles.badge}>{t('chat.badgePdf')}</span>}
              {m.t && <span className={styles.badge}>{t('chat.badgeTools')}</span>}
              {m.r && <span className={styles.badge}>{t('chat.badgeReasoning')}</span>}
            </span>
          </li>
        ))}
      </ul>
      {models.length > shown.length && (
        <p className={styles.footnote}>{t('chat.providerCatalogMore', { count: models.length - shown.length })}</p>
      )}
    </section>
  )
}
