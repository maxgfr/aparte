import { Redirect } from 'wouter'
import { useSessionState } from '../../app/chat.tsx'
import { useMcp, useMcpServers, useMcpStatus } from '../../app/mcp.tsx'
import { mcpServerPath, paths } from '../../app/routes.ts'
import { useVault } from '../../app/vault.tsx'
import type { McpServerConfig } from '../../core/contracts/mcp.ts'
import { useT } from '../../i18n/react.tsx'
import styles from '../../ui/chat/Chat.module.css'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import { CorsHelp, hostOf, useStatusText } from './status.tsx'

/** One server of the list: its name, its host and how it stands. */
function ServerRow({ server }: { readonly server: McpServerConfig }) {
  const status = useMcpStatus(server.id)
  const text = useStatusText()
  return (
    <ListRow
      href={mcpServerPath(server.id)}
      title={server.name}
      subtitle={`${hostOf(server.url)} · ${text(status, server)}`}
    />
  )
}

/** The MCP servers of this vault (`/mcp`). */
export default function McpServersScreen() {
  const t = useT()
  const { status } = useVault()
  const state = useSessionState()
  const servers = useMcpServers()
  useMcp()
  if (status.state === 'absent') return <Redirect to={paths.welcome} replace />
  if (state.status !== 'open') {
    return (
      <Screen title={t('mcp.title')} back={paths.providers}>
        <p className={styles.loading} role="status">
          {t('chat.sessionOpening')}
        </p>
      </Screen>
    )
  }
  return (
    <Screen title={t('mcp.title')} subtitle={t('mcp.lead')} back={paths.providers}>
      <ListGroup title={t('mcp.yours')} footer={servers.length === 0 ? t('mcp.empty') : undefined}>
        {servers.map((s) => (
          <ServerRow key={s.id} server={s} />
        ))}
      </ListGroup>
      <ListGroup>
        <ListRow href={paths.mcpNew} title={t('mcp.add')} subtitle={t('mcp.addHint')} />
      </ListGroup>
      <CorsHelp />
    </Screen>
  )
}
