/**
 * Integer money math.
 * Amounts are base units. USD values use micros (6 decimal places).
 * Conversion rounds up so a cap check never understates the spend.
 *
 * For a price with at most 6 fractional digits this matches
 * usd_micros = ceil(amount_base_units * price_micros / 10^decimals).
 * Extra price digits are kept and the same ceiling is applied at the end.
 */

/** Exact non-negative decimal: value = numerator / 10^scale. */
export interface Decimal {
  numerator: bigint;
  scale: number;
}

const UINT_RE = /^(0|[1-9][0-9]{0,77})$/;
const USD_RE = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/;
const PRICE_RE = /^(0|[1-9][0-9]{0,11})(\.[0-9]{1,18})?$/;

export function parseUint(value: string): bigint | null {
  if (!UINT_RE.test(value)) return null;
  return BigInt(value);
}

export function parseUsd(value: string): Decimal | null {
  return parseDecimal(value, USD_RE, 6);
}

/** Price strings may carry up to 18 fractional digits. Zero is parsed, then rejected by the caller. */
export function parsePrice(value: string): Decimal | null {
  return parseDecimal(value, PRICE_RE, 18);
}

function parseDecimal(value: string, pattern: RegExp, maxFrac: number): Decimal | null {
  if (typeof value !== "string" || !pattern.test(value)) return null;
  const [whole, frac = ""] = value.split(".");
  if (frac.length > maxFrac) return null;
  const digits = `${whole}${frac}`;
  return { numerator: BigInt(digits), scale: frac.length };
}

export function usdToMicros(value: string): bigint | null {
  const parsed = parseUsd(value);
  if (!parsed) return null;
  return decimalToMicros(parsed);
}

/** Exact conversion of a USD decimal with at most 6 fractional digits into micros. */
export function decimalToMicros(value: Decimal): bigint {
  if (value.scale > 6) {
    throw new Error("USD decimal has more than 6 fractional digits.");
  }
  const pad = 10n ** BigInt(6 - value.scale);
  return value.numerator * pad;
}

export function microsToUsd(micros: bigint): string {
  if (micros < 0n) {
    throw new Error("USD micros cannot be negative.");
  }
  const whole = micros / 1_000_000n;
  const frac = (micros % 1_000_000n).toString().padStart(6, "0");
  return `${whole.toString()}.${frac}`;
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error("Division denominator must be positive.");
  }
  if (numerator < 0n) {
    throw new Error("Division numerator cannot be negative.");
  }
  return (numerator + denominator - 1n) / denominator;
}

/**
 * USD micros for a base-unit amount at a USD price, rounded up.
 * A zero amount is zero. A positive dust amount becomes at least 1 micro when the true value is not zero.
 */
export function usdMicrosFromBaseUnits(amount: bigint, decimals: number, price: Decimal): bigint {
  if (amount < 0n) {
    throw new Error("Amount cannot be negative.");
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("Decimals are out of range.");
  }
  if (price.numerator < 0n || price.scale < 0) {
    throw new Error("Price is invalid.");
  }
  const denominator = 10n ** BigInt(decimals + price.scale);
  const numerator = amount * price.numerator * 1_000_000n;
  return ceilDiv(numerator, denominator);
}

export function isPositiveDecimal(value: Decimal): boolean {
  return value.numerator > 0n;
}

/**
 * True when |a - b| / min(a, b) is strictly greater than maxBps / 10000.
 * Equal to the limit is not a breach.
 */
export function exceedsDeviationBps(a: Decimal, b: Decimal, maxBps: number): boolean {
  const ad = 10n ** BigInt(a.scale);
  const bd = 10n ** BigInt(b.scale);
  const left = a.numerator * bd;
  const right = b.numerator * ad;
  const diff = left > right ? left - right : right - left;
  const minNum = left < right ? a.numerator : b.numerator;
  const minDen = left < right ? ad : bd;
  if (minNum <= 0n) return true;
  const lhs = diff * 10_000n * minDen;
  const rhs = BigInt(maxBps) * minNum * ad * bd;
  return lhs > rhs;
}

/**
 * True when the price is strictly outside 1 +/- toleranceBps.
 * The boundary itself is still inside the band.
 */
export function outsideStableBand(price: Decimal, toleranceBps: number): boolean {
  const scale = 10n ** BigInt(price.scale);
  const left = abs(price.numerator * 10_000n - scale * 10_000n);
  const right = BigInt(toleranceBps) * scale;
  return left > right;
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}
