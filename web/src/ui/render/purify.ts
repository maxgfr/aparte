import DOMPurify, { type Config } from 'dompurify'

/*
 * The sanitiser every piece of rendered model output goes through, and the only producer of HTML for the page.
 *
 * Invariants:
 * - One DOMPurify instance per page. It creates the `dompurify` Trusted Types policy (the name the CSP reserves for
 *   it) once, on its first call, and parses through it, which is what the enforced `require-trusted-types-for
 *   'script'` accepts. A second instance would try to create the policy again, which the CSP forbids.
 * - The result is a DocumentFragment (`RETURN_DOM_FRAGMENT`), inserted with `replaceChildren` by Sanitized.tsx: the
 *   sanitised markup never becomes a string again, and the app has no HTML sink of its own at all.
 * - What survives is text structure only: no media of any kind (an image, even a `data:` one, could exfiltrate the
 *   conversation through its URL; it is replaced by its address as text), no frames, forms, scripts, styles or SVG,
 *   no `style`, `id` or `name` attribute, and only the class names this renderer itself emits.
 * - No link navigates by itself: an `<a>` keeps its address in `data-href` (http, https or mailto only, absolute) and
 *   loses `href`, so the click goes through the interstitial that shows the full address (Sanitized.tsx).
 */

/** Words the sanitiser writes into the page, in the interface language. */
export interface PurifyLabels {
  /** `{alt}` and `{url}`: an image that was not loaded, shown as its address. */
  readonly remoteImage: string
}

/** Class names the renderer emits; any other class from model output is dropped. */
const ALLOWED_CLASSES = new Set(['katex', 'katex-display', 'math-block', 'remote-image'])

const FORBID_TAGS = [
  'img',
  'image',
  'picture',
  'source',
  'video',
  'audio',
  'track',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'select',
  'option',
  'textarea',
  'style',
  'link',
  'meta',
  'base',
  'svg',
  'template',
  'dialog',
  'marquee',
]

const FORBID_ATTR = [
  'style',
  'id',
  'name',
  'src',
  'srcset',
  'action',
  'formaction',
  'background',
  'poster',
  'ping',
  'target',
  'xlink:href',
  'tabindex',
  'contenteditable',
  'autofocus',
]

const CONFIG: Config = {
  USE_PROFILES: { html: true, mathMl: true },
  FORBID_TAGS,
  FORBID_ATTR,
  // KaTeX wraps its MathML in `semantics` with the TeX source in an `annotation`: DOMPurify drops both, and the
  // annotation's text must go with it rather than show next to the formula.
  ADD_FORBID_CONTENTS: ['annotation', 'annotation-xml'],
  ALLOW_ARIA_ATTR: false,
  SANITIZE_NAMED_PROPS: true,
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
}

/** The address a link may lead to: an absolute http, https or mailto URL, normalised; null otherwise. */
export function safeLinkUrl(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const trimmed = raw.trim()
  if (!/^(?:https?:\/\/|mailto:)/i.test(trimmed)) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'mailto:') return null
    if (url.username !== '' || url.password !== '') return null
    return url.href
  } catch {
    return null
  }
}

let labels: PurifyLabels = { remoteImage: '[image: {alt}] {url}' }
let installed = false

function fill(template: string, alt: string, url: string): string {
  return template.replace('{alt}', alt).replace('{url}', url)
}

function install(): void {
  if (installed) return
  installed = true
  DOMPurify.addHook('uponSanitizeElement', (node, event) => {
    // An image never loads: its address stays readable as text, in the place it would have taken.
    if (event.tagName !== 'img' && event.tagName !== 'image') return
    const el = node as Element
    const url = el.getAttribute('src') ?? el.getAttribute('href') ?? ''
    const alt = el.getAttribute('alt') ?? ''
    const doc = el.ownerDocument
    const span = doc.createElement('span')
    span.setAttribute('class', 'remote-image')
    span.textContent = fill(labels.remoteImage, alt, url)
    el.parentNode?.insertBefore(span, el)
  })
  DOMPurify.addHook('uponSanitizeAttribute', (_node, event) => {
    if (event.attrName === 'class') {
      event.attrValue = event.attrValue
        .split(/\s+/)
        .filter((c) => ALLOWED_CLASSES.has(c))
        .join(' ')
      if (event.attrValue === '') event.keepAttr = false
    }
    // Only this sanitiser writes `data-href`, from a checked `href`.
    if (event.attrName === 'data-href') event.keepAttr = false
  })
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const href = node.getAttribute('href')
    if (node.nodeName === 'A') {
      const url = safeLinkUrl(href)
      node.removeAttribute('href')
      if (url !== null) {
        node.setAttribute('data-href', url)
        node.setAttribute('role', 'link')
        node.setAttribute('tabindex', '0')
      }
    } else if (href !== null) {
      node.removeAttribute('href')
    }
    // A block that scrolls sideways takes the focus, so a keyboard can scroll it too.
    if (node.nodeName === 'PRE') node.setAttribute('tabindex', '0')
  })
}

/** Whether sanitising can run here (a DOM is present). */
export function canSanitize(): boolean {
  return DOMPurify.isSupported
}

/** Sets the words the sanitiser writes; call before rendering when the interface language is known. */
export function setPurifyLabels(next: PurifyLabels): void {
  labels = next
}

/**
 * Sanitises HTML built by the renderer from untrusted Markdown into nodes of this document, parsed through the
 * `dompurify` Trusted Types policy. The fragment is a template: insert clones of it (`cloneNode(true)`).
 */
export function sanitize(html: string): DocumentFragment {
  install()
  return DOMPurify.sanitize(html, { ...CONFIG, RETURN_DOM_FRAGMENT: true })
}
