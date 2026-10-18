import { useState } from 'react'
import { Redirect, useLocation } from 'wouter'
import { useKnowledgeBases, useSession, useSessionState } from '../../app/chat.tsx'
import { LOCAL_EMBEDDER } from '../../app/knowledge.ts'
import { knowledgePath, paths } from '../../app/routes.ts'
import { useVault } from '../../app/vault.tsx'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../../ui/components/Button.tsx'
import { Field } from '../../ui/components/Field.tsx'
import { ListGroup, ListRow } from '../../ui/components/List.tsx'
import styles from '../../ui/knowledge/Knowledge.module.css'
import { Screen } from '../../ui/shell/Screen.tsx'

/** The knowledge bases of this vault, a new one, and the deleted ones (restorable). */
export default function KnowledgeScreen() {
  const t = useT()
  const { status } = useVault()
  const state = useSessionState()
  const session = useSession()
  const bases = useKnowledgeBases()
  const trashed = useKnowledgeBases({ trashed: true })
  const [, navigate] = useLocation()
  const [name, setName] = useState('')

  if (status.state === 'absent') return <Redirect to={paths.welcome} replace />
  if (state.status !== 'open' || session === null) {
    return (
      <Screen title={t('knowledge.title')}>
        <p className={styles.muted} role="status">
          {t('chat.sessionOpening')}
        </p>
      </Screen>
    )
  }
  const create = () => {
    const trimmed = name.trim()
    if (trimmed === '') return
    const id = session.workspace.knowledge.create({ name: trimmed, embedder: LOCAL_EMBEDDER })
    setName('')
    navigate(knowledgePath(id))
  }
  return (
    <Screen title={t('knowledge.title')} subtitle={t('knowledge.lead')} back={paths.more}>
      <div className={styles.stack}>
        <ListGroup title={t('knowledge.listTitle')} footer={bases.length === 0 ? t('knowledge.listEmpty') : undefined}>
          {bases.map((b) => (
            <ListRow
              key={b.id}
              href={knowledgePath(b.id)}
              title={b.name || t('chat.untitled')}
              subtitle={t('knowledge.documents', { count: b.documents.length })}
            />
          ))}
        </ListGroup>

        <form
          className={styles.form}
          aria-labelledby="knowledge-new"
          onSubmit={(e) => {
            e.preventDefault()
            create()
          }}
        >
          <h2 id="knowledge-new" className={styles.sectionTitle}>
            {t('knowledge.newTitle')}
          </h2>
          <Field
            label={t('knowledge.newName')}
            placeholder={t('knowledge.newNamePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            enterKeyHint="done"
            autoComplete="off"
          />
          <Button type="submit" variant="primary" disabled={name.trim() === ''}>
            {t('knowledge.create')}
          </Button>
        </form>

        {trashed.length > 0 && (
          <ListGroup title={t('knowledge.trashedTitle')}>
            {trashed.map((b) => (
              <ListRow
                key={b.id}
                title={b.name || t('chat.untitled')}
                subtitle={t('knowledge.documents', { count: b.documents.length })}
                trailing={
                  <Button
                    variant="plain"
                    aria-label={t('knowledge.restoreLabel', { name: b.name })}
                    onClick={() => session.workspace.knowledge.restore(b.id)}
                  >
                    {t('knowledge.restore')}
                  </Button>
                }
              />
            ))}
          </ListGroup>
        )}
      </div>
    </Screen>
  )
}
