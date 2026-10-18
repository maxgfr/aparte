/*
 * The text of an answer as it is read aloud: Markdown reduced to its words. Code blocks are left out (a voice reading
 * code helps nobody), links keep their text, and emphasis, headings, list and table markup go. Pure: the answer is
 * untrusted text and is only ever handed to a speech engine as text.
 */

/** Characters read in one go at most: past that, the rest of a long answer is left out. */
export const MAX_SPOKEN_CHARS = 20000

export function speakableText(markdown: string): string {
  return (
    markdown
      // Fenced code blocks, and indented ones (four spaces or a tab after a blank line).
      .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, ' ')
      .replace(/(^|\n)(?:(?: {4}|\t)[^\n]*(?:\n|$))+/g, '$1')
      // Images go, links keep their text, autolinks and bare tags go.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<[^>\n]+>/g, ' ')
      // Inline code keeps its text; emphasis and strike markers go.
      .replace(/`([^`]*)`/g, '$1')
      .replace(/(\*\*|__|\*|_|~~)(?=\S)([^\n]*?\S)\1/g, '$2')
      // Headings, quotes, list bullets and table rules.
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
      .replace(/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '')
      .replace(/\|/g, ' ')
      .replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, MAX_SPOKEN_CHARS)
  )
}
