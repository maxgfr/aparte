import { BookOpen } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'wouter'
import { useKnowledgeBases } from '../../app/chat.tsx'
import { paths } from '../../app/routes.ts'
import type { Id } from '../../core/contracts/workspace.ts'
import { useT } from '../../i18n/react.tsx'
import { buttonClass } from '../components/Button.tsx'
import { IconButton } from '../components/IconButton.tsx'
import { Sheet } from '../components/Sheet.tsx'
import { SwitchRow } from '../components/Switch.tsx'
import styles from './Knowledge.module.css'

/**
 * The composer's Knowledge control: which knowledge bases this chat draws on. Unlike its tools, a chat's knowledge may
 * change at any time, since the passages travel in each user message, never in the conversation's frozen prefix.
 */
export function AttachButton({
  selected,
  onChange,
}: {
  readonly selected: readonly Id[]
  readonly onChange: (bases: readonly Id[]) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const bases = useKnowledgeBases()
  // A base deleted since it was attached is no longer offered or counted.
  const live = selected.filter((id) => bases.some((b) => b.id === id))
  const label = live.length === 0 ? t('knowledge.attach') : t('knowledge.attachOn', { count: live.length })
  return (
    <>
      <IconButton icon={BookOpen} label={label} onClick={() => setOpen(true)} data-knowledge-count={live.length} />
      <Sheet open={open} title={t('knowledge.attachTitle')} onClose={() => setOpen(false)}>
        <div className={styles.stack}>
          <p className={styles.footnote}>{t('knowledge.attachIntro')}</p>
          {bases.length === 0 ? (
            <p className={styles.muted}>{t('knowledge.attachEmpty')}</p>
          ) : (
            <div className={styles.section}>
              {bases.map((b) => (
                <SwitchRow
                  key={b.id}
                  label={b.name || t('chat.untitled')}
                  hint={t('knowledge.documents', { count: b.documents.length })}
                  checked={live.includes(b.id)}
                  onChange={(on) => onChange(on ? [...live, b.id] : live.filter((id) => id !== b.id))}
                />
              ))}
            </div>
          )}
          <div className={styles.actions}>
            <Link href={paths.knowledge} className={buttonClass({ variant: 'plain' })} onClick={() => setOpen(false)}>
              {t('knowledge.attachManage')}
            </Link>
          </div>
        </div>
      </Sheet>
    </>
  )
}
