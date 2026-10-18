import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { BUILD, REPOSITORY } from '../../app/buildInfo.ts'
import { useTheme } from '../../app/theme.ts'
import type { Key } from '../../i18n/index.ts'
import { useT } from '../../i18n/react.tsx'
import { type NetPurpose, networkLog } from '../../security/net.ts'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import styles from './About.module.css'
import type { StorageState, TrustedTypesState, WorkerState } from './checks.ts'
import { storageState, subscribeWorker, trustedTypesState, workerState } from './probes.ts'

const TRUSTED_TYPES: Record<TrustedTypesState, Key> = {
  enforced: 'about.trustedTypesEnforced',
  available: 'about.trustedTypesAvailable',
  unsupported: 'about.trustedTypesUnsupported',
}

const WORKER: Record<WorkerState, Key> = {
  active: 'about.serviceWorkerActive',
  inactive: 'about.serviceWorkerInactive',
  unsupported: 'about.serviceWorkerUnsupported',
}

const STORAGE: Record<StorageState, Key> = {
  persisted: 'about.storagePersisted',
  'best-effort': 'about.storageBestEffort',
  unsupported: 'about.storageUnsupported',
}

const PURPOSES: Record<NetPurpose, Key> = {
  app: 'about.networkPurposeApp',
  provider: 'about.networkPurposeProvider',
  mcp: 'about.networkPurposeMcp',
  tool: 'about.networkPurposeTool',
  sync: 'about.networkPurposeSync',
  download: 'about.networkPurposeDownload',
  catalog: 'about.networkPurposeCatalog',
  skills: 'about.networkPurposeSkills',
  research: 'about.networkPurposeResearch',
}

const NO_REQUESTS: readonly never[] = []

const THEMES = ['system', 'light', 'dark'] as const

function useStorageState(): StorageState | null {
  const [state, setState] = useState<StorageState | null>(null)
  useEffect(() => {
    let live = true
    storageState().then((s) => live && setState(s))
    return () => {
      live = false
    }
  }, [])
  return state
}

/** About: this build, the protections in force in this page, where it runs, and where its source lives. */
export default function About() {
  const t = useT()
  const [theme, setTheme] = useTheme()
  // Trusted Types cannot change during a page's life: read once.
  const tt = useMemo(trustedTypesState, [])
  const worker = useSyncExternalStore(subscribeWorker, workerState, () => 'unsupported' as const)
  const storage = useStorageState()
  // The transparency panel: what web/src/security/net.ts recorded in this page, origin and purpose only.
  const contacted = useSyncExternalStore(networkLog.subscribe, networkLog.snapshot, () => NO_REQUESTS)
  const origin = location.origin

  return (
    <Screen title={t('about.title')}>
      <ListGroup title={t('about.buildTitle')}>
        <ListRow title={t('about.version')} trailing={<span className={styles.value}>{BUILD.version}</span>} />
        <ListRow title={t('about.commit')} trailing={<code className={styles.value}>{BUILD.commit}</code>} />
        <ListRow
          title={t('about.mode')}
          trailing={
            <span className={styles.value}>
              {t(BUILD.mode === 'production' ? 'about.modeProduction' : 'about.modeDevelopment')}
            </span>
          }
        />
      </ListGroup>

      <ListGroup title={t('about.protectionTitle')}>
        <ListRow
          wrap
          title={t('about.trustedTypes')}
          subtitle={t('about.trustedTypesHint')}
          trailing={
            <span className={styles.value} data-state={tt} data-testid="about-trusted-types">
              {t(TRUSTED_TYPES[tt])}
            </span>
          }
        />
        <ListRow
          wrap
          title={t('about.serviceWorker')}
          subtitle={t('about.serviceWorkerHint')}
          trailing={
            <span className={styles.value} data-state={worker} data-testid="about-service-worker">
              {t(WORKER[worker])}
            </span>
          }
        />
        <ListRow
          wrap
          title={t('about.storage')}
          subtitle={t('about.storageHint')}
          trailing={
            <span className={styles.value} data-state={storage ?? 'pending'} data-testid="about-storage">
              {storage === null ? t('common.loading') : t(STORAGE[storage])}
            </span>
          }
        />
      </ListGroup>

      <ListGroup title={t('about.networkTitle')} footer={t('about.networkHint')}>
        {contacted.length === 0 ? (
          <ListRow title={t('about.networkEmpty')} />
        ) : (
          contacted.map((entry) => (
            <ListRow
              key={`${entry.purpose} ${entry.origin}`}
              wrap
              title={<code className={styles.origin}>{entry.origin}</code>}
              subtitle={t(PURPOSES[entry.purpose])}
              trailing={<span className={styles.value}>{t('about.networkRequests', { count: entry.count })}</span>}
            />
          ))
        )}
      </ListGroup>

      <section className={styles.section} aria-labelledby="about-origin">
        <h2 id="about-origin" className={styles.sectionTitle}>
          {t('about.originTitle')}
        </h2>
        <p
          className={BUILD.dedicatedOrigin ? styles.note : styles.warning}
          role={BUILD.dedicatedOrigin ? undefined : 'note'}
          data-testid="about-origin"
        >
          {t(BUILD.dedicatedOrigin ? 'about.originDedicated' : 'about.originShared', { origin })}
        </p>
      </section>

      <section className={styles.section} aria-labelledby="about-appearance">
        <h2 id="about-appearance" className={styles.sectionTitle}>
          {t('about.appearanceTitle')}
        </h2>
        <Segmented
          label={t('about.theme')}
          value={theme}
          onChange={setTheme}
          options={THEMES.map((value) => ({
            value,
            label: t(
              value === 'system' ? 'about.themeSystem' : value === 'light' ? 'about.themeLight' : 'about.themeDark',
            ),
          }))}
        />
      </section>

      <ListGroup title={t('about.linksTitle')}>
        <ListRow title={t('about.sourceCode')} external={{ href: REPOSITORY, note: t('common.opensInNewTab') }} />
        <ListRow
          title={t('about.reportIssue')}
          external={{ href: `${REPOSITORY}/issues`, note: t('common.opensInNewTab') }}
        />
        <ListRow
          title={t('about.securityPolicy')}
          external={{ href: `${REPOSITORY}/security/policy`, note: t('common.opensInNewTab') }}
        />
      </ListGroup>
    </Screen>
  )
}
