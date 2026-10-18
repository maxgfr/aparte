import { useEffect, useMemo, useState } from 'react'
import { useLocation, useSearch } from 'wouter'
import { useSessionState } from '../../app/chat.tsx'
import { draftText, useInbox } from '../../app/inbox.tsx'
import { paths } from '../../app/routes.ts'
import { useToast } from '../../app/toast.tsx'
import { useVault } from '../../app/vault.tsx'
import type { OpenedShare } from '../../core/inbox/session.ts'
import { formatRelative } from '../../i18n/format.ts'
import type { Key } from '../../i18n/index.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import chat from '../../ui/chat/Chat.module.css'
import { Button } from '../../ui/components/Button.tsx'
import { EmptyState } from '../../ui/components/EmptyState.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import styles from './Share.module.css'

/*
 * What other apps shared with Aparté (the share target), opened in memory once the vault is unlocked. Nothing is acted
 * on by itself: the user starts a chat with a share (its text in the field, its photos attached) or discards it. A
 * page of another site can post to the share target too, which is why a share is only ever offered.
 */

const RECEIVED: Readonly<Record<string, Extract<Key, `media.received${string}`>>> = {
  stored: 'media.receivedStored',
  'no-key': 'media.receivedNoKey',
  full: 'media.receivedFull',
  'too-large': 'media.receivedTooLarge',
  empty: 'media.receivedEmpty',
  invalid: 'media.receivedInvalid',
}

/** Thumbnails of a share's photos: object URLs of the decrypted bytes, revoked when the card goes. */
function Photos({ share }: { share: OpenedShare }) {
  const t = useT()
  const urls = useMemo(
    () =>
      share.content.header.files.flatMap((info, i) => {
        const bytes = share.content.files[i]
        if (!info.type.startsWith('image/') || bytes === undefined) return []
        return [{ url: URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: info.type })), name: info.name }]
      }),
    [share],
  )
  useEffect(
    () => () => {
      for (const u of urls) URL.revokeObjectURL(u.url)
    },
    [urls],
  )
  if (urls.length === 0) return null
  return (
    <ul className={styles.photos} aria-label={t('media.sharePhotos', { count: urls.length })}>
      {urls.map((u) => (
        <li key={u.url}>
          <img className={styles.photo} src={u.url} alt={u.name} />
        </li>
      ))}
    </ul>
  )
}

function ShareCard({ share }: { share: OpenedShare }) {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const [, navigate] = useLocation()
  const inbox = useInbox()
  const [busy, setBusy] = useState(false)
  const text = draftText(share.content)
  const others = share.content.header.files.filter((f) => !f.type.startsWith('image/')).length
  return (
    <article className={styles.card} data-share="">
      <p className={chat.caption}>
        {t('media.shareItem', { time: formatRelative(locale, share.content.header.time, Date.now()) })}
      </p>
      <Photos share={share} />
      {text !== '' && <p className={styles.text}>{text}</p>}
      {others > 0 && <p className={chat.muted}>{t('media.shareOtherFiles', { count: others })}</p>}
      <div className={chat.sheetActions}>
        <Button
          variant="primary"
          loading={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await inbox.take(share.id)
              navigate(paths.chat)
            } catch {
              toast(t('media.shareFailed'))
            } finally {
              setBusy(false)
            }
          }}
        >
          {t('media.shareStart')}
        </Button>
        <Button
          variant="plain"
          disabled={busy}
          onClick={async () => {
            await inbox.discard(share.id)
            toast(t('media.shareDiscarded'))
          }}
        >
          {t('media.shareDiscard')}
        </Button>
      </div>
    </article>
  )
}

export default function ShareScreen() {
  const t = useT()
  const { status } = useVault()
  const session = useSessionState()
  const inbox = useInbox()
  const received = new URLSearchParams(useSearch()).get('received')
  const note = received === null ? undefined : RECEIVED[received]

  // A share made before any vault existed was refused (no inbox key): there is nothing to unlock yet.
  if (status.state === 'absent') {
    return (
      <Screen title={t('media.shareTitle')}>
        <p className={chat.warningText} role="status">
          {t('media.receivedNoKey')}
        </p>
      </Screen>
    )
  }
  const loading = session.status !== 'open' || inbox.status === 'loading' || inbox.status === 'closed'
  return (
    <Screen title={t('media.shareTitle')} subtitle={t('media.shareLead')}>
      {note !== undefined && (
        <p className={received === 'stored' ? chat.muted : chat.warningText} role="status">
          {t(note)}
        </p>
      )}
      {inbox.lost > 0 && <p className={chat.warningText}>{t('media.shareLost', { count: inbox.lost })}</p>}
      {loading ? (
        <p className={chat.loading} role="status">
          {t('media.shareLoading')}
        </p>
      ) : inbox.status === 'failed' ? (
        <p className={chat.warningText} role="alert">
          {t('media.shareFailed')}
        </p>
      ) : inbox.shares.length === 0 ? (
        <EmptyState title={t('media.shareEmpty')} />
      ) : (
        <div className={styles.list}>
          {inbox.shares.map((share) => (
            <ShareCard key={share.id} share={share} />
          ))}
        </div>
      )}
    </Screen>
  )
}
