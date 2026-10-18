import { Eye, Play } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useSession } from '../../app/chat.tsx'
import type { ArtifactSource } from '../../core/contracts/sandbox.ts'
import { hasScripts } from '../../core/sandbox/artifacts.ts'
import { PROTOCOL, parseFromArtifact, type WireAsset } from '../../core/sandbox/protocol.ts'
import { mermaidFile } from '../../core/sandbox/runtimes.ts'
import type { Key } from '../../i18n/index.ts'
import { useT } from '../../i18n/react.tsx'
import { newRunId, sandboxPageURL } from '../../sandbox/host.ts'
import { Button } from '../components/Button.tsx'
import { Segmented } from '../components/Segmented.tsx'
import { CodeBlock } from '../render/Sanitized.tsx'
import styles from './Artifact.module.css'

/*
 * An artifact in the chat: a card with a live preview of an HTML page, an SVG image or a Mermaid diagram, and its
 * source. The preview is the artifact frame (`<base>sandbox/artifact.html`, `sandbox="allow-scripts"`, an opaque
 * origin with no network): inert until the user clicks Run when the artifact holds scripts (core/sandbox/artifacts.ts).
 * Messages from the frame are taken only from its own window and only as protocol.ts allows; its height is clamped.
 */

const KIND_KEYS: Readonly<Record<ArtifactSource['kind'], Key>> = {
  html: 'sandbox.kind_html',
  svg: 'sandbox.kind_svg',
  mermaid: 'sandbox.kind_mermaid',
}

/** The source language of an artifact, for the code view. */
const LANG: Readonly<Record<ArtifactSource['kind'], string>> = { html: 'html', svg: 'xml', mermaid: 'mermaid' }

const MIN_HEIGHT = 120
const MAX_SHOWN = 900

type FrameState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready' }
  | { readonly status: 'failed'; readonly message: string | null }

function themeOf(): 'light' | 'dark' {
  return getComputedStyle(document.documentElement).colorScheme.includes('dark') ? 'dark' : 'light'
}

function ArtifactFrame({ artifact, run, title }: { artifact: ArtifactSource; run: boolean; title: string }) {
  const t = useT()
  const session = useSession()
  const runtimes = session?.runtimes ?? null
  const ref = useRef<HTMLIFrameElement>(null)
  /** The frame said it is ready: a later render is posted at once. */
  const ready = useRef(false)
  const { kind, source } = artifact
  const [state, setState] = useState<FrameState>({ status: 'loading' })
  const [height, setHeight] = useState(MIN_HEIGHT)

  // A layout effect: the listener is in place before the frame, created in the same commit, can answer.
  useLayoutEffect(() => {
    const iframe = ref.current
    if (iframe === null) return
    const id = newRunId()
    let live = true
    setState({ status: 'loading' })
    const render = async () => {
      let assets: WireAsset[] = []
      if (kind === 'mermaid') {
        const file = mermaidFile()
        try {
          if (runtimes === null) throw new Error('no session')
          const bytes = await runtimes.get(file)
          assets = [{ name: 'mermaid.min.js', sha256: file.sha256, data: bytes.slice().buffer }]
        } catch {
          if (live) setState({ status: 'failed', message: null })
          return
        }
      }
      if (!live) return
      iframe.contentWindow?.postMessage(
        { p: PROTOCOL, type: 'render', id, kind, source, run, theme: themeOf(), assets },
        '*',
        assets.flatMap((a) => (a.data === undefined ? [] : [a.data])),
      )
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow || event.origin !== 'null') return
      const message = parseFromArtifact(event.data)
      if (message === null || !live) return
      if (message.type === 'ready') {
        ready.current = true
        void render()
        return
      }
      if (message.id !== id) return
      if (message.type === 'failed') setState({ status: 'failed', message: message.message })
      else {
        setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_SHOWN, message.height)))
        if (message.type === 'rendered') setState({ status: 'ready' })
      }
    }
    window.addEventListener('message', onMessage)
    if (ready.current) void render()
    return () => {
      live = false
      window.removeEventListener('message', onMessage)
    }
  }, [kind, source, run, runtimes])

  return (
    <div className={styles.preview} data-artifact-state={state.status}>
      <iframe
        ref={ref}
        className={styles.frame}
        sandbox="allow-scripts"
        src={sandboxPageURL('artifact')}
        title={t('sandbox.frameTitle', { title })}
        referrerPolicy="no-referrer"
        height={height}
      />
      {state.status === 'loading' && (
        <p className={styles.status} role="status">
          {t('sandbox.loading')}
        </p>
      )}
      {state.status === 'failed' && (
        <p className={styles.error} role="alert">
          {state.message === null ? t('sandbox.unavailable') : t('sandbox.failed', { message: state.message })}
        </p>
      )}
    </div>
  )
}

/**
 * One artifact: its kind and title, then, once the user opens it, Preview or Code, and Run when it holds scripts.
 * Closed by default: no frame is made and nothing is fetched (Mermaid's renderer) until the user asks for the preview.
 */
export function ArtifactCard({
  artifact,
  title,
  open: initiallyOpen = false,
}: {
  artifact: ArtifactSource
  title?: string
  open?: boolean
}) {
  const t = useT()
  const [open, setOpen] = useState(initiallyOpen)
  const [view, setView] = useState<'preview' | 'code'>('preview')
  const [run, setRun] = useState(false)
  const scripts = hasScripts(artifact)
  const name = title ?? t(KIND_KEYS[artifact.kind])
  return (
    <section
      className={styles.card}
      aria-label={t('sandbox.artifactLabel', { title: name })}
      data-artifact={artifact.kind}
      data-artifact-run={run ? 'on' : 'off'}
    >
      <div className={styles.header}>
        <span className={styles.kind}>{name}</span>
        {!open && (
          <Button
            variant="secondary"
            icon={<Eye size={16} strokeWidth={2} aria-hidden="true" />}
            onClick={() => setOpen(true)}
          >
            {t('sandbox.preview')}
          </Button>
        )}
        {open && (
          <Segmented
            label={t('sandbox.view')}
            hideLabel
            value={view}
            onChange={setView}
            options={[
              { value: 'preview', label: t('sandbox.preview') },
              { value: 'code', label: t('sandbox.code') },
            ]}
          />
        )}
        {open && scripts && !run && (
          <Button
            variant="secondary"
            icon={<Play size={16} strokeWidth={2} aria-hidden="true" />}
            onClick={() => {
              setRun(true)
              setView('preview')
            }}
          >
            {t('sandbox.run')}
          </Button>
        )}
      </div>
      {open && scripts && <p className={styles.footnote}>{run ? t('sandbox.scriptsOn') : t('sandbox.scriptsHint')}</p>}
      {open &&
        (view === 'preview' ? (
          <ArtifactFrame key={run ? 'run' : 'inert'} artifact={artifact} run={run} title={name} />
        ) : (
          <CodeBlock lang={LANG[artifact.kind]} text={artifact.source} live={false} />
        ))}
    </section>
  )
}
