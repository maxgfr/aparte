import type { Catalog, Message } from './index.ts'

const ACCENTS: Readonly<Record<string, string>> = {
  a: 'á',
  b: 'ƀ',
  c: 'ç',
  d: 'ð',
  e: 'é',
  f: 'ƒ',
  g: 'ĝ',
  h: 'ĥ',
  i: 'í',
  j: 'ĵ',
  k: 'ķ',
  l: 'ļ',
  m: 'ɱ',
  n: 'ñ',
  o: 'ó',
  p: 'þ',
  q: 'ǫ',
  r: 'ŕ',
  s: 'š',
  t: 'ţ',
  u: 'ú',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẋ',
  y: 'ý',
  z: 'ž',
  A: 'Á',
  B: 'Ɓ',
  C: 'Ç',
  D: 'Ð',
  E: 'É',
  F: 'Ƒ',
  G: 'Ĝ',
  H: 'Ĥ',
  I: 'Í',
  J: 'Ĵ',
  K: 'Ķ',
  L: 'Ļ',
  M: 'Ṁ',
  N: 'Ñ',
  O: 'Ó',
  P: 'Þ',
  Q: 'Ǫ',
  R: 'Ŕ',
  S: 'Š',
  T: 'Ţ',
  U: 'Ú',
  V: 'Ṽ',
  W: 'Ŵ',
  X: 'Ẋ',
  Y: 'Ý',
  Z: 'Ž',
}

/** Accents letters (placeholders untouched), pads ~35 %, wraps in brackets. */
export function pseudoize(text: string): string {
  const parts = text.split(/(\{\w+\})/)
  const body = parts
    .map((part) => (/^\{\w+\}$/.test(part) ? part : [...part].map((ch) => ACCENTS[ch] ?? ch).join('')))
    .join('')
  const pad = '~'.repeat(Math.ceil(text.length * 0.35))
  return `[${body}${pad}]`
}

function pseudoMessage(message: Message): Message {
  return typeof message === 'string'
    ? message && pseudoize(message)
    : { one: pseudoize(message.one), other: pseudoize(message.other) }
}

export function pseudoCatalog(source: Catalog): Catalog {
  const out: Record<string, Record<string, Message>> = {}
  for (const [ns, table] of Object.entries(source)) {
    const entries: Readonly<Record<string, Message>> = table
    out[ns] = Object.fromEntries(Object.entries(entries).map(([k, m]) => [k, pseudoMessage(m)]))
  }
  return out as unknown as Catalog
}
