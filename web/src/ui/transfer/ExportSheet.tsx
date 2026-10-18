import { useState } from 'react'
import { useSession } from '../../app/chat.tsx'
import { useToast } from '../../app/toast.tsx'
import type { Conversation, ModelRef } from '../../core/contracts/workspace.ts'
import type { ExportLabels } from '../../core/transfer/render.ts'
import { formatDate } from '../../i18n/format.ts'
import { intlTag, type Translate } from '../../i18n/index.ts'
import { useLocale, useT } from '../../i18n/react.tsx'
import { Sheet } from '../components/Sheet.tsx'
import { fileStem, saveFile } from './download.ts'
import styles from './Transfer.module.css'

/*
 * Exporting one conversation: its branch on screen as Markdown or as a self-contained web page, or the whole tree as
 * JSON that Aparté imports again. The file leaves the vault unencrypted, which the sheet says before anything is
 * saved. The export code loads only when an export is asked for.
 */

type Kind = 'markdown' | 'html' | 'json'

/** The words written into an exported file, in the interface language. */
export function exportLabels(t: Translate, locale: ReturnType<typeof useLocale>): ExportLabels {
  return {
    untitled: t('chat.untitled'),
    you: t('transfer.docYou'),
    system: t('transfer.docSystem'),
    reasoning: t('transfer.docReasoning'),
    image: t('transfer.docImage'),
    tool: t('transfer.docTool'),
    sources: t('transfer.docSources'),
    exported: t('transfer.docExported', { date: formatDate(locale, Date.now(), 'long') }),
    lang: intlTag(locale),
  }
}

export function ExportSheet({
  conversation,
  open,
  onClose,
}: {
  readonly conversation: Conversation
  readonly open: boolean
  readonly onClose: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const toast = useToast()
  const session = useSession()
  const [busy, setBusy] = useState<Kind | null>(null)
  const [error, setError] = useState<string | null>(null)
  const title = conversation.title || t('chat.untitled')

  const run = async (kind: Kind) => {
    if (session === null || busy !== null) return
    setBusy(kind)
    setError(null)
    try {
      const transfer = await import('../../core/transfer/index.ts')
      const stem = fileStem(conversation.title, 'chat')
      const modelName = (ref: ModelRef | null) =>
        ref === null ? t('transfer.docModelUnknown') : (session.resolveModel(ref)?.name ?? ref.id)
      const deps = { blobs: session.blobs, modelName, labels: exportLabels(t, locale) }
      let name: string
      if (kind === 'json') {
        const doc = await transfer.exportConversations(
          { workspace: session.workspace, blobs: session.blobs, clock: { now: () => Date.now() } },
          [conversation.id],
        )
        name = `${stem}.aparte.json`
        saveFile(JSON.stringify(doc), name, 'application/json')
      } else {
        const thread = await session.workspace.thread(conversation.id)
        const path = thread.path()
        if (kind === 'markdown') {
          name = `${stem}.md`
          saveFile(await transfer.toMarkdown(conversation, path, deps), name, 'text/markdown')
        } else {
          name = `${stem}.html`
          saveFile(await transfer.toHtml(conversation, path, deps), name, 'text/html')
        }
      }
      toast(t('transfer.exported', { name }))
      onClose()
    } catch (cause) {
      setError(t('transfer.exportFailed', { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setBusy(null)
    }
  }

  const options: readonly { kind: Kind; title: string; hint: string }[] = [
    { kind: 'markdown', title: t('transfer.exportMarkdown'), hint: t('transfer.exportMarkdownHint') },
    { kind: 'html', title: t('transfer.exportHtml'), hint: t('transfer.exportHtmlHint') },
    { kind: 'json', title: t('transfer.exportJson'), hint: t('transfer.exportJsonHint') },
  ]

  return (
    <Sheet open={open} title={t('transfer.exportTitle', { title })} onClose={onClose}>
      <div className={styles.sheet}>
        <p className={styles.muted}>{t('transfer.exportLead')}</p>
        <ul className={styles.options}>
          {options.map((o) => (
            <li key={o.kind}>
              <button
                type="button"
                className={styles.option}
                disabled={busy !== null}
                aria-busy={busy === o.kind || undefined}
                onClick={() => void run(o.kind)}
              >
                <span className={styles.optionTitle}>{o.title}</span>
                <span className={styles.optionHint}>{o.hint}</span>
              </button>
            </li>
          ))}
        </ul>
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  )
}
