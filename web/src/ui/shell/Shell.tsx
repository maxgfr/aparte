import { Info, LayoutGrid, Lock, type LucideIcon, MessagesSquare, RefreshCw, Sparkles, SquarePen } from 'lucide-react'
import { lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'wouter'
import { useSession } from '../../app/chat.tsx'
import { sectionOf } from '../../app/hashLocation.ts'
import { paths } from '../../app/routes.ts'
import { useToast } from '../../app/toast.tsx'
import { useVault } from '../../app/vault.tsx'
import type { Key } from '../../i18n/index.ts'
import { useT } from '../../i18n/react.tsx'
import styles from './Shell.module.css'

interface Tab {
  readonly href: string
  readonly label: Extract<Key, `shell.nav${string}` | `chat.nav${string}` | `sync.nav${string}`>
  readonly icon: LucideIcon
  /** Other sections this tab stands for (the Chats tab is current on a chat too). */
  readonly also?: readonly string[]
  /** Shown only while the vault is open. */
  readonly unlocked?: boolean
  /**
   * `narrow`: only on phones and narrow windows (the sidebar has its own "New chat"); `wide-or-locked`: hidden on a
   * narrow window while the vault is open.
   */
  readonly width?: 'narrow' | 'wide-or-locked'
}

const TABS: readonly Tab[] = [
  { href: paths.chat, label: 'chat.navNewChat', icon: SquarePen, unlocked: true, width: 'narrow' },
  { href: paths.conversations, label: 'chat.navChats', icon: MessagesSquare, also: [paths.chat], unlocked: true },
  { href: paths.providers, label: 'chat.navProviders', icon: Sparkles, also: [paths.mcp], unlocked: true },
  { href: paths.sync, label: 'sync.navSync', icon: RefreshCw, unlocked: true },
  {
    href: paths.more,
    label: 'shell.navMore',
    icon: LayoutGrid,
    unlocked: true,
    also: [
      paths.transfer,
      paths.characters,
      '/lorebooks',
      paths.arena,
      paths.stats,
      paths.knowledge,
      paths.protection,
      sectionOf(paths.protect),
    ],
  },
  // On a phone with the vault open, About is a row of More: the tab bar keeps six places.
  { href: paths.about, label: 'shell.navAbout', icon: Info, width: 'wide-or-locked' },
]

/**
 * Whether `tab` is the current screen: "New chat" on an empty chat (the home is one), "Chats" on the list and on an
 * open chat.
 */
function isCurrent(tab: Tab, location: string, section: string): boolean {
  const newChat = location === paths.chat || location === paths.home
  if (tab.href === paths.chat) return newChat
  if (tab.href === paths.conversations && newChat) return false
  return section === tab.href || tab.also?.includes(section) === true
}

/** Whether `tab` belongs on the bar for this window width and vault state. */
function isShown(tab: Tab, wide: boolean, unlocked: boolean): boolean {
  if (tab.unlocked === true && !unlocked) return false
  if (tab.width === 'narrow') return !wide
  if (tab.width === 'wide-or-locked') return wide || !unlocked
  return true
}

/** The conversation list of the sidebar, in the chat chunk: the first paint never waits on it. */
const SidebarList = lazy(() => import('../chat/ConversationList.tsx').then((m) => ({ default: m.ConversationList })))

/** Whether the window is wide enough for the sidebar (DESIGN.md: from 1000px). */
function useWide(): boolean {
  const query = '(min-width: 1000px)'
  const [wide, setWide] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const list = matchMedia(query)
    const onChange = () => setWide(list.matches)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }, [])
  return wide
}

/**
 * Writes the on-screen keyboard's height to `--kb-inset` (and `data-keyboard` on <html> while it is up) from the
 * visual viewport, so the composer sits on the keyboard's top edge and the bottom bar steps aside.
 */
function useKeyboardInset() {
  useEffect(() => {
    const vv = globalThis.visualViewport
    if (!vv) return
    const root = document.documentElement
    const update = () => {
      const inset = Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop))
      root.style.setProperty('--kb-inset', `${inset}px`)
      // Below this the difference is browser chrome (a collapsing address bar), not a keyboard.
      root.toggleAttribute('data-keyboard', inset > 120)
    }
    update()
    vv.addEventListener('resize', update)
    vv.addEventListener('scroll', update)
    return () => {
      vv.removeEventListener('resize', update)
      vv.removeEventListener('scroll', update)
      root.style.removeProperty('--kb-inset')
      root.removeAttribute('data-keyboard')
    }
  }, [])
}

/** The conversation id of a `/chat/<id>` location, or null. */
function chatIdOf(location: string): string | null {
  const m = /^\/chat\/([^/?]+)/.exec(location)
  if (!m?.[1]) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return null
  }
}

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
  const open = status.state === 'unlocked' || status.state === 'locking'
  // Anyone who opens this browser opens a `device` vault: there is nothing for a lock to protect.
  const canLock = open && status.protection === 'passphrase'
  // A lock asked for while an answer streams waits for it: said once, where the lock was pressed.
  const locking = status.state === 'locking'
  const toast = useToast()
  useEffect(() => {
    if (locking) toast(t('vault.lockDeferred'))
  }, [locking, toast, t])
  const session = useSession()
  const wide = useWide()
  useKeyboardInset()
  // The tab bar stays on a phone's chat too, so locking and the other screens are always one press away; it steps
  // aside only while the on-screen keyboard is up.
  return (
    <div className={styles.shell}>
      {/* A button, not a "#main" link: the hash holds the route, so a fragment link would navigate away. */}
      <button type="button" className={styles.skip} onClick={() => main.current?.focus()}>
        {t('shell.skipToContent')}
      </button>
      <nav className={styles.nav} data-tabbar="" aria-label={t('shell.navMain')}>
        <p className={styles.brand}>{t('common.appName')}</p>
        <ul className={styles.tabs}>
          {TABS.filter((tab) => isShown(tab, wide, open)).map((tab) => {
            const Icon = tab.icon
            const active = isCurrent(tab, location, section)
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
        {wide && session !== null && (
          <div className={styles.sidebarList}>
            <Suspense fallback={null}>
              <SidebarList compact activeId={chatIdOf(location)} />
            </Suspense>
          </div>
        )}
        {canLock && (
          <button type="button" className={styles.lock} onClick={() => void lock()}>
            <Lock className={styles.tabIcon} size={22} strokeWidth={1.75} aria-hidden="true" />
            <span>{t('vault.lock')}</span>
          </button>
        )}
      </nav>
      <main id="main" ref={main} className={styles.main} tabIndex={-1}>
        {children}
      </main>
    </div>
  )
}
