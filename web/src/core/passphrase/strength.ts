/*
 * Strength check of a passphrase the user types themselves, with zxcvbn-ts. Its dictionaries weigh about a megabyte,
 * so they load on the first check only (a lazy chunk), never for a generated passphrase and never at startup.
 *
 * Invariants:
 * - A custom passphrase is accepted only at score MIN_SCORE or more, the same rule on every screen that sets one.
 * - The passphrase is never stored, logged or sent: the check runs in memory and returns only a score.
 */

/** zxcvbn score: 0 (guessed at once) to 4 (beyond 10^10 guesses). */
export type Score = 0 | 1 | 2 | 3 | 4

/** The lowest score a custom passphrase may have. */
export const MIN_SCORE: Score = 3

export interface Strength {
  readonly score: Score
  /** Whether the score reaches MIN_SCORE. */
  readonly acceptable: boolean
}

export type StrengthCheck = (passphrase: string) => Strength

/** Words that make a passphrase easy to guess for anyone who knows where it is used. */
const CONTEXT_WORDS = ['aparte', 'aparté', 'vault', 'passphrase', 'password', 'secret']

let loading: Promise<StrengthCheck> | null = null

/** Loads the estimator once (concurrent callers share the load); a failed load is retried on the next call. */
export function loadStrengthCheck(): Promise<StrengthCheck> {
  loading ??= build().catch((e: unknown) => {
    loading = null
    throw e
  })
  return loading
}

async function build(): Promise<StrengthCheck> {
  const [{ ZxcvbnFactory }, common, en] = await Promise.all([
    import('@zxcvbn-ts/core'),
    import('@zxcvbn-ts/language-common'),
    import('@zxcvbn-ts/language-en'),
  ])
  const zxcvbn = new ZxcvbnFactory({
    dictionary: { ...common.dictionary, ...en.dictionary },
    graphs: common.adjacencyGraphs,
    translations: en.translations,
    useLevenshteinDistance: true,
  })
  return (passphrase) => {
    const score = zxcvbn.check(passphrase, CONTEXT_WORDS).score as Score
    return { score, acceptable: score >= MIN_SCORE }
  }
}
