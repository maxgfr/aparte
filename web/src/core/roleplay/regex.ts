/*
 * Regex rules (SillyTavern's regex scripts): find-and-replace on what the user types (`input`, before it is committed)
 * or on how answers are shown (`display`, never on what is stored or sent). The rules are the user's own, so they are
 * run as written, within limits: a pattern that does not compile is skipped, a pattern or a text over the caps is
 * left alone, and only the flags `gimsu` are taken.
 */

import type { RegexRule } from '../contracts/extras.ts'
import { substituteMacros } from './cards.ts'

/** Longest pattern compiled. */
export const MAX_PATTERN = 1000
/** Longest text a rule runs on; a longer one is shown as it is. */
export const MAX_SUBJECT = 200_000

const FLAGS = /^[gimsu]*$/

/** The compiled pattern of a rule, or null when it is invalid or over the caps. */
export function compileRule(rule: Pick<RegexRule, 'find' | 'flags'>): RegExp | null {
  if (rule.find === '' || rule.find.length > MAX_PATTERN) return null
  const flags = [...new Set(rule.flags)].join('')
  if (!FLAGS.test(flags)) return null
  try {
    return new RegExp(rule.find, flags)
  } catch {
    return null
  }
}

/** Why a rule cannot run, for the editor: null when it compiles. */
export function ruleProblem(rule: Pick<RegexRule, 'find' | 'flags'>): 'empty' | 'flags' | 'pattern' | null {
  if (rule.find === '') return 'empty'
  if (!FLAGS.test(rule.flags)) return 'flags'
  return compileRule(rule) === null ? 'pattern' : null
}

/** `text` with every enabled rule of `placement` applied, in order. */
export function applyRules(
  text: string,
  rules: readonly RegexRule[],
  placement: RegexRule['placement'],
  names: { readonly char: string; readonly user: string } = { char: '', user: '' },
): string {
  if (text.length > MAX_SUBJECT) return text
  let out = text
  for (const rule of rules) {
    if (!rule.enabled || rule.placement !== placement) continue
    const pattern = compileRule(rule)
    if (pattern === null) continue
    const replace = substituteMacros(rule.replace, names.char, names.user)
    out = out.replace(pattern, replace)
    if (out.length > MAX_SUBJECT) return out
  }
  return out
}
