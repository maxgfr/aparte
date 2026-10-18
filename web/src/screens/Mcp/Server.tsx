import { Trash2 } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { Redirect, useLocation } from 'wouter'
import { useSession, useSessionState } from '../../app/chat.tsx'
import { useMcp, useMcpServer, useMcpStatus } from '../../app/mcp.tsx'
import { mcpServerPath, paths } from '../../app/routes.ts'
import { useToast } from '../../app/toast.tsx'
import { useVault } from '../../app/vault.tsx'
import type {
  McpAuthKind,
  McpSecret,
  McpServerConfig,
  McpToolView,
  McpTransportKind,
} from '../../core/contracts/mcp.ts'
import { prefixFor } from '../../core/mcp/mapping.ts'
import { checkSecret } from '../../core/mcp/secrets.ts'
import type { Translate } from '../../i18n/index.ts'
import { useT } from '../../i18n/react.tsx'
import styles from '../../ui/chat/Chat.module.css'
import { AnnotationChips } from '../../ui/chat/Tools.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { Segmented } from '../../ui/components/Segmented.tsx'
import { SwitchRow } from '../../ui/components/Switch.tsx'
import { Screen } from '../../ui/shell/Screen.tsx'
import mcpStyles from './Mcp.module.css'
import { CorsHelp, hostOf, useStatusText } from './status.tsx'

/*
 * One MCP server: its address, transport and authentication (synced, encrypted in the workspace), its credential
 * (device-only: a token, a header, or the tokens of an OAuth sign-in), its connection test and its tools, each turned
 * on or off by the user. A tool whose definition changed is held back until the user accepts it again. Everything the
 * server says about its tools is shown as text.
 */

type UrlProblem = 'invalid' | 'insecure' | 'query' | null

/** Why an address cannot be a server's, as the workspace would refuse it (core/workspace/workspace.ts). */
function urlProblem(text: string): UrlProblem {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return 'invalid'
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return 'insecure'
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return 'query'
  return null
}

function urlError(t: Translate, problem: UrlProblem): string | undefined {
  if (problem === 'invalid') return t('mcp.urlInvalid')
  if (problem === 'insecure') return t('mcp.urlInsecure')
  if (problem === 'query') return t('mcp.urlQuery')
  return undefined
}

/** The secret a credential form describes, or why it cannot be stored. */
function secretOf(
  auth: McpAuthKind,
  token: string,
  headerName: string,
  headerValue: string,
): { secret: McpSecret } | { error: 'value' | 'name' } | null {
  if (auth === 'bearer') {
    if (token === '') return null
    try {
      return { secret: checkSecret({ kind: 'bearer', token }) }
    } catch {
      return { error: 'value' }
    }
  }
  if (auth === 'headers') {
    if (headerName === '' && headerValue === '') return null
    try {
      checkSecret({ kind: 'headers', headers: { [headerName]: 'x' } })
    } catch {
      return { error: 'name' }
    }
    try {
      return { secret: checkSecret({ kind: 'headers', headers: { [headerName]: headerValue } }) }
    } catch {
      return { error: 'value' }
    }
  }
  return null
}

function TransportPicker({ value, onChange }: { value: McpTransportKind; onChange: (v: McpTransportKind) => void }) {
  const t = useT()
  return (
    <Segmented
      label={t('mcp.transport')}
      value={value}
      onChange={onChange}
      options={[
        { value: 'http', label: t('mcp.transportHttp') },
        { value: 'sse', label: t('mcp.transportSse') },
      ]}
    />
  )
}

function AuthPicker({ value, onChange }: { value: McpAuthKind; onChange: (v: McpAuthKind) => void }) {
  const t = useT()
  return (
    <Segmented
      label={t('mcp.auth')}
      value={value}
      onChange={onChange}
      options={[
        { value: 'none', label: t('mcp.authNone') },
        { value: 'oauth', label: t('mcp.authOauth') },
        { value: 'bearer', label: t('mcp.authBearer') },
        { value: 'headers', label: t('mcp.authHeaders') },
      ]}
    />
  )
}

/** The fields of a credential (a token, or one header), never shown once typed. */
function CredentialFields(props: {
  auth: McpAuthKind
  token: string
  setToken: (v: string) => void
  headerName: string
  setHeaderName: (v: string) => void
  headerValue: string
  setHeaderValue: (v: string) => void
  error: 'value' | 'name' | null
}) {
  const t = useT()
  if (props.auth === 'bearer') {
    return (
      <Field
        label={t('mcp.token')}
        hint={t('mcp.tokenHint')}
        error={props.error === 'value' ? t('mcp.secretInvalid') : undefined}
        type="password"
        value={props.token}
        onChange={(e) => props.setToken(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
    )
  }
  if (props.auth === 'headers') {
    return (
      <>
        <Field
          label={t('mcp.headerName')}
          error={props.error === 'name' ? t('mcp.headerNameInvalid') : undefined}
          value={props.headerName}
          onChange={(e) => props.setHeaderName(e.target.value.trim())}
          autoComplete="off"
          spellCheck={false}
          placeholder={t('mcp.headerNamePlaceholder')}
        />
        <Field
          label={t('mcp.headerValue')}
          hint={t('mcp.headerHint')}
          error={props.error === 'value' ? t('mcp.secretInvalid') : undefined}
          type="password"
          value={props.headerValue}
          onChange={(e) => props.setHeaderValue(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </>
    )
  }
  if (props.auth === 'oauth') return <p className={styles.footnote}>{t('mcp.authOauthHint')}</p>
  return null
}

/** Adding a server (`/mcp/new`). */
function NewServer() {
  const t = useT()
  const session = useSession()
  const mcp = useMcp()
  const [, navigate] = useLocation()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [transport, setTransport] = useState<McpTransportKind>('http')
  const [auth, setAuth] = useState<McpAuthKind>('none')
  const [token, setToken] = useState('')
  const [headerName, setHeaderName] = useState('')
  const [headerValue, setHeaderValue] = useState('')
  const [busy, setBusy] = useState(false)
  if (session === null) return null
  const problem = url === '' ? null : urlProblem(url)
  const credential = secretOf(auth, token, headerName, headerValue)
  const needsSecret = auth === 'bearer' || auth === 'headers'
  const shownName = name.trim() !== '' ? name.trim() : problem === null && url !== '' ? hostOf(url) : ''
  const ready =
    shownName !== '' &&
    url !== '' &&
    problem === null &&
    (!needsSecret || (credential !== null && 'secret' in credential)) &&
    mcp !== null

  const create = async () => {
    if (!ready || mcp === null) return
    setBusy(true)
    try {
      const ws = session.workspace
      const prefix = prefixFor(
        shownName,
        ws.mcp.list().map((s) => s.prefix),
      )
      // Off until its credential is stored, so the first connection already carries it.
      const id = ws.mcp.create({ name: shownName, prefix, transport, url, auth, enabled: false })
      if (credential !== null && 'secret' in credential) await mcp.secrets.set(id, credential.secret)
      ws.mcp.update(id, { enabled: true })
      navigate(mcpServerPath(id), { replace: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen title={t('mcp.newTitle')} back={paths.mcp}>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <Field
          label={t('mcp.url')}
          hint={t('mcp.urlHint')}
          error={urlError(t, problem)}
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value.trim())}
          autoComplete="off"
          spellCheck={false}
          required
        />
        <Field
          label={t('mcp.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={problem === null && url !== '' ? hostOf(url) : undefined}
        />
        <TransportPicker value={transport} onChange={setTransport} />
        <AuthPicker value={auth} onChange={setAuth} />
        <CredentialFields
          auth={auth}
          token={token}
          setToken={setToken}
          headerName={headerName}
          setHeaderName={setHeaderName}
          headerValue={headerValue}
          setHeaderValue={setHeaderValue}
          error={credential !== null && 'error' in credential ? credential.error : null}
        />
        <Button type="submit" variant="primary" loading={busy} disabled={!ready}>
          {t('mcp.create')}
        </Button>
      </form>
      <CorsHelp />
    </Screen>
  )
}

/** One tool of the server: its switch, what it says about itself, and its state. */
function ToolRow({ serverId, tool }: { readonly serverId: string; readonly tool: McpToolView }) {
  const t = useT()
  const mcp = useMcp()
  const state =
    tool.state === 'new'
      ? t('mcp.stateNew')
      : tool.state === 'changed'
        ? t('mcp.stateChanged')
        : tool.state === 'invalid'
          ? t('mcp.stateInvalid')
          : null
  return (
    <li className={mcpStyles.tool} data-mcp-tool={tool.name} data-state={tool.state}>
      <SwitchRow
        label={tool.title}
        hint={tool.description}
        checked={tool.state === 'on'}
        disabled={tool.state === 'invalid' || mcp === null}
        onChange={(on) => mcp?.manager.setToolEnabled(serverId, tool.name, on)}
      />
      <div className={mcpStyles.toolMeta}>
        <AnnotationChips annotations={tool.annotations} />
        <span className={mcpStyles.mono}>{t('mcp.calledAs', { name: tool.registryName })}</span>
      </div>
      {state !== null && <p className={tool.state === 'changed' ? mcpStyles.warning : styles.footnote}>{state}</p>}
      {tool.state === 'changed' && (
        <Button
          variant="secondary"
          aria-label={t('mcp.acceptLabel', { name: tool.title })}
          onClick={() => mcp?.manager.acceptTool(serverId, tool.name)}
        >
          {t('mcp.accept')}
        </Button>
      )}
    </li>
  )
}

/** Whether this device holds a credential for the server (read once, then after each change). */
function useStoredCredential(serverId: string, version: number): boolean | null {
  const mcp = useMcp()
  const [stored, setStored] = useState<boolean | null>(null)
  useEffect(() => {
    // `version` changes after each save or removal: read again.
    if (mcp === null || version < 0) return
    let live = true
    mcp.secrets.get(serverId).then(
      (secret) => live && setStored(secret !== null && secret.kind !== 'oauth'),
      () => live && setStored(false),
    )
    return () => {
      live = false
    }
  }, [mcp, serverId, version])
  return stored
}

/** One server's settings (`/mcp/<id>`). */
function EditServer({ server }: { readonly server: McpServerConfig }) {
  const t = useT()
  const toast = useToast()
  const session = useSession()
  const mcp = useMcp()
  const status = useMcpStatus(server.id)
  const statusText = useStatusText()
  const [, navigate] = useLocation()
  const ids = useId()
  const [name, setName] = useState(server.name)
  const [url, setUrl] = useState(server.url)
  const [transport, setTransport] = useState<McpTransportKind>(server.transport)
  const [auth, setAuth] = useState<McpAuthKind>(server.auth)
  const [token, setToken] = useState('')
  const [headerName, setHeaderName] = useState('')
  const [headerValue, setHeaderValue] = useState('')
  const [version, setVersion] = useState(0)
  const [testing, setTesting] = useState(false)
  const stored = useStoredCredential(server.id, version)
  useEffect(() => {
    setName(server.name)
    setUrl(server.url)
    setTransport(server.transport)
    setAuth(server.auth)
  }, [server.name, server.url, server.transport, server.auth])
  if (session === null) return null
  const problem = urlProblem(url)
  const credential = secretOf(server.auth, token, headerName, headerValue)
  const changed =
    (name.trim() !== '' && name.trim() !== server.name) ||
    url !== server.url ||
    transport !== server.transport ||
    auth !== server.auth

  const test = async () => {
    if (mcp === null) return
    setTesting(true)
    try {
      await mcp.manager.connect(server.id)
    } finally {
      setTesting(false)
    }
  }

  const signIn = () => {
    if (mcp === null) return
    const target = mcp.manager.signInUrl(server.id)
    if (target === null) return
    // The answer's channel opens before the popup does, so the answer cannot arrive first.
    void mcp.manager.completeSignIn(server.id)
    window.open(target, '_blank', 'popup,width=520,height=720,noopener,noreferrer')
  }

  const tools = status.state === 'connected' ? status.tools : null
  const needsAuth = status.state === 'needs-auth' ? status : null

  return (
    <Screen title={server.name} subtitle={hostOf(server.url)} back={paths.mcp}>
      <section className={styles.form} aria-labelledby={`${ids}-status`}>
        <h2 id={`${ids}-status`} className={styles.sectionTitle}>
          {t('mcp.status')}
        </h2>
        <p className={styles.footnote} role="status" aria-live="polite" data-mcp-status={status.state}>
          {testing && status.state !== 'connecting' ? t('mcp.statusConnecting') : statusText(status, server)}
        </p>
        {status.state === 'error' &&
          status.problem.kind === 'auth' &&
          status.problem.status === 401 &&
          server.auth === 'none' && <p className={styles.footnote}>{t('mcp.oauthSuggest')}</p>}
        <SwitchRow
          label={t('mcp.enabled')}
          hint={t('mcp.enabledHint')}
          checked={server.enabled}
          onChange={(on) => session.workspace.mcp.update(server.id, { enabled: on })}
        />
        <div className={styles.sheetActions}>
          <Button loading={testing} disabled={testing || mcp === null || !server.enabled} onClick={() => void test()}>
            {t('mcp.test')}
          </Button>
          {needsAuth !== null && needsAuth.signIn !== 'waiting' && (
            <Button variant="primary" disabled={needsAuth.signIn !== 'ready'} onClick={signIn}>
              {t('mcp.signIn')}
            </Button>
          )}
          {needsAuth?.signIn === 'waiting' && (
            <Button variant="plain" onClick={() => mcp?.manager.cancelSignIn(server.id)}>
              {t('mcp.signInCancel')}
            </Button>
          )}
          {server.auth === 'oauth' && status.state === 'connected' && (
            <Button
              variant="plain"
              onClick={async () => {
                await mcp?.manager.signOut(server.id)
                toast(t('mcp.signedOut'))
              }}
            >
              {t('mcp.signOut')}
            </Button>
          )}
        </div>
      </section>

      {status.state === 'error' && status.problem.kind === 'cors' && <CorsHelp />}

      <section className={styles.form} aria-labelledby={`${ids}-tools`}>
        <h2 id={`${ids}-tools`} className={styles.sectionTitle}>
          {t('mcp.tools')}
        </h2>
        <p className={styles.footnote}>{t('mcp.toolsHint')}</p>
        {tools === null ? (
          <p className={styles.muted}>{t('mcp.toolsUnknown')}</p>
        ) : tools.length === 0 ? (
          <p className={styles.muted}>{t('mcp.toolsNone')}</p>
        ) : (
          <ul className={mcpStyles.tools}>
            {tools.map((tool) => (
              <ToolRow key={tool.name} serverId={server.id} tool={tool} />
            ))}
          </ul>
        )}
      </section>

      <form
        className={styles.form}
        aria-labelledby={`${ids}-settings`}
        onSubmit={(e) => {
          e.preventDefault()
          if (!changed || problem !== null) return
          session.workspace.mcp.update(server.id, {
            ...(name.trim() === '' ? {} : { name: name.trim() }),
            url,
            transport,
            auth,
          })
          toast(t('mcp.saved'))
        }}
      >
        <h2 id={`${ids}-settings`} className={styles.sectionTitle}>
          {t('mcp.settingsTitle')}
        </h2>
        <Field label={t('mcp.name')} value={name} onChange={(e) => setName(e.target.value)} />
        <Field
          label={t('mcp.url')}
          hint={t('mcp.urlHint')}
          error={urlError(t, problem)}
          type="url"
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value.trim())}
          autoComplete="off"
          spellCheck={false}
        />
        <TransportPicker value={transport} onChange={setTransport} />
        <AuthPicker value={auth} onChange={setAuth} />
        <Button type="submit" variant="secondary" disabled={!changed || problem !== null}>
          {t('mcp.save')}
        </Button>
      </form>

      {(server.auth === 'bearer' || server.auth === 'headers') && (
        <form
          className={styles.form}
          aria-labelledby={`${ids}-credentials`}
          onSubmit={async (e) => {
            e.preventDefault()
            if (mcp === null || credential === null || !('secret' in credential)) return
            await mcp.secrets.set(server.id, credential.secret)
            setToken('')
            setHeaderValue('')
            setVersion((v) => v + 1)
            toast(t('mcp.credentialSaved'))
            void mcp.manager.connect(server.id)
          }}
        >
          <h2 id={`${ids}-credentials`} className={styles.sectionTitle}>
            {t('mcp.credentials')}
          </h2>
          <p className={styles.footnote}>{stored ? t('mcp.credentialStored') : t('mcp.credentialMissing')}</p>
          <CredentialFields
            auth={server.auth}
            token={token}
            setToken={setToken}
            headerName={headerName}
            setHeaderName={setHeaderName}
            headerValue={headerValue}
            setHeaderValue={setHeaderValue}
            error={credential !== null && 'error' in credential ? credential.error : null}
          />
          <div className={styles.sheetActions}>
            <Button type="submit" variant="primary" disabled={credential === null || !('secret' in credential)}>
              {t('mcp.credentialSave')}
            </Button>
            {stored === true && (
              <Button
                variant="plain"
                onClick={async () => {
                  await mcp?.secrets.delete(server.id)
                  setVersion((v) => v + 1)
                  toast(t('mcp.credentialRemoved'))
                }}
              >
                {t('mcp.credentialRemove')}
              </Button>
            )}
          </div>
        </form>
      )}

      <Button
        variant="danger"
        icon={<Trash2 size={18} strokeWidth={1.75} aria-hidden="true" />}
        onClick={async () => {
          session.workspace.mcp.trash(server.id)
          await mcp?.secrets.delete(server.id).catch(() => undefined)
          toast(t('mcp.removed'))
          navigate(paths.mcp, { replace: true })
        }}
      >
        {t('mcp.remove')}
      </Button>
    </Screen>
  )
}

function ServerById({ id }: { readonly id: string }) {
  const t = useT()
  const server = useMcpServer(id)
  if (server === undefined || server.deletedAt !== undefined) {
    return (
      <Screen title={t('mcp.notFound')} back={paths.mcp}>
        {null}
      </Screen>
    )
  }
  return <EditServer server={server} />
}

/** `/mcp/new` and `/mcp/<id>`. */
export default function McpServerScreen({ params }: { params?: { id?: string } }) {
  const t = useT()
  const { status } = useVault()
  const state = useSessionState()
  if (status.state === 'absent') return <Redirect to={paths.welcome} replace />
  if (state.status !== 'open') {
    return (
      <Screen title={t('mcp.title')} back={paths.mcp}>
        <p className={styles.loading} role="status">
          {t('chat.sessionOpening')}
        </p>
      </Screen>
    )
  }
  const id = params?.id === undefined ? 'new' : decodeURIComponent(params.id)
  return id === 'new' ? <NewServer /> : <ServerById key={id} id={id} />
}
