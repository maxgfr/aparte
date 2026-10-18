import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Button } from '../ui/components/Button.tsx'
import { EmptyState } from '../ui/components/EmptyState.tsx'
import {
  applyDocumentLocale,
  type BaseLocale,
  createTranslator,
  type Locale,
  loadCatalog,
  loadedCatalog,
  type Translate,
} from './index.ts'

interface I18nValue {
  readonly locale: Locale
  readonly t: Translate
}

const I18nContext = createContext<I18nValue | null>(null)

/** Switches the interface language in place; resolves once the new catalog is applied. */
type SetLocale = (locale: Locale) => Promise<void>

const SetLocaleContext = createContext<SetLocale | null>(null)

/**
 * Provides the translator of `locale` (the initial one; `useSetLocale` changes it in place). A catalog is
 * fetched before it applies: nothing renders until the first one is there, and on a switch the previous
 * language stays on screen until the next one arrives (the tree is never unmounted).
 */
export function I18nProvider({ locale, children }: { readonly locale: Locale; readonly children: ReactNode }) {
  const [value, setValue] = useState<I18nValue | null>(() =>
    loadedCatalog(locale) === undefined ? null : { locale, t: createTranslator(locale) },
  )
  const [failed, setFailed] = useState(false)
  const latest = useRef(locale)
  const setLocale = useCallback<SetLocale>(async (next) => {
    latest.current = next
    await loadCatalog(next)
    if (latest.current === next) setValue({ locale: next, t: createTranslator(next) })
  }, [])
  useEffect(() => {
    // A catalog that cannot be fetched (offline before it was ever cached, or a deploy that removed the chunk)
    // leaves no translated text to show: the fallback below says so in plain words.
    setLocale(locale).catch(() => setFailed(true))
  }, [locale, setLocale])
  // Keyed on the value, not the locale: a device region change re-applies the regional <html lang>.
  useEffect(() => {
    if (value !== null) applyDocumentLocale(value.locale)
  }, [value])
  if (failed && value === null) return <CatalogFailed locale={locale} />
  if (value === null) return null
  return (
    <SetLocaleContext.Provider value={setLocale}>
      <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
    </SetLocaleContext.Provider>
  )
}

/**
 * Without a catalog there is no translated text: the few words needed are kept here, outside the catalogs,
 * keyed by language so a later locale adds its own line.
 */
const noCatalog: { readonly [L in BaseLocale]: readonly [string, string, string] } = {
  en: ['Aparté didn’t load.', 'Nothing on this device was changed. Check the connection, then reload.', 'Reload'],
  fr: [
    'Aparté n’a pas pu se charger.',
    'Rien n’a été modifié sur cet appareil. Vérifiez la connexion, puis rechargez.',
    'Recharger',
  ],
  de: [
    'Aparté konnte nicht geladen werden.',
    'Auf diesem Gerät wurde nichts geändert. Prüfen Sie die Verbindung und laden Sie dann neu.',
    'Neu laden',
  ],
}

function CatalogFailed({ locale }: { readonly locale: Locale }) {
  const [title, body, reload] = noCatalog[locale === 'pseudo' ? 'en' : locale]
  return (
    <main>
      <EmptyState
        title={title}
        body={body}
        action={
          <Button variant="primary" onClick={() => location.reload()}>
            {reload}
          </Button>
        }
      />
    </main>
  )
}

export function useSetLocale(): SetLocale {
  const value = useContext(SetLocaleContext)
  if (value === null) throw new Error('useSetLocale must be used inside <I18nProvider>')
  return value
}

function useI18n(): I18nValue {
  const value = useContext(I18nContext)
  if (value === null) throw new Error('useT must be used inside <I18nProvider>')
  return value
}

export function useT(): Translate {
  return useI18n().t
}

export function useLocale(): Locale {
  return useI18n().locale
}
