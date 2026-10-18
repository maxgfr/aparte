/*
 * Arithmetic for the `calculator` tool: a recursive-descent parser over numbers, + - * / % ^, parentheses, a few
 * functions and constants. It never evaluates code: the expression is parsed into numbers only.
 *
 * Grammar (whitespace ignored):
 *   expr   = term (('+' | '-') term)*
 *   term   = unary (('*' | '/' | '%') unary)*
 *   unary  = ('+' | '-') unary | power
 *   power  = atom ('^' unary)?            right-associative, binds tighter than a leading minus on its left
 *   atom   = number | constant | name '(' expr (',' expr)* ')' | '(' expr ')'
 */

const FUNCTIONS: Readonly<Record<string, { arity: [number, number]; fn: (...a: number[]) => number }>> = {
  sqrt: { arity: [1, 1], fn: Math.sqrt },
  cbrt: { arity: [1, 1], fn: Math.cbrt },
  abs: { arity: [1, 1], fn: Math.abs },
  exp: { arity: [1, 1], fn: Math.exp },
  ln: { arity: [1, 1], fn: Math.log },
  log: { arity: [1, 2], fn: (x, base) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base)) },
  log2: { arity: [1, 1], fn: Math.log2 },
  sin: { arity: [1, 1], fn: Math.sin },
  cos: { arity: [1, 1], fn: Math.cos },
  tan: { arity: [1, 1], fn: Math.tan },
  asin: { arity: [1, 1], fn: Math.asin },
  acos: { arity: [1, 1], fn: Math.acos },
  atan: { arity: [1, 1], fn: Math.atan },
  round: {
    arity: [1, 2],
    fn: (x, digits) => {
      const f = 10 ** (digits ?? 0)
      return Math.round(x * f) / f
    },
  },
  floor: { arity: [1, 1], fn: Math.floor },
  ceil: { arity: [1, 1], fn: Math.ceil },
  min: { arity: [1, 64], fn: Math.min },
  max: { arity: [1, 64], fn: Math.max },
  pow: { arity: [2, 2], fn: Math.pow },
}

const CONSTANTS: Readonly<Record<string, number>> = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI }

/** An expression the calculator cannot read; `message` says where, for the model. */
export class CalcError extends Error {}

const MAX_LENGTH = 1000
const MAX_DEPTH = 64

export function calculate(expression: string): number {
  if (expression.length > MAX_LENGTH) throw new CalcError(`The expression is longer than ${MAX_LENGTH} characters`)
  const src = expression
  let at = 0
  let depth = 0

  const skip = () => {
    while (at < src.length && /\s/.test(src[at] as string)) at++
  }
  const peek = () => {
    skip()
    return src[at]
  }
  const fail = (what: string): never => {
    throw new CalcError(`${what} at position ${at + 1}`)
  }
  const nested = <T>(fn: () => T): T => {
    if (++depth > MAX_DEPTH) fail('Too deeply nested')
    try {
      return fn()
    } finally {
      depth--
    }
  }

  const expr = (): number =>
    nested(() => {
      let value = term()
      for (let c = peek(); c === '+' || c === '-'; c = peek()) {
        at++
        value = c === '+' ? value + term() : value - term()
      }
      return value
    })

  const term = (): number => {
    let value = unary()
    for (let c = peek(); c === '*' || c === '/' || c === '%' || c === '×' || c === '÷'; c = peek()) {
      at++
      const right = unary()
      value = c === '*' || c === '×' ? value * right : c === '%' ? value % right : value / right
    }
    return value
  }

  const unary = (): number =>
    nested(() => {
      const c = peek()
      if (c === '-' || c === '−') {
        at++
        return -unary()
      }
      if (c === '+') {
        at++
        return unary()
      }
      return power()
    })

  const power = (): number => {
    const base = atom()
    if (peek() === '^') {
      at++
      return base ** unary()
    }
    return base
  }

  const atom = (): number => {
    const c = peek()
    if (c === undefined) return fail('Unexpected end')
    if (c === '(') {
      at++
      const value = expr()
      if (peek() !== ')') fail('Missing )')
      at++
      return value
    }
    const number = /^(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(at))
    if (number) {
      at += number[0].length
      return Number(number[0].replaceAll('_', ''))
    }
    const name = /^[A-Za-z][A-Za-z0-9]*/.exec(src.slice(at))
    if (name) {
      const id = name[0].toLowerCase()
      at += name[0].length
      if (peek() === '(') {
        const f = Object.hasOwn(FUNCTIONS, id) ? FUNCTIONS[id] : undefined
        if (f === undefined) fail(`Unknown function ${name[0]}`)
        at++
        const args = [expr()]
        while (peek() === ',') {
          at++
          args.push(expr())
        }
        if (peek() !== ')') fail('Missing )')
        at++
        const [lo, hi] = (f as NonNullable<typeof f>).arity
        if (args.length < lo || args.length > hi)
          fail(`${name[0]} takes ${lo === hi ? lo : `${lo} to ${hi}`} arguments`)
        return (f as NonNullable<typeof f>).fn(...args)
      }
      if (Object.hasOwn(CONSTANTS, id)) return CONSTANTS[id] as number
      return fail(`Unknown name ${name[0]}`)
    }
    return fail(`Unexpected ${JSON.stringify(c)}`)
  }

  const value = expr()
  if (peek() !== undefined) fail(`Unexpected ${JSON.stringify(src[at])}`)
  return value
}
