import { useId } from 'react'
import type { McpProblem, McpServerConfig, McpStatus } from '../../core/contracts/mcp.ts'
import { useT } from '../../i18n/react.tsx'
import styles from '../../ui/chat/Chat.module.css'

/** The host of a server address, as typed when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** What a problem means for the user. */
export function useProblemText(): (problem: McpProblem) => string {
  const t = useT()
  return (problem) => {
    switch (problem.kind) {
      case 'cors':
        return t('mcp.problemCors', { origin: location.origin })
      case 'unreachable':
        return t('mcp.problemUnreachable')
      case 'insecure':
        return t('mcp.problemInsecure')
      case 'auth':
        if (problem.detail === 'missing') return t('mcp.problemAuthMissing')
        if (problem.status !== undefined) return t('mcp.problemAuth', { status: problem.status })
        return t('mcp.problemSignIn')
      case 'http':
        return t('mcp.problemHttp', { status: problem.status })
      case 'timeout':
        return t('mcp.problemTimeout')
      case 'protocol':
        return t('mcp.problemProtocol')
    }
  }
}

/** One line saying how a server stands. */
export function useStatusText(): (status: McpStatus, server?: McpServerConfig) => string {
  const t = useT()
  const problem = useProblemText()
  return (status, server) => {
    switch (status.state) {
      case 'off':
        return server?.enabled === true ? t('mcp.statusConnecting') : t('mcp.statusOff')
      case 'connecting':
        return t('mcp.statusConnecting')
      case 'connected': {
        const count = status.tools.filter((tool) => tool.state === 'on').length
        return status.server === ''
          ? t('mcp.statusConnectedUnnamed', { count })
          : t('mcp.statusConnected', { count, server: status.server })
      }
      case 'needs-auth':
        if (status.signIn === 'preparing') return t('mcp.statusPreparing')
        if (status.signIn === 'waiting') return t('mcp.statusWaiting')
        if (status.signIn === 'failed') return status.problem ? problem(status.problem) : t('mcp.problemSignIn')
        return status.problem ? `${problem(status.problem)} ${t('mcp.statusSignIn')}` : t('mcp.statusSignIn')
      case 'error':
        return problem(status.problem)
    }
  }
}

/** Why some servers cannot be used from the browser, and the CLI bridge that will relay them. */
export function CorsHelp() {
  const t = useT()
  const id = useId()
  return (
    <section className={styles.help} aria-labelledby={id}>
      <h2 id={id} className={styles.helpTitle}>
        {t('mcp.corsTitle')}
      </h2>
      <p>{t('mcp.corsBody', { origin: location.origin })}</p>
    </section>
  )
}
