import { Check, Copy, ExternalLink } from 'lucide-react'
import { memo, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../i18n/react.tsx'
import { Button } from '../components/Button.tsx'
import { Sheet } from '../components/Sheet.tsx'
import { cx } from '../cx.ts'
import type { CodeNode, SyntaxRole } from './highlight.ts'
import { type Block, renderBlock, type Split, splitBlocks, splitIncremental } from './markdown.ts'
import { safeLinkUrl, setPurifyLabels } from './purify.ts'
import styles from './Sanitized.module.css'

/*
 * The renderer of untrusted Markdown (model answers and reasoning), ported from cursus `Sanitized.tsx`.
 *
 * Invariants:
 * - Rendered markup reaches the page only as nodes DOMPurify built (purify.ts), inserted with `replaceChildren` into
 *   an element React leaves empty; code blocks and their highlighting are React elements, never markup.
 * - No link navigates by itself: activating one opens an interstitial that shows the full address, and only its
 *   Open button leaves the app, in a new tab without opener or referrer.
 * - Blocks are memoised by their source: while an answer streams only the last block is parsed again.
 */

/** Copies plain text to the clipboard; false when the platform refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** A plain Copy button that says "Copied" for a moment. */
export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className={cx(styles.copy, className)}
      onClick={() => void copyText(text).then(setCopied)}
      aria-live="polite"
    >
      {copied ? (
        <Check size={16} strokeWidth={2} aria-hidden="true" />
      ) : (
        <Copy size={16} strokeWidth={1.75} aria-hidden="true" />
      )}
      <span>{copied ? t('chat.copied') : label}</span>
    </button>
  )
}

/** Sanitised nodes in an element React never fills itself. */
function SanitizedNodes({
  block,
  className,
}: {
  block: Extract<Block, { kind: 'html' | 'table' }>
  className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    host.current?.replaceChildren(renderBlock(block))
  }, [block])
  return <div ref={host} className={className} />
}

const ROLE_CLASS: Readonly<Record<SyntaxRole, string | undefined>> = {
  keyword: styles.synKeyword,
  string: styles.synString,
  number: styles.synNumber,
  comment: styles.synComment,
  function: styles.synFunction,
  type: styles.synType,
  punctuation: styles.synPunctuation,
}

function codeNodes(nodes: readonly CodeNode[]): ReactNode[] {
  return nodes.map((node) =>
    node.type === 'text' ? (
      node.value
    ) : (
      <span key={node.key} className={node.role === null ? undefined : ROLE_CLASS[node.role]}>
        {codeNodes(node.children)}
      </span>
    ),
  )
}

/**
 * Makes a box that scrolls sideways (a code block, a wide table) reachable by keyboard, so it can be scrolled
 * without a pointer. Set on the element directly: it is a scroll container, not a control.
 */
function useScrollFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    if (ref.current) ref.current.tabIndex = 0
  }, [])
  return ref
}

type Highlighter = (language: string, code: string) => readonly CodeNode[] | null
let highlighter: Promise<Highlighter> | null = null
/** The highlighter once its chunk has loaded: later code blocks are highlighted in the same render as their text. */
let loadedHighlighter: Highlighter | null = null

/** The highlighter chunk, loaded once on the first code block. */
function loadHighlighter(): Promise<Highlighter> {
  highlighter ??= import('./highlight.ts').then((m) => {
    loadedHighlighter = m.highlight
    return m.highlight
  })
  return highlighter
}

/**
 * A fenced code block: language, Copy, and the code highlighted once it is complete. While the highlighter chunk is
 * still loading, the code shows plain and its <pre> is `aria-busy`.
 */
export function CodeBlock({ lang, text, live }: { lang: string; text: string; live: boolean }) {
  const t = useT()
  const pre = useScrollFocus<HTMLPreElement>()
  // A block still streaming is shown plain: highlighting it again at every frame would cost more than it shows.
  const wanted = !live && lang !== ''
  const [loaded, setLoaded] = useState<Highlighter | null>(() => loadedHighlighter)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!wanted || loaded !== null) return
    let current = true
    loadHighlighter().then(
      (highlight) => {
        if (current) setLoaded(() => highlight)
      },
      () => {
        if (current) setFailed(true)
      },
    )
    return () => {
      current = false
    }
  }, [wanted, loaded])
  const tree = useMemo(() => (wanted && loaded !== null ? loaded(lang, text) : null), [wanted, loaded, lang, text])
  const pending = wanted && loaded === null && !failed
  return (
    <figure className={styles.code}>
      <figcaption className={styles.codeHeader}>
        <span className={styles.codeLang}>{lang === '' ? t('chat.codeLabel') : lang}</span>
        <CopyButton text={text} label={t('chat.copyCode')} />
      </figcaption>
      <pre ref={pre} className={styles.pre} aria-busy={pending ? true : undefined}>
        <code>{tree === null ? text : codeNodes(tree)}</code>
      </pre>
    </figure>
  )
}

function TableBlock({ block }: { block: Extract<Block, { kind: 'table' }> }) {
  const t = useT()
  const box = useScrollFocus<HTMLElement>()
  return (
    <section ref={box} className={styles.tableScroll} aria-label={t('chat.table')}>
      <SanitizedNodes block={block} />
    </section>
  )
}

const BlockView = memo(
  function BlockView({ block, live }: { block: Block; live: boolean }) {
    if (block.kind === 'code') return <CodeBlock lang={block.lang} text={block.text} live={live && block.open} />
    if (block.kind === 'table') return <TableBlock block={block} />
    return <SanitizedNodes block={block} className={styles.block} />
  },
  (a, b) => a.block.raw === b.block.raw && a.block.kind === b.block.kind && a.live === b.live,
)

/** The interstitial in front of every link of rendered output. */
export function LinkSheet({ url, onClose }: { url: string | null; onClose: () => void }) {
  const t = useT()
  const safe = safeLinkUrl(url)
  let host = ''
  try {
    host = safe === null ? '' : new URL(safe).host
  } catch {
    host = ''
  }
  return (
    <Sheet open={safe !== null} title={t('chat.linkTitle')} onClose={onClose}>
      <div className={styles.link}>
        <p>{host === '' ? t('chat.linkBodyMail') : t('chat.linkBody', { host })}</p>
        <p className={styles.linkUrl}>{safe}</p>
        <div className={styles.linkActions}>
          <Button
            variant="primary"
            icon={<ExternalLink size={18} strokeWidth={2} aria-hidden="true" />}
            onClick={() => {
              if (safe !== null) open(safe, '_blank', 'noopener,noreferrer')
              onClose()
            }}
          >
            {t('chat.linkOpen')}
          </Button>
          {safe !== null && <CopyButton text={safe} label={t('chat.linkCopy')} />}
          <Button variant="plain" onClick={onClose}>
            {t('chat.cancel')}
          </Button>
        </div>
      </div>
    </Sheet>
  )
}

export interface MarkdownProps {
  readonly source: string
  /** The text is still streaming: only its last block is parsed again, and an open code fence stays plain. */
  readonly live?: boolean
  readonly className?: string
  /** Data attributes for the element that holds the rendered text (and nothing else, such as the link sheet). */
  readonly data?: Readonly<Record<`data-${string}`, string>>
}

/** Rendered Markdown, read-only. */
export function Markdown({ source, live = false, className, data }: MarkdownProps) {
  const t = useT()
  const split = useRef<Split | null>(null)
  const [link, setLink] = useState<string | null>(null)
  setPurifyLabels({ remoteImage: t('chat.remoteImage') })
  const blocks = useMemo(() => {
    if (!live) {
      split.current = null
      return splitBlocks(source)
    }
    split.current = splitIncremental(split.current, source)
    return split.current.blocks
  }, [source, live])
  // A block keeps its position as the text grows, so its position is its identity.
  const items = useMemo(() => {
    const out: { key: string; block: Block; live: boolean }[] = []
    for (let n = 0; n < blocks.length; n++) {
      out.push({ key: `block-${n}`, block: blocks[n] as Block, live: live && n === blocks.length - 1 })
    }
    return out
  }, [blocks, live])

  // Link activation is delegated from the container: the links are `role="link"` elements the sanitiser made
  // focusable, so a click, Enter or Space on one opens the interstitial instead of navigating.
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = host.current
    if (!el) return
    const linkFrom = (target: EventTarget | null): string | null => {
      const a = target instanceof Element ? target.closest('a[data-href]') : null
      return a?.getAttribute('data-href') ?? null
    }
    const onClick = (e: MouseEvent) => {
      const href = linkFrom(e.target)
      if (href === null) return
      e.preventDefault()
      setLink(href)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      const href = linkFrom(e.target)
      if (href === null) return
      e.preventDefault()
      setLink(href)
    }
    el.addEventListener('click', onClick)
    el.addEventListener('keydown', onKey)
    return () => {
      el.removeEventListener('click', onClick)
      el.removeEventListener('keydown', onKey)
    }
  }, [])

  // The link sheet is a sibling of the rendered text, so the text of the answer is the text of the host alone.
  return (
    <>
      <div ref={host} className={cx(styles.prose, className)} {...data}>
        {items.map((item) => (
          <BlockView key={item.key} block={item.block} live={item.live} />
        ))}
      </div>
      <LinkSheet url={link} onClose={() => setLink(null)} />
    </>
  )
}
