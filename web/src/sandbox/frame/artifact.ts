/*
 * The artifact frame (`<base>sandbox/artifact.html`): shows one HTML, SVG or Mermaid artifact for the app.
 *
 * - Inert by default: an HTML artifact (or an SVG one that holds scripts) is shown in a nested `srcdoc` frame with
 *   `sandbox=""`, where nothing runs; an SVG artifact is shown as an image; a Mermaid diagram is rendered by the
 *   pinned Mermaid (`securityLevel: 'strict'`), whose bundle the app transfers here, and shown as an image.
 * - After the user's Run click, the nested frame is made again with `sandbox="allow-scripts"`. Its document starts
 *   with a prelude that removes WebRTC from its realm and reports its height. The nested frame inherits this page's
 *   CSP (no connection, no host for any load, no frame): it reaches nothing outside itself.
 * - Messages are taken from the parent and the app's origin only (core/sandbox/protocol.ts), and from the nested
 *   frame only as a height, clamped.
 */
import { MAX_HEIGHT, PROTOCOL, parseToArtifact, type RenderMessage } from '../../core/sandbox/protocol.ts'
import { APP_ORIGIN, refusal, showRefusal } from './guard.ts'

interface Mermaid {
  initialize(config: Record<string, unknown>): void
  render(id: string, source: string): Promise<{ svg: string }>
}

const held = new Map<string, ArrayBuffer>()
let mermaid: Promise<Mermaid> | null = null
let current: string | null = null
let nested: HTMLIFrameElement | null = null
let diagrams = 0

/** The default height of a nested document until it reports its own (an inert one never does). */
const DOCUMENT_HEIGHT = 420

/**
 * Runs first in an artifact that was allowed to run: WebRTC (which no CSP governs) is removed from its realm, and its
 * height is reported to this frame as it changes.
 */
const PRELUDE = `<script>(()=>{for(const n of ["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCIceCandidate","RTCSessionDescription","RTCRtpSender","RTCRtpReceiver","RTCRtpTransceiver","RTCRtpScriptTransform","RTCDtlsTransport","RTCIceTransport","RTCSctpTransport","RTCCertificate","RTCDTMFSender","RTCEncodedAudioFrame","RTCEncodedVideoFrame"]){try{delete window[n]}catch(e){}try{Object.defineProperty(window,n,{value:undefined,writable:false,configurable:false})}catch(e){}}const p=()=>{try{parent.postMessage({aparteHeight:Math.ceil(document.documentElement.scrollHeight)},"*")}catch(e){}};addEventListener("load",p);try{new ResizeObserver(p).observe(document.documentElement)}catch(e){}})()</script>`

function post(message: Record<string, unknown>): void {
  window.parent.postMessage({ p: PROTOCOL, ...message }, APP_ORIGIN)
}

function clampHeight(value: number): number {
  return Math.max(0, Math.min(MAX_HEIGHT, Math.ceil(value)))
}

/** The nested frame's document: the theme's colours, then (when it may run) the prelude, then the artifact. */
function documentFor(message: RenderMessage): string {
  const scheme = `<meta name="color-scheme" content="${message.theme}">`
  const head = message.run ? `${scheme}${PRELUDE}` : scheme
  const source = message.kind === 'svg' ? `<!doctype html><body style="margin:0">${message.source}` : message.source
  const doctype = /^\s*<!doctype[^>]*>/i.exec(source)
  return doctype === null ? `${head}${source}` : `${doctype[0]}${head}${source.slice(doctype[0].length)}`
}

function show(node: Node): void {
  nested = null
  const root = document.getElementById('root') ?? document.body
  root.replaceChildren(node)
}

function showDocument(message: RenderMessage): void {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', message.run ? 'allow-scripts' : '')
  frame.setAttribute('title', 'Artifact')
  frame.setAttribute('referrerpolicy', 'no-referrer')
  frame.srcdoc = documentFor(message)
  frame.style.height = `${DOCUMENT_HEIGHT}px`
  show(frame)
  nested = frame
  const id = message.id
  frame.addEventListener('load', () => {
    if (current === id) post({ type: 'rendered', id, height: DOCUMENT_HEIGHT })
  })
}

function showImage(id: string, svg: string): void {
  const img = document.createElement('img')
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  img.alt = ''
  img.addEventListener('load', () => {
    if (current !== id) return
    post({ type: 'rendered', id, height: clampHeight(document.documentElement.scrollHeight) })
  })
  img.addEventListener('error', () => {
    if (current === id) post({ type: 'failed', id, message: 'The image could not be shown' })
  })
  img.src = url
  show(img)
}

function loadMermaid(message: RenderMessage): Promise<Mermaid> {
  if (mermaid !== null) return mermaid
  const asset = message.assets[0]
  const data = asset === undefined ? undefined : held.get(asset.sha256)
  if (data === undefined) return Promise.reject(new Error('Mermaid was not sent'))
  mermaid = new Promise<Mermaid>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = URL.createObjectURL(new Blob([data], { type: 'text/javascript' }))
    script.addEventListener('load', () => {
      const m = (globalThis as { mermaid?: Mermaid }).mermaid
      if (m === undefined) reject(new Error('Mermaid did not load'))
      else resolve(m)
    })
    script.addEventListener('error', () => reject(new Error('Mermaid did not load')))
    document.head.append(script)
  })
  mermaid.catch(() => {
    mermaid = null
  })
  return mermaid
}

async function render(message: RenderMessage): Promise<void> {
  current = message.id
  document.documentElement.dataset.theme = message.theme
  for (const asset of message.assets) if (asset.data !== undefined) held.set(asset.sha256, asset.data)
  if (message.kind === 'mermaid') {
    try {
      const m = await loadMermaid(message)
      m.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: message.theme === 'dark' ? 'dark' : 'default',
        suppressErrorRendering: true,
        htmlLabels: false,
        flowchart: { htmlLabels: false },
      })
      diagrams++
      const { svg } = await m.render(`diagram-${diagrams}`, message.source)
      if (current === message.id) showImage(message.id, svg)
    } catch (error) {
      if (current === message.id)
        post({ type: 'failed', id: message.id, message: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (message.kind === 'svg' && !message.run) showImage(message.id, message.source)
  else showDocument(message)
}

const refused = refusal({ origin: self.origin, top: window.top, self: window })
if (refused !== null) {
  showRefusal(refused)
} else {
  window.addEventListener('message', (event: MessageEvent) => {
    if (nested !== null && event.source === nested.contentWindow) {
      const h = (event.data as { aparteHeight?: unknown } | null)?.aparteHeight
      if (typeof h === 'number' && Number.isFinite(h) && current !== null) {
        const height = clampHeight(h)
        nested.style.height = `${height}px`
        post({ type: 'height', id: current, height })
      }
      return
    }
    if (event.source !== window.parent || event.origin !== APP_ORIGIN) return
    const message = parseToArtifact(event.data)
    if (message !== null) void render(message)
  })
  post({ type: 'ready', frame: 'artifact' })
}
