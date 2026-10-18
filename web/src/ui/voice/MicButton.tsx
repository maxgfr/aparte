import { Loader, Mic, Square } from 'lucide-react'
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from 'react'
import { useSession } from '../../app/chat.tsx'
import { NoProviderError, transcribeRecording } from '../../app/media.ts'
import { usePref } from '../../app/usePref.ts'
import {
  type BrowserDictation,
  browserRecognitionSupported,
  RecordError,
  type Recording,
  recordingSupported,
  startBrowserDictation,
  startRecording,
} from '../../app/voice.ts'
import { hasSpeech } from '../../core/media/audio.ts'
import type { Key } from '../../i18n/index.ts'
import { useT } from '../../i18n/react.tsx'
import { cx } from '../cx.ts'
import styles from './Voice.module.css'

/*
 * The composer's microphone. A press starts dictation and the next press stops it; with push to talk, dictation runs
 * while the button is held (pointer, or Space and Enter on the keyboard). What was said is transcribed by the engine
 * this device chose (Whisper here by default) and handed to the field; the recording is never stored.
 */

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'recording' }
  | { readonly kind: 'transcribing'; readonly percent: number | null }

const FAILURES: Readonly<Record<RecordError['reason'], Extract<Key, `media.dictate${string}`>>> = {
  denied: 'media.dictateDenied',
  'no-microphone': 'media.dictateNoMicrophone',
  unsupported: 'media.dictateUnsupported',
  failed: 'media.dictateFailed',
}

export interface MicButtonProps {
  /** Receives the transcript of one dictation. */
  readonly onText: (text: string) => void
  /** Receives a status line to show (listening, transcribing, a failure), or null. */
  readonly onStatus: (status: string | null) => void
  readonly disabled?: boolean
}

export function MicButton({ onText, onStatus, disabled = false }: MicButtonProps) {
  const t = useT()
  const session = useSession()
  const engine = usePref('dictation')
  const hold = usePref('pushToTalk')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const recording = useRef<Recording | null>(null)
  const browser = useRef<BrowserDictation | null>(null)
  const abort = useRef<AbortController | null>(null)
  // A press that started dictation must not also stop it through the click that follows the pointer events.
  const held = useRef(false)
  /** The start in flight (asking for the microphone): a quick release waits for it, then stops what it started. */
  const starting = useRef<Promise<void> | null>(null)

  // Leaving the screen drops whatever is being recorded or transcribed.
  useEffect(
    () => () => {
      recording.current?.cancel()
      browser.current?.cancel()
      abort.current?.abort()
    },
    [],
  )

  const supported = engine === 'browser' ? browserRecognitionSupported() : recordingSupported()
  if (!supported || session === null) return null

  const fail = (error: unknown) => {
    setPhase({ kind: 'idle' })
    if (error instanceof DOMException && error.name === 'AbortError') {
      onStatus(null)
      return
    }
    if (error instanceof NoProviderError) onStatus(t('media.dictateNoProvider'))
    else if (error instanceof RecordError) onStatus(t(FAILURES[error.reason]))
    else onStatus(t('media.dictateFailed'))
  }

  const start = () => {
    if (phase.kind !== 'idle' || disabled || starting.current !== null) return
    setPhase({ kind: 'recording' })
    onStatus(hold ? t('media.dictateListeningHold') : t('media.dictateListening'))
    starting.current = (async () => {
      try {
        if (engine === 'browser') {
          browser.current = startBrowserDictation(navigator.language || document.documentElement.lang || 'en')
        } else {
          recording.current = await startRecording()
        }
      } catch (error) {
        recording.current = null
        browser.current = null
        fail(error)
      } finally {
        starting.current = null
      }
    })()
  }

  const stop = async () => {
    if (starting.current !== null) await starting.current
    if (recording.current === null && browser.current === null) return
    const rec = recording.current
    const dictation = browser.current
    recording.current = null
    browser.current = null
    setPhase({ kind: 'transcribing', percent: null })
    onStatus(t('media.dictateTranscribing'))
    try {
      let text: string
      if (dictation !== null) {
        text = await dictation.stop()
      } else if (rec !== null) {
        const samples = await rec.stop()
        if (!hasSpeech(samples)) {
          setPhase({ kind: 'idle' })
          onStatus(t('media.dictateNothing'))
          return
        }
        const controller = new AbortController()
        abort.current = controller
        try {
          text = await transcribeRecording(session, samples, {
            signal: controller.signal,
            onProgress: (p) => {
              const percent = p.total > 0 ? Math.min(100, Math.round((p.loaded / p.total) * 100)) : 0
              setPhase({ kind: 'transcribing', percent })
              // Once the model is here, what remains is the transcription itself.
              onStatus(percent >= 100 ? t('media.dictateTranscribing') : t('media.dictateDownloading', { percent }))
            },
          })
        } finally {
          samples.fill(0)
          abort.current = null
        }
      } else {
        return
      }
      setPhase({ kind: 'idle' })
      if (text.trim() === '') onStatus(t('media.dictateNothing'))
      else {
        onStatus(null)
        onText(text.trim())
      }
    } catch (error) {
      fail(error)
    }
  }

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (!hold || e.button !== 0) return
    held.current = true
    e.currentTarget.setPointerCapture?.(e.pointerId)
    start()
  }
  const onPointerUp = () => {
    if (!hold || !held.current) return
    held.current = false
    void stop()
  }
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!hold || (e.key !== ' ' && e.key !== 'Enter')) return
    e.preventDefault()
    if (!e.repeat) start()
  }
  const onKeyUp = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!hold || (e.key !== ' ' && e.key !== 'Enter')) return
    e.preventDefault()
    void stop()
  }
  const onClick = () => {
    if (hold) return
    if (phase.kind === 'recording') void stop()
    else start()
  }

  const recordingNow = phase.kind === 'recording'
  const label = recordingNow ? t('media.dictateStop') : hold ? t('media.dictateHold') : t('media.dictate')
  const Icon = phase.kind === 'transcribing' ? Loader : recordingNow ? Square : Mic
  return (
    <button
      type="button"
      className={cx(styles.mic, recordingNow && styles.micLive)}
      aria-label={label}
      title={label}
      aria-pressed={recordingNow}
      aria-busy={phase.kind === 'transcribing' || undefined}
      disabled={disabled || phase.kind === 'transcribing'}
      data-dictation={phase.kind}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onContextMenu={(e) => hold && e.preventDefault()}
    >
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" fill={recordingNow ? 'currentColor' : 'none'} />
    </button>
  )
}
