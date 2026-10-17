import { ArrowUp, Camera, ImagePlus, Square, X } from 'lucide-react'
import { type ClipboardEvent, type DragEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import { useSession } from '../../app/chat.tsx'
import type { Effort, ModelDescriptor } from '../../core/contracts/ai.ts'
import type { ModelRef, Part } from '../../core/contracts/workspace.ts'
import { useT } from '../../i18n/react.tsx'
import { IconButton } from '../components/IconButton.tsx'
import { cx } from '../cx.ts'
import { type Attachment, attachPhoto, imageFiles } from './attach.ts'
import styles from './Chat.module.css'
import { EffortSelect, ModelPicker } from './ModelPicker.tsx'
import { SystemPromptButton } from './SystemPrompt.tsx'

export interface ComposerProps {
  readonly modelRef: ModelRef | null
  readonly model: ModelDescriptor | null
  readonly onModel: (ref: ModelRef) => void
  readonly effort: Effort | null
  readonly onEffort: (effort: Effort) => void
  readonly system: string
  readonly systemFrozen: boolean
  readonly onSystem: (text: string) => Promise<void> | void
  readonly streaming: boolean
  readonly queued: number
  /** Resolves true when the message was taken (the draft is then cleared). */
  readonly onSend: (parts: readonly Part[]) => Promise<boolean>
  readonly onStop: () => void
}

/** Pointer devices with a precise pointer and hover: Enter sends there, and the shortcut hint shows. */
function finePointer(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches
}

function isApple(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

/** The textarea grows with its text up to about six lines, then scrolls. */
function useAutoGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const measured = useRef<string | null>(null)
  useEffect(() => {
    const el = ref.current
    // Measured once per text, not on every render of the composer.
    if (!el || measured.current === value) return
    measured.current = value
    el.style.height = 'auto'
    const max = Number.parseFloat(getComputedStyle(el).lineHeight || '24') * 6 + 24
    el.style.height = `${Math.min(el.scrollHeight, max)}px`
  }, [value])
  return ref
}

let attachmentSeq = 0

/** The message field with its toolbar: photos, model, effort, system prompt, and Send or Stop. */
export function Composer(props: ComposerProps) {
  const { model, streaming, queued, onSend, onStop } = props
  const t = useT()
  const session = useSession()
  const id = useId()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<readonly Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const [sending, setSending] = useState(false)
  const field = useAutoGrow(text)
  const picker = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  const previews = useRef(new Set<string>())

  // Thumbnails are object URLs of decrypted photos: they go with the composer.
  useEffect(() => {
    const urls = previews.current
    return () => {
      for (const url of urls) URL.revokeObjectURL(url)
      urls.clear()
    }
  }, [])

  const add = (files: readonly File[]) => {
    if (session === null || files.length === 0) return
    for (const file of files) {
      const key = `a${++attachmentSeq}`
      setAttachments((list) => [...list, { key, status: 'preparing', name: file.name }])
      void attachPhoto(file, key, session.blobs).then((done) => {
        if (done.status === 'ready') previews.current.add(done.preview)
        setAttachments((list) => {
          if (!list.some((a) => a.key === key)) {
            // Removed while it was being prepared.
            if (done.status === 'ready') URL.revokeObjectURL(done.preview)
            return list
          }
          return list.map((a) => (a.key === key ? done : a))
        })
      })
    }
  }

  const remove = (key: string) => {
    setAttachments((list) => {
      const gone = list.find((a) => a.key === key)
      if (gone?.status === 'ready') {
        URL.revokeObjectURL(gone.preview)
        previews.current.delete(gone.preview)
      }
      return list.filter((a) => a.key !== key)
    })
  }

  const ready = attachments.filter((a): a is Extract<Attachment, { status: 'ready' }> => a.status === 'ready')
  const preparing = attachments.some((a) => a.status === 'preparing')
  const hasContent = text.trim() !== '' || ready.length > 0
  const canSend = hasContent && !preparing && !sending && model !== null

  const send = async () => {
    if (!canSend) return
    // Photos sit above the text in the bubble, and come first in the message.
    const parts: Part[] = ready.map((a) => a.part)
    if (text.trim() !== '') parts.push({ type: 'text', text: text.trim() })
    setSending(true)
    try {
      if (await onSend(parts)) {
        setText('')
        for (const a of ready) {
          URL.revokeObjectURL(a.preview)
          previews.current.delete(a.preview)
        }
        setAttachments((list) => list.filter((a) => a.status !== 'ready'))
      }
    } finally {
      setSending(false)
      field.current?.focus()
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && streaming) {
      e.preventDefault()
      onStop()
      return
    }
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
    if (e.metaKey || e.ctrlKey || (!e.shiftKey && !e.altKey && finePointer())) {
      e.preventDefault()
      void send()
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFiles(e.clipboardData.files)
    if (files.length === 0) return
    if (e.clipboardData.getData('text/plain') === '') e.preventDefault()
    add(files)
  }

  const onDragOver = (e: DragEvent<HTMLElement>) => {
    if (![...e.dataTransfer.types].includes('Files')) return
    e.preventDefault()
    setDragging(true)
  }
  const onDrop = (e: DragEvent<HTMLElement>) => {
    if (![...e.dataTransfer.types].includes('Files')) return
    e.preventDefault()
    setDragging(false)
    add(imageFiles(e.dataTransfer.files))
  }

  const failureText = (reason: Extract<Attachment, { status: 'failed' }>['reason']) =>
    reason === 'too-large'
      ? t('chat.attachFailedTooLarge')
      : reason === 'unsupported'
        ? t('chat.attachFailedUnsupported')
        : reason === 'store'
          ? t('chat.attachFailedStore')
          : t('chat.attachFailedDecode')

  return (
    <section
      className={cx(styles.composer, dragging && styles.composerDragging)}
      aria-label={t('chat.composerLabel')}
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {queued > 0 && (
        <p className={styles.caption} role="status">
          {t('chat.queued', { count: queued })}
        </p>
      )}
      {attachments.length > 0 && (
        <ul className={styles.attachments}>
          {attachments.map((a) => (
            <li key={a.key} className={styles.attachment}>
              {a.status === 'ready' ? (
                <img src={a.preview} alt={a.name || t('chat.photo')} className={styles.thumb} />
              ) : (
                <span className={cx(styles.thumb, styles.thumbPending)} role="status">
                  {a.status === 'preparing' ? t('chat.attachPreparing') : failureText(a.reason)}
                </span>
              )}
              <button
                type="button"
                className={styles.thumbRemove}
                aria-label={t('chat.attachRemove', { name: a.name || t('chat.photo') })}
                onClick={() => remove(a.key)}
              >
                <X size={14} strokeWidth={2.25} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {ready.length > 0 && model !== null && !model.capabilities.vision && (
        <p className={styles.warningText}>{t('chat.attachNoVision')}</p>
      )}
      {dragging && <p className={styles.caption}>{t('chat.attachDrop')}</p>}
      <div className={styles.field}>
        <label htmlFor={id} className="sr-only">
          {t('chat.composerLabel')}
        </label>
        <textarea
          ref={field}
          id={id}
          className={styles.input}
          rows={1}
          value={text}
          placeholder={model === null ? t('chat.composerPlaceholderNoModel') : t('chat.composerPlaceholder')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          enterKeyHint="send"
          aria-describedby={`${id}-hint`}
        />
        <div className={styles.toolbar}>
          <div className={styles.toolbarStart}>
            <IconButton icon={ImagePlus} label={t('chat.attach')} onClick={() => picker.current?.click()} />
            <IconButton
              icon={Camera}
              label={t('chat.camera')}
              className={styles.cameraButton}
              onClick={() => camera.current?.click()}
            />
            <input
              ref={picker}
              type="file"
              accept="image/*"
              multiple
              hidden
              tabIndex={-1}
              onChange={(e) => {
                add(imageFiles(e.target.files))
                e.target.value = ''
              }}
            />
            <input
              ref={camera}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              tabIndex={-1}
              onChange={(e) => {
                add(imageFiles(e.target.files))
                e.target.value = ''
              }}
            />
            <ModelPicker value={props.modelRef} onChange={props.onModel} />
            <EffortSelect model={model} value={props.effort} onChange={props.onEffort} />
            <SystemPromptButton value={props.system} frozen={props.systemFrozen} onSave={props.onSystem} />
          </div>
          <div className={styles.toolbarEnd}>
            {streaming && (
              <button type="button" className={styles.stop} onClick={onStop} aria-label={t('chat.stop')}>
                <Square size={16} strokeWidth={2.25} fill="currentColor" aria-hidden="true" />
              </button>
            )}
            {(!streaming || hasContent) && (
              <button
                type="button"
                className={styles.send}
                onClick={() => void send()}
                disabled={!canSend}
                aria-label={t('chat.send')}
                aria-busy={sending || undefined}
              >
                <ArrowUp size={20} strokeWidth={2.25} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>
      <p id={`${id}-hint`} className={styles.hint}>
        {finePointer()
          ? `${t('chat.sendHint')} · ${t('chat.sendHintMod', { key: isApple() ? '⌘' : 'Ctrl' })}`
          : t('chat.attachPrivacy')}
      </p>
    </section>
  )
}
