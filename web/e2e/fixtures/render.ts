import type { Locator } from '@playwright/test'

/*
 * What a rendered answer may contain. Model output is untrusted: whatever the sanitised renderer keeps of it must be
 * inert (no element that runs, loads, submits or navigates, no event handler, no URL with a script or document
 * scheme), load nothing (a src only from blob: or data:image, which make no request), and offer no field to type
 * into: an answer that draws a passphrase box inside a vault app is phishing.
 */

/** Elements that run code, load a document or a style, submit, navigate, take input, or rewrite a link (SVG). */
const FORBIDDEN_ELEMENTS = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'portal',
  'meta',
  'base',
  'link',
  'style',
  'form',
  'noscript',
  'template',
  'textarea',
  'select',
  'foreignObject',
  'image',
  'use',
  'feImage',
  'animate',
  'animateMotion',
  'animateTransform',
  'set',
  'isindex',
]

/** Attributes that fetch, submit, embed a document or tell the browser to ping a host. */
const FORBIDDEN_ATTRIBUTES = ['srcdoc', 'srcset', 'ping', 'action', 'formaction', 'poster', 'background', 'data']

/** Everything in `content` that breaks the rules above, one line each; empty when the answer is inert. */
export async function unsafeMarkup(content: Locator): Promise<string[]> {
  return content.evaluate(
    (root, [elements, attributes]) => {
      const found: string[] = []
      const describe = (el: Element) => `<${el.tagName.toLowerCase()}>`
      const all = [root, ...root.querySelectorAll('*')]
      for (const el of all) {
        const tag = el.localName
        if (elements.some((e) => e.toLowerCase() === tag.toLowerCase())) found.push(`element ${describe(el)}`)
        // A task list checkbox is the only input Markdown makes, and it is read-only.
        if (tag === 'input' && !((el as HTMLInputElement).type === 'checkbox' && (el as HTMLInputElement).disabled))
          found.push(`element <input type=${(el as HTMLInputElement).type}>`)
        for (const attr of el.attributes) {
          const name = attr.name.toLowerCase()
          const value = attr.value
          if (name.startsWith('on')) found.push(`handler ${name} on ${describe(el)}`)
          if (attributes.includes(name)) found.push(`attribute ${name} on ${describe(el)}`)
          if (name === 'style' && /url\s*\(|expression\s*\(|@import/i.test(value))
            found.push(`style that loads on ${describe(el)}: ${value}`)
          if (name === 'href' || name === 'xlink:href' || name === 'src' || name.endsWith(':href')) {
            let protocol: string
            try {
              protocol = new URL(value, document.baseURI).protocol
            } catch {
              continue
            }
            if (name === 'src') {
              const inert = protocol === 'blob:' || (protocol === 'data:' && /^\s*data:image\//i.test(value))
              if (!inert) found.push(`${describe(el)} src that loads: ${value}`)
            } else if (!['http:', 'https:', 'mailto:'].includes(protocol) && !value.trim().startsWith('#'))
              found.push(`${name} with scheme ${protocol} on ${describe(el)}`)
          }
        }
      }
      // The app has no base element: one anywhere in the document re-targets every relative URL of the app.
      if (document.querySelector('base')) found.push(`document base changed to ${document.baseURI}`)
      return found
    },
    [FORBIDDEN_ELEMENTS, FORBIDDEN_ATTRIBUTES] as const,
  )
}

/**
 * The rendered answer as a canonical string: tags, attributes and text in document order, without the attributes
 * that only tie elements together (ids, labels pointing to them), which may be numbered differently on each render.
 */
export async function canonicalMarkup(content: Locator): Promise<string> {
  return content.evaluate((root) => {
    const linking = new Set(['id', 'for', 'aria-controls', 'aria-labelledby', 'aria-describedby', 'aria-owns'])
    // A fragment link points to an id, so it is left out with the ids.
    const kept = (a: Attr) => !linking.has(a.name) && !(a.name === 'href' && a.value.startsWith('#'))
    const out: string[] = []
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.textContent) out.push(JSON.stringify(node.textContent))
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      const el = node as Element
      const attrs = [...el.attributes]
        .filter(kept)
        .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
        .sort()
      out.push(`<${el.localName}${attrs.length ? ` ${attrs.join(' ')}` : ''}>`)
      for (const child of el.childNodes) walk(child)
      out.push(`</${el.localName}>`)
    }
    for (const child of root.childNodes) walk(child)
    return out.join('')
  })
}
