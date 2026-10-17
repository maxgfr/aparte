import './ui/global.css'
import type { JSX } from 'react'
import { readPref } from './app/prefs.ts'
import { HashRouter, Routes } from './app/router.tsx'
import { applyTheme } from './app/theme.ts'
import { ToastProvider } from './app/toast.tsx'
import { detectFromEnvironment } from './i18n/index.ts'
import { I18nProvider } from './i18n/react.tsx'
import { Shell } from './ui/shell/Shell.tsx'
import { UpdateToast } from './ui/UpdateToast.tsx'

// The stored theme applies as this module evaluates, before the first render, so a dark choice never flashes light
// while the catalog loads.
applyTheme(readPref('theme'))

/** Only English ships for now; detection still runs so `?locale=pseudo` works for layout checks. */
const locale = detectFromEnvironment()

export function App(): JSX.Element {
  return (
    <I18nProvider locale={locale}>
      <ToastProvider>
        <HashRouter>
          <Shell>
            <Routes />
          </Shell>
        </HashRouter>
        <UpdateToast />
      </ToastProvider>
    </I18nProvider>
  )
}
