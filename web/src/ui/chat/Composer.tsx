import { ArrowUp, Camera, ChevronDown, ImagePlus, Palette, Square, X } from 'lucide-react'
import {
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import { useSession } from '../../app/chat.tsx'
import { takeSharedDraft } from '../../app/inbox.tsx'
import type { Effort, ModelDescriptor } from '../../core/contracts/ai.ts'
import type { ModelRef, Part } from '../../core/contracts/workspace.ts'
import { useT } from '../../i18n/react.tsx'
import { IconButton } from '../components/IconButton.tsx'
import { Sheet } from '../components/Sheet.tsx'
import { cx } from '../cx.ts'
import { MicButton } from '../voice/MicButton.tsx'
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
  /** The chat's Tools control (ui/chat/Tools.tsx), shown with the other settings of the toolbar. */
  readonly tools?: ReactNode
  readonly streaming: boolean
  readonly queued: number
  /** Resolves true when the message was taken (the draft is then cleared). */
  readonly onSend: (parts: readonly Part[]) => Promise<boolean>
  readonly onStop: () => void
  /** Image turns, when one of the providers creates images (contracts/media.ts). */
  readonly image?: ImageControls
  /** A new chat: it starts with what the user took from the share inbox, if anything (app/inbox.tsx). */
  readonly takesSharedDraft?: boolean
}

/** What the composer needs to create images instead of sending a message. */
export interface ImageControls {
  readonly models: readonly { readonly ref: ModelRef; readonly label: string }[]
  readonly model: ModelRef | null
  readonly onModel: (ref: ModelRef) => void
  /** An image is being created in this chat. */
  readonly busy: boolean
  /** Resolves true when the prompt was taken (the field is then cleared). */
  readonly onCreate: (prompt: string) => Promise<boolean>
  readonly onStop: () => void
}

const refKey = (ref: ModelRef) => `${ref.provider} ${ref.id}`

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

/**
 * The message field with its toolbar: photos, model, effort, system prompt, dictation, and Send or Stop; or, in image
 * mode, the prompt of an image and its image model.
 */
export function Composer(props: ComposerProps) {
  const { model, queued, onSend, image } = props
  const t = useT()
  const session = useSession()
  const id = useId()
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<readonly Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const [sending, setSending] = useState(false)
  const [imageMode, setImageMode] = useState(false)
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null)
  const field = useAutoGrow(text)
  const creating = imageMode && image !== undefined
  const streaming = props.streaming || (image?.busy ?? false)
  const onStop = image?.busy ? image.onStop : props.onStop
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

  // What the user took from the share inbox fills a new chat once: its text, and its photos as attachments.
  const draftTaken = useRef(false)
  useEffect(() => {
    if (!props.takesSharedDraft || session === null || draftTaken.current) return
    draftTaken.current = true
    const draft = takeSharedDraft()
    if (draft === null) return
    if (draft.text !== '') setText(draft.text)
    add(draft.files)
  })

  const ready = attachments.filter((a): a is Extract<Attachment, { status: 'ready' }> => a.status === 'ready')
  const preparing = attachments.some((a) => a.status === 'preparing')
  const hasContent = text.trim() !== '' || (!creating && ready.length > 0)
  const canSend = creating
    ? text.trim() !== '' && !sending && !image.busy && image.model !== null
    : hasContent && !preparing && !sending && model !== null

  const create = async () => {
    if (!creating || !canSend) return
    setSending(true)
    try {
      if (await image.onCreate(text.trim())) setText('')
    } finally {
      setSending(false)
      field.current?.focus()
    }
  }

  const send = async () => {
    if (creating) {
      await create()
      return
    }
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

  const dictated = (said: string) =>
    setText((current) => (current.trim() === '' ? said : `${current.replace(/\s+$/, '')} ${said}`))

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
      {voiceStatus !== null && (
        <p className={styles.caption} role="status" aria-live="polite">
          {voiceStatus}
        </p>
      )}
      {!creating && attachments.length > 0 && (
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
      {!creating && ready.length > 0 && model !== null && !model.capabilities.vision && (
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
          placeholder={
            creating
              ? t('media.imagePlaceholder')
              : model === null
                ? t('chat.composerPlaceholderNoModel')
                : t('chat.composerPlaceholder')
          }
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          enterKeyHint="send"
          aria-describedby={`${id}-hint`}
        />
        <div className={styles.toolbar}>
          <div className={styles.toolbarStart}>
            {!creating && (
              <>
                <IconButton icon={ImagePlus} label={t('chat.attach')} onClick={() => picker.current?.click()} />
                <IconButton
                  icon={Camera}
                  label={t('chat.camera')}
                  className={styles.cameraButton}
                  onClick={() => camera.current?.click()}
                />
              </>
            )}
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
            {creating ? (
              <ImageModelSelect image={image} />
            ) : (
              <>
                <ModelPicker value={props.modelRef} onChange={props.onModel} />
                <EffortSelect model={model} value={props.effort} onChange={props.onEffort} />
                <SystemPromptButton value={props.system} frozen={props.systemFrozen} onSave={props.onSystem} />
                {props.tools}
              </>
            )}
            {image !== undefined && image.models.length > 0 && (
              <IconButton
                icon={Palette}
                label={t('media.imageMode')}
                aria-pressed={imageMode}
                onClick={() => setImageMode((on) => !on)}
              />
            )}
          </div>
          <div className={styles.toolbarEnd}>
            <MicButton onText={dictated} onStatus={setVoiceStatus} />
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
                aria-label={creating ? t('media.imageSend') : t('chat.send')}
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

/**
 * The image model of image mode, among those the providers offer: a chip that opens a sheet of radio buttons (no
 * native <select>, whose WebKit menu breaks the strict style policy).
 */
function ImageModelSelect({ image }: { image: ImageControls }) {
  const t = useT()
  const name = useId()
  const [open, setOpen] = useState(false)
  const current = image.models.find((m) => image.model !== null && refKey(m.ref) === refKey(image.model))
  return (
    <>
      <button
        type="button"
        className={styles.modelChip}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={t('media.imageModelChip', { model: current?.label ?? '' })}
      >
        <span className={styles.modelChipName}>{current?.label ?? t('media.imageModel')}</span>
        <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
      </button>
      <Sheet open={open} title={t('media.imageModel')} onClose={() => setOpen(false)}>
        <fieldset className={styles.effortChoices}>
          <legend className="sr-only">{t('media.imageModel')}</legend>
          {image.models.map((m) => {
            const selected = image.model !== null && refKey(m.ref) === refKey(image.model)
            return (
              <label key={refKey(m.ref)} className={cx(styles.pickerRow, selected && styles.pickerRowSelected)}>
                <span className={styles.modelId}>{m.label}</span>
                <input
                  type="radio"
                  name={name}
                  value={refKey(m.ref)}
                  checked={selected}
                  onChange={() => {
                    image.onModel(m.ref)
                    setOpen(false)
                  }}
                />
              </label>
            )
          })}
        </fieldset>
      </Sheet>
    </>
  )
}
