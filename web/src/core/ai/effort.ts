/*
 * The effort scale and how each provider takes it (EffortModule in web/src/core/contracts/ai.ts). The tables come from
 * the makers' own documentation; a model nobody documented takes no effort, because guessing risks a request the API
 * refuses. The UI hides the control when `effortLevels` is empty and the adapter then sends nothing.
 */
import type { Effort, EffortWire, ProviderKind } from '../contracts/ai.ts'

/** Every level, weakest first: the order the settings list them in. */
export const EFFORTS: readonly Effort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const LMH: readonly Effort[] = ['low', 'medium', 'high']
const LMHX: readonly Effort[] = ['low', 'medium', 'high', 'xhigh']
const LMHXM: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * A model id as the tables match it: lower case, `.` folded to `-`, any `:variant` and any date suffix dropped, so
 * `claude-sonnet-4-6-20260115`, `gemini-2.5-flash` and `openai/gpt-5.1:nitro` resolve like their bare names.
 */
export function modelKey(modelId: string): string {
  return modelId
    .toLowerCase()
    .replace(/:.*$/, '')
    .replace(/\./g, '-')
    .replace(/-\d{8}$|-\d{4}-\d{2}-\d{2}$/, '')
}

/**
 * What each maker's API accepts, by model key; the first match wins. Anthropic: `output_config.effort` from Claude
 * 4.6 on (`xhigh` from 4.7), a thinking budget before. OpenAI: `reasoning.effort` (the contract's wire has no `max`
 * there, so it is never offered). Gemini: `thinkingLevel` on Gemini 3, a thinking budget on 2.5.
 */
const LEVELS: Readonly<Partial<Record<ProviderKind, readonly (readonly [RegExp, readonly Effort[]])[]>>> = {
  anthropic: [
    [/^claude-(fable|mythos)-5(-1)?$|^claude-mythos-preview$|^claude-(opus|sonnet)-5(-5)?$|^claude-haiku-5-5$/, LMHXM],
    [/^claude-opus-4-[78]$/, LMHXM],
    [/^claude-(opus|sonnet)-4-6$/, ['low', 'medium', 'high', 'max']],
    [/^claude-(opus|sonnet|haiku)-4-5$|^claude-opus-4-1$|^claude-(opus|sonnet)-4$/, LMH],
  ],
  openai: [
    [/^gpt-6-(sol|luna)$|^gpt-5-6(-(sol|luna|terra))?$/, ['none', ...LMHX]],
    [/^gpt-6(-\d+)?-(sol|luna|astra)$/, LMHX],
    [/^gpt-5-[2-5]-pro$/, ['medium', 'high', 'xhigh']],
    [/^gpt-5-[2-5](-mini|-nano)?$/, ['none', ...LMHX]],
    [/^gpt-5-[2-9]-codex$|^gpt-5-1-codex-max$/, LMHX],
    [/^gpt-5(-1)?-codex(-mini)?$/, LMH],
    [/^gpt-5-1$/, ['none', ...LMH]],
    [/^gpt-5(-mini|-nano)?$/, ['minimal', ...LMH]],
    [/^(o1|o3|o3-mini|o3-pro|o4-mini)$/, LMH],
  ],
  google: [
    [/^gemini-4-argon$/, LMH],
    [/^gemini-3-pro(-preview)?$/, ['low', 'high']],
    [/^gemini-3-1-pro(-preview)?(-customtools)?$/, LMH],
    [/^gemini-3-[7-9]-flash(-preview)?$/, LMH],
    [/^gemini-3(-[1-6])?-flash(-lite)?(-preview)?$/, ['minimal', ...LMH]],
    [/^gemini-2-5-(pro|flash|flash-lite)$/, LMH],
  ],
}

/** OpenRouter's `reasoning.effort` takes these and maps them onto each maker's own parameter; it has no `max`. */
const OPENROUTER: ReadonlySet<Effort> = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])

/** Thinking budgets in tokens for the Anthropic models that take one (always at least 1024, below max_tokens). */
const ANTHROPIC_BUDGET: Readonly<Partial<Record<Effort, number>>> = { low: 2048, medium: 8192, high: 24_576 }
/** Gemini 2.5 thinking budgets in tokens (Flash accepts up to 24576, Pro up to 32768). */
const GEMINI_BUDGET: Readonly<Partial<Record<Effort, number>>> = { low: 1024, medium: 8192, high: 24_576 }

function makerLevels(maker: ProviderKind, modelId: string): readonly Effort[] {
  const key = modelKey(modelId)
  return LEVELS[maker]?.find(([re]) => re.test(key))?.[1] ?? []
}

/** Whether an Anthropic model takes effort as a thinking budget (the models before Claude 4.6). */
function anthropicBudgeted(modelId: string): boolean {
  return /^claude-(opus|sonnet|haiku)-4-5$|^claude-opus-4-1$|^claude-(opus|sonnet)-4$/.test(modelKey(modelId))
}

/** Whether a Gemini model takes a thinking budget rather than a level (Gemini 2.5). */
function geminiBudgeted(modelId: string): boolean {
  return /^gemini-2-5-/.test(modelKey(modelId))
}

export function effortLevels(kind: ProviderKind, modelId: string): readonly Effort[] {
  switch (kind) {
    case 'anthropic':
    case 'openai':
    case 'google':
      return makerLevels(kind, modelId)
    case 'openrouter': {
      // Only `maker/model` ids name a maker whose table applies.
      const slash = modelId.indexOf('/')
      if (slash < 0) return []
      const maker = modelId.slice(0, slash)
      if (maker !== 'anthropic' && maker !== 'openai' && maker !== 'google') return []
      return makerLevels(maker, modelId.slice(slash + 1)).filter((l) => OPENROUTER.has(l))
    }
    default:
      // Another server speaking the same protocol may refuse a parameter it does not know.
      return []
  }
}

export function effortWire(kind: ProviderKind, modelId: string, effort: Effort): EffortWire | null {
  if (!effortLevels(kind, modelId).includes(effort)) return null
  switch (kind) {
    case 'anthropic': {
      if (anthropicBudgeted(modelId)) {
        const value = ANTHROPIC_BUDGET[effort]
        return value === undefined ? null : { param: 'thinking.budget_tokens', value }
      }
      if (effort === 'none' || effort === 'minimal') return null
      return { param: 'output_config.effort', value: effort }
    }
    case 'openai':
    case 'openrouter':
      if (effort === 'max') return null
      return { param: 'reasoning.effort', value: effort }
    case 'google': {
      if (geminiBudgeted(modelId)) {
        const value = GEMINI_BUDGET[effort]
        return value === undefined ? null : { param: 'thinkingConfig.thinkingBudget', value }
      }
      if (effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high') {
        return { param: 'thinkingConfig.thinkingLevel', value: effort }
      }
      return null
    }
    default:
      return null
  }
}

export function usableEffort(effort: Effort | null | undefined, levels: readonly Effort[]): Effort | null {
  return effort !== null && effort !== undefined && levels.includes(effort) ? effort : null
}
