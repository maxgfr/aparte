import { useEffect, useRef } from 'react'
import { useLocation } from 'wouter'
import { useT } from '../i18n/react.tsx'
import { fromAppWorker } from '../pwa/routes.ts'
import { type ChatSession, useSession } from './chat.tsx'
import { readPref } from './prefs.ts'
import { chatPath } from './routes.ts'

/*
 * "Your answer is ready": an optional notification when an answer (or an image) finishes while the app is in the
 * background, so a long answer can be left to run. It works with the auto-lock rather than around it: a running
 * answer holds the vault lock (the chat controller's `chat-stream` hold), the lock comes only after the grace delay
 * that follows the answer, and a page that becomes visible after the idle period locks at once (app/vault.tsx). The
 * notification never carries the answer or the chat's title, which a lock screen would show to anyone: it says an
 * answer is ready and, when clicked, opens that chat (behind the lock screen if the vault has locked since).
 */

export type NotifyPermission = NotificationPermission | 'unsupported'

export function notificationPermission(): NotifyPermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

/** Asks for permission (from a user gesture, as browsers require). */
export async function requestNotifications(): Promise<NotifyPermission> {
  if (typeof Notification === 'undefined') return 'unsupported'
  try {
    return await Notification.requestPermission()
  } catch {
    return Notification.permission
  }
}

/** Whether a finished answer is announced: the user opted in, allowed it, and is looking elsewhere. */
export function shouldAnnounce(input: {
  readonly enabled: boolean
  readonly permission: NotifyPermission
  readonly visibility: DocumentVisibilityState
}): boolean {
  return input.enabled && input.permission === 'granted' && input.visibility === 'hidden'
}

async function announce(title: string, body: string, conversation: string, open: () => void): Promise<void> {
  const options: NotificationOptions = {
    body,
    // One notification at a time: a second answer replaces the first rather than stacking up.
    tag: 'aparte-answer',
    icon: `${import.meta.env.BASE_URL}pwa-192x192.png`,
    data: { conversation },
  }
  const registration =
    typeof navigator !== 'undefined' && 'serviceWorker' in navigator
      ? await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
      : undefined
  if (registration !== undefined) {
    // The service worker shows it, so a click reaches the app even from a phone's notification shade (src/sw.ts).
    await registration.showNotification(title, options)
    return
  }
  const notification = new Notification(title, options)
  notification.onclick = () => {
    globalThis.focus?.()
    open()
    notification.close()
  }
}

/** Conversations whose answer or image is running. */
function busy(session: ChatSession): Set<string> {
  const ids = new Set<string>(session.chat.streaming())
  for (const id of session.images.running()) ids.add(id)
  return ids
}

/** Announces finished answers while the app is hidden, and opens the chat a notification names. No UI. */
export function AnswerNotifier(): null {
  const t = useT()
  const session = useSession()
  const [, navigate] = useLocation()
  const seen = useRef<Set<string>>(new Set())
  // Read through refs: the subscriptions must not restart when the translator or the route changes.
  const tRef = useRef(t)
  tRef.current = t
  const go = useRef(navigate)
  go.current = navigate

  useEffect(() => {
    if (session === null) return
    seen.current = busy(session)
    const check = () => {
      const now = busy(session)
      const finished = [...seen.current].filter((id) => !now.has(id))
      seen.current = now
      if (finished.length === 0) return
      const announced = shouldAnnounce({
        enabled: readPref('notifyAnswers'),
        permission: notificationPermission(),
        visibility: document.visibilityState,
      })
      const last = finished[finished.length - 1]
      if (!announced || last === undefined) return
      const tr = tRef.current
      announce(tr('media.notificationTitle'), tr('media.notificationBody'), last, () =>
        go.current(chatPath(last)),
      ).catch(() => undefined)
    }
    const offChat = session.chat.subscribe((event) => {
      if (event === 'stream') check()
    })
    const offImages = session.images.subscribe(() => check())
    return () => {
      offChat()
      offImages()
    }
  }, [session])

  // A click handled by the service worker focuses this window and names the chat to open.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
    const onMessage = (event: MessageEvent<unknown>) => {
      const source = event.source instanceof ServiceWorker ? event.source : null
      if (!fromAppWorker(source, navigator.serviceWorker.controller, import.meta.env.BASE_URL)) return
      const data = event.data as { type?: unknown; conversation?: unknown } | null
      if (data?.type !== 'open-conversation' || typeof data.conversation !== 'string') return
      if (!/^[a-z2-7]{26}$/.test(data.conversation)) return
      go.current(chatPath(data.conversation))
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    return () => navigator.serviceWorker.removeEventListener('message', onMessage)
  }, [])

  return null
}
