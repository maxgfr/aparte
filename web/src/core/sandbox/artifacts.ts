/*
 * Artifacts: what in an answer or a tool output is shown as a live preview (HTML, SVG, Mermaid), and whether showing
 * it would run code. Pure. The preview itself is drawn by the artifact frame (web/src/sandbox/frame/artifact.ts).
 *
 * Invariants:
 * - An artifact is shown inert by default (an HTML document in a frame without scripts, an SVG as an image, a Mermaid
 *   diagram rendered by the pinned Mermaid). One that would run code is run only after the user's Run click, and
 *   always inside the sandbox.
 * - The script detection decides whether a Run button is offered, never whether code is allowed to run: the inert
 *   preview is inert because of the frame's own sandbox, whatever the source holds.
 */
import { type ArtifactKind, type ArtifactSource, MAX_ARTIFACT_CHARS } from '../contracts/sandbox.ts'

/** A fenced block that becomes an artifact card: ` ```html `, ` ```svg ` (or an `xml` fence holding one SVG), ` ```mermaid `. */
export function artifactOfFence(lang: string, text: string): ArtifactSource | null {
  const source = text.trim()
  if (source === '' || source.length > MAX_ARTIFACT_CHARS) return null
  if (lang === 'mermaid') return { kind: 'mermaid', source }
  if (lang === 'svg' || (lang === 'xml' && /^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(source))) {
    return /<svg\b/i.test(source) ? { kind: 'svg', source } : null
  }
  if (lang === 'html' || lang === 'htm') return /<[a-z!][^>]*>/i.test(source) ? { kind: 'html', source } : null
  return null
}

/** The artifact a file written by a run is, by its media type; null for any other file. */
export function artifactOfFile(mediaType: string, text: string): ArtifactSource | null {
  const kind: ArtifactKind | null = mediaType === 'text/html' ? 'html' : mediaType === 'image/svg+xml' ? 'svg' : null
  if (kind === null || text.length > MAX_ARTIFACT_CHARS) return null
  return { kind, source: text }
}

/**
 * Whether showing the artifact as a document would run code: a script element, an inline event handler, a
 * `javascript:` URL, or a `<meta http-equiv>` (a refresh navigates). Mermaid never does.
 */
export function hasScripts(artifact: ArtifactSource): boolean {
  if (artifact.kind === 'mermaid') return false
  return /<script\b|\son[a-z]+\s*=|javascript\s*:|<meta\b[^>]*http-equiv/i.test(artifact.source)
}
