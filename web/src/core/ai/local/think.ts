/*
 * Splits a model's raw output into reasoning and answer: open-weight reasoning models (Qwen3, Qwen3.5) write their
 * thoughts between `<think>` and `</think>` in the same text stream. The tags may be cut anywhere across deltas, so
 * the splitter holds back only what could still be the start of a tag.
 */

export type ThinkPiece = { readonly kind: 'reasoning' | 'text'; readonly text: string } | { readonly kind: 'end' }

const OPEN = '<think>'
const CLOSE = '</think>'

/** The length of the longest suffix of `s` that is a prefix of `tag`. */
function partial(s: string, tag: string): number {
  for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) if (tag.startsWith(s.slice(s.length - n))) return n
  return 0
}

export interface ThinkSplitter {
  /** The pieces `delta` completes; `end` marks the close of a reasoning block. */
  push(delta: string): ThinkPiece[]
  /** What was held back, once the stream has ended. */
  flush(): ThinkPiece[]
}

export function thinkSplitter(): ThinkSplitter {
  let buffer = ''
  let thinking = false
  /** Only leading whitespace may precede `<think>`; once answer text has started, a tag is plain text. */
  let started = false
  /** The answer begins: the whitespace that separated it from the reasoning is not part of it. */
  const start = () => {
    started = true
    buffer = buffer.replace(/^\s+/, '')
  }
  const emit = (out: ThinkPiece[], text: string) => {
    if (text === '') return
    if (!thinking && !started && text.trim() === '') return
    out.push({ kind: thinking ? 'reasoning' : 'text', text })
    if (!thinking) started = true
  }
  return {
    push(delta) {
      buffer += delta
      const out: ThinkPiece[] = []
      for (;;) {
        const tag = thinking ? CLOSE : started ? null : OPEN
        if (tag === null) {
          emit(out, buffer)
          buffer = ''
          return out
        }
        const at = buffer.indexOf(tag)
        if (at !== -1) {
          const before = buffer.slice(0, at)
          if (!thinking && before.trim() !== '') {
            // Text came first: this is an answer, and the tag is part of it.
            start()
            continue
          }
          emit(out, before)
          buffer = buffer.slice(at + tag.length)
          if (thinking) out.push({ kind: 'end' })
          thinking = !thinking
          continue
        }
        const keep = partial(buffer, tag)
        if (!thinking && buffer.slice(0, buffer.length - keep).trim() !== '') {
          start()
          continue
        }
        emit(out, buffer.slice(0, buffer.length - keep))
        buffer = buffer.slice(buffer.length - keep)
        return out
      }
    },
    flush() {
      const out: ThinkPiece[] = []
      emit(out, buffer)
      buffer = ''
      if (thinking) out.push({ kind: 'end' })
      thinking = false
      return out
    },
  }
}
