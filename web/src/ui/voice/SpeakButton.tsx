import { Square, Volume2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useSession } from '../../app/chat.tsx'
import { NoProviderError, NoVoiceError, readAloud } from '../../app/media.ts'
import { useToast } from '../../app/toast.tsx'
import { usePref } from '../../app/usePref.ts'
import { localVoices, onVoicesChanged, type Speaking, speechSynthesisSupported } from '../../app/voice.ts'
import { useT } from '../../i18n/react.tsx'
import { IconButton } from '../components/IconButton.tsx'

/*
 * Reads one answer aloud (after cursus's SpeakButton, restricted to this device's own voices). With the device engine
 * the button shows only when the device has a voice that runs on it: a remote voice, which would send the answer to
 * the browser's maker, is never used. With a provider engine the text goes to the provider the user chose.
 */

/** Whether this device has a local voice, kept up to date as Chrome loads its voices. */
function useHasLocalVoice(): boolean {
  const [has, setHas] = useState(() => localVoices().length > 0)
  useEffect(() => {
    const update = () => setHas(localVoices().length > 0)
    update()
    return onVoicesChanged(update)
  }, [])
  return has
}

export function SpeakButton({ text }: { readonly text: string }) {
  const t = useT()
  const toast = useToast()
  const session = useSession()
  const engine = usePref('readAloud')
  const hasVoice = useHasLocalVoice()
  const [busy, setBusy] = useState(false)
  const speaking = useRef<Speaking | null>(null)
  const [playing, setPlaying] = useState(false)

  useEffect(() => () => speaking.current?.stop(), [])

  if (session === null || text.trim() === '') return null
  if (engine === 'device' && (!speechSynthesisSupported() || !hasVoice)) return null

  const toggle = async () => {
    if (speaking.current !== null) {
      speaking.current.stop()
      speaking.current = null
      setPlaying(false)
      return
    }
    setBusy(true)
    try {
      const handle = await readAloud(session, text)
      speaking.current = handle
      setPlaying(true)
      void handle.done.then(() => {
        if (speaking.current === handle) speaking.current = null
        setPlaying(false)
      })
    } catch (error) {
      toast(
        error instanceof NoVoiceError
          ? t('media.readNoVoice')
          : error instanceof NoProviderError
            ? t('media.readNoProvider')
            : t('media.readFailed'),
      )
    } finally {
      setBusy(false)
    }
  }

  const label = playing ? t('media.readStop') : t('media.readAloud')
  return (
    <IconButton
      icon={playing ? Square : Volume2}
      label={label}
      aria-pressed={playing}
      aria-busy={busy || undefined}
      disabled={busy}
      onClick={() => void toggle()}
    />
  )
}
