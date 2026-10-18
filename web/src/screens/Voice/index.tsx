import { useEffect, useId, useState } from 'react'
import { Redirect } from 'wouter'
import { type ChatSession, useProviders, useSession, useSessionState, useSetting } from '../../app/chat.tsx'
import { browserDictationConsent } from '../../app/consent.ts'
import { mediaProviders } from '../../app/media.ts'
import { type NotifyPermission, notificationPermission, requestNotifications } from '../../app/notify.tsx'
import { type Dictation, type ReadAloud, writePref } from '../../app/prefs.ts'
import { paths } from '../../app/routes.ts'
import { usePref } from '../../app/usePref.ts'
import { useVault } from '../../app/vault.tsx'
import type { ProviderConfig } from '../../core/contracts/ai.ts'
import type { ModelRef } from '../../core/contracts/workspace.ts'
import { useT } from '../../i18n/react.tsx'
import chat from '../../ui/chat/Chat.module.css'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { Sheet } from '../../ui/components/Sheet.tsx'
import { SwitchRow } from '../../ui/components/Switch.tsx'
import { cx } from '../../ui/cx.ts'
import { Screen } from '../../ui/shell/Screen.tsx'
import styles from './Voice.module.css'

/*
 * Voice and media: where dictation runs (this device by default; a provider; the browser's own service only after a
 * warning that it sends the voice away), push to talk, where answers are read aloud (this device's own voices by
 * default), and the "answer ready" notification. Engine choices are device preferences (app/prefs.ts); the provider
 * models are synced settings of the vault (no key: keys stay in their encrypted records).
 */

type What = 'transcription' | 'speech'

const SETTING: Record<What, 'transcriptionModel' | 'speechModel'> = {
  transcription: 'transcriptionModel',
  speech: 'speechModel',
}

/** The provider and model of a provider engine, saved to the vault's settings as they change. */
function ProviderModel({ session, what }: { session: ChatSession; what: What }) {
  const t = useT()
  const id = useId()
  const providers = useProviders()
  const current = useSetting(SETTING[what])
  const [offers, setOffers] = useState<readonly { provider: ProviderConfig; model: string }[] | null>(null)
  const [model, setModel] = useState(current?.id ?? '')

  useEffect(() => {
    let live = true
    void providers
    mediaProviders(session, what).then(
      (list) => live && setOffers(list),
      () => live && setOffers([]),
    )
    return () => {
      live = false
    }
  }, [session, what, providers])

  useEffect(() => {
    if (current !== null) setModel(current.id)
  }, [current])

  if (offers === null) return null
  if (offers.length === 0) return <p className={chat.muted}>{t('media.providerNone')}</p>
  const chosen = offers.find((o) => o.provider.id === current?.provider) ?? null
  const save = (ref: ModelRef | null) => session.workspace.settings.set(SETTING[what], ref)
  return (
    <div className={styles.pair}>
      {/* Radio rows rather than a native <select>: WebKit builds a select's menu with inline styles, which the
          strict policy (`style-src-attr 'none'`) refuses and reports. */}
      <fieldset className={chat.effortChoices}>
        <legend className={styles.label}>
          {what === 'transcription' ? t('media.transcriptionProvider') : t('media.speechProvider')}
        </legend>
        {offers.map((o) => {
          const selected = o.provider.id === chosen?.provider.id
          return (
            <label key={o.provider.id} className={cx(chat.pickerRow, selected && chat.pickerRowSelected)}>
              <span>{o.provider.label}</span>
              <input
                type="radio"
                name={`${id}-provider`}
                value={o.provider.id}
                checked={selected}
                onChange={() => {
                  setModel(o.model)
                  save({ provider: o.provider.id, id: o.model })
                }}
              />
            </label>
          )
        })}
      </fieldset>
      {chosen !== null && (
        <Field
          label={what === 'transcription' ? t('media.transcriptionModel') : t('media.speechModel')}
          value={model}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => {
            const next = model.trim()
            if (next !== '' && next !== current?.id) save({ provider: chosen.provider.id, id: next })
          }}
        />
      )}
      {chosen !== null && what === 'speech' && <VoiceField session={session} />}
    </div>
  )
}

function VoiceField({ session }: { session: ChatSession }) {
  const t = useT()
  const stored = useSetting('speechVoice') ?? ''
  const [voice, setVoice] = useState(stored)
  useEffect(() => setVoice(stored), [stored])
  return (
    <Field
      label={t('media.speechVoice')}
      hint={t('media.speechVoiceHint')}
      value={voice}
      autoComplete="off"
      spellCheck={false}
      onChange={(e) => setVoice(e.target.value)}
      onBlur={() => {
        const next = voice.trim()
        if (next !== stored) session.workspace.settings.set('speechVoice', next)
      }}
    />
  )
}

function useLocalVoiceCount(): number | null {
  const [count, setCount] = useState<number | null>(null)
  useEffect(() => {
    let off: () => void = () => undefined
    let live = true
    import('../../app/voice.ts').then((voice) => {
      if (!live) return
      const update = () => setCount(voice.speechSynthesisSupported() ? voice.localVoices().length : 0)
      update()
      off = voice.onVoicesChanged(update)
    })
    return () => {
      live = false
      off()
    }
  }, [])
  return count
}

function useBrowserRecognition(): boolean {
  const [supported, setSupported] = useState(false)
  useEffect(() => {
    let live = true
    import('../../app/voice.ts').then((voice) => live && setSupported(voice.browserRecognitionSupported()))
    return () => {
      live = false
    }
  }, [])
  return supported
}

export default function VoiceScreen() {
  const t = useT()
  const { status } = useVault()
  const state = useSessionState()
  const session = useSession()
  const dictation = usePref('dictation')
  const pushToTalk = usePref('pushToTalk')
  const readAloud = usePref('readAloud')
  const notify = usePref('notifyAnswers')
  const [confirmBrowser, setConfirmBrowser] = useState(false)
  const [permission, setPermission] = useState<NotifyPermission>(notificationPermission)
  const voices = useLocalVoiceCount()
  const browserService = useBrowserRecognition()

  if (status.state === 'absent') return <Redirect to={paths.home} replace />
  if (state.status !== 'open' || session === null) {
    return (
      <Screen title={t('media.settingsTitle')} back={paths.providers}>
        <p className={chat.loading} role="status">
          {t('chat.sessionOpening')}
        </p>
      </Screen>
    )
  }

  const engines: { value: Dictation; label: string }[] = [
    { value: 'local', label: t('media.engineLocal') },
    { value: 'api', label: t('media.engineApi') },
    ...(browserService || dictation === 'browser'
      ? [{ value: 'browser' as const, label: t('media.engineBrowser') }]
      : []),
  ]
  const engineHint =
    dictation === 'local'
      ? t('media.engineLocalHint')
      : dictation === 'api'
        ? t('media.engineApiHint')
        : t('media.engineBrowserHint')

  return (
    <Screen title={t('media.settingsTitle')} subtitle={t('media.settingsLead')} back={paths.providers}>
      <section className={styles.section} aria-labelledby="voice-dictation">
        <h2 id="voice-dictation" className={chat.sectionTitle}>
          {t('media.dictationTitle')}
        </h2>
        <Segmented
          label={t('media.dictationTitle')}
          hideLabel
          options={engines}
          value={dictation}
          onChange={(next) => {
            if (next === 'browser') setConfirmBrowser(true)
            else writePref('dictation', next)
          }}
        />
        <p className={dictation === 'browser' ? chat.warningText : chat.muted}>{engineHint}</p>
        {dictation === 'api' && <ProviderModel session={session} what="transcription" />}
        <SwitchRow
          label={t('media.pushToTalk')}
          hint={t('media.pushToTalkHint')}
          checked={pushToTalk}
          onChange={(on) => writePref('pushToTalk', on)}
        />
      </section>

      <section className={styles.section} aria-labelledby="voice-read">
        <h2 id="voice-read" className={chat.sectionTitle}>
          {t('media.readTitle')}
        </h2>
        <Segmented<ReadAloud>
          label={t('media.readTitle')}
          hideLabel
          options={[
            { value: 'device', label: t('media.readDevice') },
            { value: 'api', label: t('media.readApi') },
          ]}
          value={readAloud}
          onChange={(next) => writePref('readAloud', next)}
        />
        {readAloud === 'device' ? (
          voices !== null && (
            <p className={chat.muted}>
              {voices > 0 ? t('media.readDeviceHint', { count: voices }) : t('media.readDeviceNone')}
            </p>
          )
        ) : (
          <>
            <p className={chat.muted}>{t('media.readApiHint')}</p>
            <ProviderModel session={session} what="speech" />
          </>
        )}
      </section>

      <section className={styles.section} aria-labelledby="voice-notify">
        <h2 id="voice-notify" className={chat.sectionTitle}>
          {t('media.notifyTitle')}
        </h2>
        <SwitchRow
          label={t('media.notifyAnswers')}
          hint={t('media.notifyAnswersHint')}
          checked={notify && permission === 'granted'}
          disabled={permission === 'unsupported'}
          onChange={async (on) => {
            if (!on) {
              writePref('notifyAnswers', false)
              return
            }
            const granted = await requestNotifications()
            setPermission(granted)
            writePref('notifyAnswers', granted === 'granted')
          }}
        />
        {permission === 'denied' && <p className={chat.warningText}>{t('media.notifyDenied')}</p>}
        {permission === 'unsupported' && <p className={chat.muted}>{t('media.notifyUnsupported')}</p>}
      </section>

      <Sheet open={confirmBrowser} title={t('media.browserConfirmTitle')} onClose={() => setConfirmBrowser(false)}>
        <div className={chat.form}>
          <p className={chat.footnote}>{t('media.browserConfirmBody')}</p>
          <div className={chat.sheetActions}>
            <Button
              variant="danger"
              onClick={() => {
                browserDictationConsent.give()
                writePref('dictation', 'browser')
                setConfirmBrowser(false)
              }}
            >
              {t('media.browserConfirm')}
            </Button>
            <Button variant="plain" onClick={() => setConfirmBrowser(false)}>
              {t('chat.cancel')}
            </Button>
          </div>
        </div>
      </Sheet>
    </Screen>
  )
}
