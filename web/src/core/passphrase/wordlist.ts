/*
 * The bundled EFF large wordlist ("EFF's Long Wordlist" by the Electronic Frontier Foundation,
 * https://www.eff.org/dice, CC BY 3.0 US; see LICENSE-EFF.txt next to this file). The text is inlined by the build
 * into the chunk of the screen that imports this module, so it is never fetched at runtime and never weighs on the
 * first paint.
 */

import { parseWordlist } from './diceware.ts'
import raw from './eff-large-wordlist.txt?raw'

let cached: readonly string[] | null = null

/** The parsed list, validated once. */
export function effWordlist(): readonly string[] {
  cached ??= parseWordlist(raw)
  return cached
}
