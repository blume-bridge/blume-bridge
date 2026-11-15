/**
 * Decimal string arithmetic on BigInt with a fixed scale. State never holds
 * floats: XRP is kept as an XRP decimal string ("600.5"), IOUs as the decimal
 * string the ledger reports. 18 fractional digits covers XRPL's 15 significant
 * digits and EVM's 18.
 */
const SCALE = 18n
const ONE = 10n ** SCALE

/**
 * Bounds on what a decimal may look like. Without them `1e900000000` makes
 * `10n ** 900000018n` allocate a number with nine hundred million digits, and
 * because every node applies the same agreed view they all hang on it at once:
 * a permanent cluster halt with no admin key to lift it, reachable from a free
 * contract input and from a proposal memo. The XRP Ledger's own IOU format is
 * 15 significant digits with an exponent from -96 to 80, so these are generous.
 */
const MAX_DIGITS = 64
const MAX_EXPONENT = 96

export function parse(s: string): bigint {
  const m = /^(-)?(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(String(s).trim())
  if (!m) throw new Error(`not a decimal: ${s}`)
  const [, neg, whole, frac = '', exp] = m
  const e = exp ? Number(exp) : 0
  if (!Number.isFinite(e) || Math.abs(e) > MAX_EXPONENT) throw new Error(`exponent out of range: ${s}`)
  if (whole.length + frac.length > MAX_DIGITS) throw new Error(`too many digits: ${s}`)
  let digits = whole + frac
  let scale = BigInt(frac.length) - BigInt(exp ? Number(exp) : 0)
  let n = BigInt(digits)
  if (scale <= SCALE) n = n * 10n ** (SCALE - scale)
  else n = n / 10n ** (scale - SCALE)
  return neg ? -n : n
}

export function format(n: bigint): string {
  const neg = n < 0n
  if (neg) n = -n
  const whole = n / ONE
  let frac = (n % ONE).toString().padStart(Number(SCALE), '0').replace(/0+$/, '')
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '')
}

export const add = (a: string, b: string) => format(parse(a) + parse(b))
export const sub = (a: string, b: string) => format(parse(a) - parse(b))
export const cmp = (a: string, b: string) => {
  const x = parse(a), y = parse(b)
  return x < y ? -1 : x > y ? 1 : 0
}
export const gte = (a: string, b: string) => cmp(a, b) >= 0
export const gt = (a: string, b: string) => cmp(a, b) > 0
export const isZero = (a: string) => parse(a) === 0n

/** a × b, rounded down to the scale. */
export function mul(a: string, b: string): string {
  return format((parse(a) * parse(b)) / ONE)
}

/** a ÷ b, rounded down to the scale. Throws on a zero divisor. */
export function div(a: string, b: string): string {
  const d = parse(b)
  if (d === 0n) throw new Error('division by zero')
  return format((parse(a) * ONE) / d)
}

/** a × num / den, rounded down. */
export function mulRatio(a: string, num: number, den: number): string {
  return format((parse(a) * BigInt(num)) / BigInt(den))
}

const DROP = ONE / 1_000_000n
export const fromDrops = (drops: string) => format(BigInt(drops) * DROP)
export const toDrops = (xrp: string) => (parse(xrp) / DROP).toString()
/** Rounds down to whole drops, the smallest XRP amount a payment can carry. */
export const floorToDrops = (xrp: string) => format((parse(xrp) / DROP) * DROP)
/** Whether an XRP amount is a whole number of drops, so converting it to drops and back loses nothing. */
export const isWholeDrops = (xrp: string) => parse(xrp) % DROP === 0n

/**
 * Rounds down to `digits` significant digits. An IOU value the ledger accepts
 * has at most 15 (ripple-binary-codec refuses more), while an 18-decimal
 * ERC-20 burn can carry 19; whatever is cut stays with the bridge as fee.
 */
export function toSignificant(a: string, digits: number): string {
  let n = parse(a)
  const neg = n < 0n
  if (neg) n = -n
  const len = n.toString().length
  if (len > digits) {
    const unit = 10n ** BigInt(len - digits)
    n = (n / unit) * unit
  }
  return format(neg ? -n : n)
}

/** For UI shapes only. Precision loss is acceptable there. */
export const toNumber = (a: string) => Number(format(parse(a)))
