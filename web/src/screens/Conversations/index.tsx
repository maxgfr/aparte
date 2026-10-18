import { Redirect } from 'wouter'
import { useSessionState } from '../../app/chat.tsx'
import { paths } from '../../app/routes.ts'
import { useVault } from '../../app/vault.tsx'
import { useT } from '../../i18n/react.tsx'
import styles from '../../ui/chat/Chat.module.css'
import { ConversationList } from '../../ui/chat/ConversationList.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'

/** The conversation list as a screen of its own (phones and narrow windows; the sidebar holds it from 1000px). */
export default function Conversations() {
  const t = useT()
  const { status } = useVault()
  const state = useSessionState()
  if (status.state === 'absent') return <Redirect to={paths.home} replace />
  return (
    <Screen title={t('chat.listTitle')}>
      {state.status === 'open' ? (
        <ConversationList />
      ) : (
        <p className={styles.loading} role="status">
          {t('chat.sessionOpening')}
        </p>
      )}
    </Screen>
  )
}
