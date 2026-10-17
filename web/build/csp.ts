import type { Plugin } from 'vite'
import { contentSecurityPolicy } from '../src/security/policy.ts'

/** The placeholder `index.html` carries in its `<meta http-equiv="Content-Security-Policy">`. */
export const CSP_PLACEHOLDER = '%APARTE_CSP%'

/** Escapes a value for a double-quoted HTML attribute. */
export function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * Puts the app's CSP into `index.html`. Under `vite serve` the policy is the dev one (Vite's client and the React
 * refresh preamble need it); `vite build` writes the production policy, which `vite preview` then serves unchanged
 * from `dist`. The build fails when the placeholder is missing, so the page can never ship without a policy.
 */
export function cspPlugin(o: { origin: string; base: string }): Plugin {
  let dev = false
  return {
    name: 'aparte:csp',
    config(_config, env) {
      dev = env.command === 'serve' && env.isPreview !== true
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        if (!html.includes(CSP_PLACEHOLDER)) {
          throw new Error(`${ctx.filename}: ${CSP_PLACEHOLDER} is missing, so the page would ship without its CSP`)
        }
        return html.replaceAll(CSP_PLACEHOLDER, escapeAttribute(contentSecurityPolicy({ ...o, dev })))
      },
    },
  }
}
