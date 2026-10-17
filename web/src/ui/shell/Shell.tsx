import { Info, Lock, type LucideIcon, MessageSquareLock } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import { Link, useLocation } from 'wouter'
import { sectionOf } from '../../app/hashLocation.ts'
import { paths } from '../../app/routes.ts'
import { useVault } from '../../app/vault.tsx'
import type { Key } from '../../i18n/index.ts'
import { useT } from '../../i18n/react.tsx'
import { PreviewBanner } from '../PreviewBanner.tsx'
import styles from './Shell.module.css'

interface Tab {
  readonly href: string
  readonly label: Extract<Key, `shell.nav${string}`>
  readonly icon: LucideIcon
}

const TABS: readonly Tab[] = [
  { href: paths.welcome, label: 'shell.navHome', icon: MessageSquareLock },
  { href: paths.about, label: 'shell.navAbout', icon: Info },
]

/**
 * After an in-app navigation, focus moves to the main landmark so a screen reader starts reading the new screen and
 * the next Tab press starts at its top; the first render leaves focus where the browser put it.
 */
function useFocusMainOnNavigation(path: string) {
  const main = useRef<HTMLElement>(null)
  const shown = useRef(path)
  useEffect(() => {
    if (shown.current === path) return
    shown.current = path
    main.current?.focus({ preventScroll: true })
    scrollTo({ top: 0 })
  }, [path])
  return main
}

/** Phones and narrow windows: content and a bottom tab bar. From 1000px: a sidebar and the content. */
export function Shell({ children }: { readonly children: ReactNode }) {
  const t = useT()
  const [location] = useLocation()
  const main = useFocusMainOnNavigation(location)
  const section = sectionOf(location)
  const { status, lock } = useVault()
  const canLock = status.state === 'unlocked' || status.state === 'locking'
  return (
    <div className={styles.shell}>
      {/* A button, not a "#main" link: the hash holds the route, so a fragment link would navigate away. */}
      <button type="button" className={styles.skip} onClick={() => main.current?.focus()}>
        {t('shell.skipToContent')}
      </button>
      <nav className={styles.nav} data-tabbar="" aria-label={t('shell.navMain')}>
        <p className={styles.brand}>{t('common.appName')}</p>
        <ul className={styles.tabs}>
          {TABS.map((tab) => {
            const Icon = tab.icon
            const active = section === tab.href
            return (
              <li key={tab.href}>
                <Link href={tab.href} className={styles.tab} aria-current={active ? 'page' : undefined}>
                  <Icon className={styles.tabIcon} size={22} strokeWidth={active ? 2.25 : 1.75} aria-hidden="true" />
                  <span>{t(tab.label)}</span>
                </Link>
              </li>
            )
          })}
        </ul>
        {canLock && (
          <button type="button" className={styles.lock} onClick={() => void lock()}>
            <Lock className={styles.tabIcon} size={22} strokeWidth={1.75} aria-hidden="true" />
            <span>{t('vault.lock')}</span>
          </button>
        )}
      </nav>
      <main id="main" ref={main} className={styles.main} tabIndex={-1}>
        <PreviewBanner />
        {children}
      </main>
    </div>
  )
}
