import { describe, expect, test } from 'bun:test'
import { type ThinkPiece, thinkSplitter } from './think.ts'

/** Feeds `deltas` and folds the pieces into the reasoning, the answer and how many blocks closed. */
function run(deltas: readonly string[]) {
  const split = thinkSplitter()
  const pieces: ThinkPiece[] = []
  for (const d of deltas) pieces.push(...split.push(d))
  pieces.push(...split.flush())
  let reasoning = ''
  let text = ''
  let ends = 0
  for (const p of pieces) {
    if (p.kind === 'end') ends++
    else if (p.kind === 'reasoning') reasoning += p.text
    else text += p.text
  }
  return { reasoning, text, ends }
}

describe('thinkSplitter', () => {
  test('plain text passes through', () => {
    expect(run(['Hello', ' world'])).toEqual({ reasoning: '', text: 'Hello world', ends: 0 })
  })

  test('a leading think block becomes reasoning, the rest the answer', () => {
    expect(run(['<think>Let me see.</think>\n\nParis.'])).toEqual({ reasoning: 'Let me see.', text: 'Paris.', ends: 1 })
  })

  test('tags cut anywhere across deltas', () => {
    const whole = '<think>a < b</think>\n\nThe answer <b> stays.'
    for (let size = 1; size <= 5; size++) {
      const deltas: string[] = []
      for (let i = 0; i < whole.length; i += size) deltas.push(whole.slice(i, i + size))
      expect(run(deltas)).toEqual({ reasoning: 'a < b', text: 'The answer <b> stays.', ends: 1 })
    }
  })

  test('a tag after the answer started is text', () => {
    expect(run(['Use <think> tags', ' like </think> this'])).toEqual({
      reasoning: '',
      text: 'Use <think> tags like </think> this',
      ends: 0,
    })
  })

  test('an unclosed block is closed at the end', () => {
    expect(run(['<think>still thin', 'king'])).toEqual({ reasoning: 'still thinking', text: '', ends: 1 })
  })

  test('a held-back partial tag that never completes is flushed as text', () => {
    expect(run(['  ', '<thi'])).toEqual({ reasoning: '', text: '<thi', ends: 0 })
  })
})
