/**
 * Decimal money primitives — exact integer minor-unit amounts, never binary
 * float (FUT-PKG-04-SECURITY/T-007, design.md D-07).
 *
 * Money in NeuroNest budgets is decimal and MUST NOT be represented, summed,
 * compared, or rounded through JavaScript's binary `number` type: `0.1 + 0.2`
 * is not `0.3` in IEEE-754, and repeated cost accrual would drift. Instead a
 * {@link Money} value is an arbitrary-precision **integer count of minor
 * units** (`BigInt`) tagged with an ISO-4217-shaped currency code and the
 * number of fractional decimal digits (`scale`) that define the minor unit.
 *
 *   - `{ currency: 'USD', scale: 2, minorUnits: 1050n }`  ==  $10.50
 *   - `{ currency: 'USD', scale: 6, minorUnits: 12n }`    ==  $0.000012
 *
 * All arithmetic (`addMoney`, `subMoney`, `compareMoney`) is exact `BigInt`
 * arithmetic. Serialization emits the canonical decimal **string** (e.g.
 * `"10.50"`) and the minor-unit integer as a string, so a round trip never
 * passes through a binary float. Parsing a decimal string is done by string
 * manipulation, not `parseFloat`, so `"0.1"` and `"0.2"` add to exactly
 * `"0.3"`.
 *
 * Two `Money` values may only be combined when their `currency` AND `scale`
 * match; a mismatch is a caller error (the Budget Authority translates it into
 * a typed `CONFLICT`/`STALE_REVISION`), never a silent conversion.
 *
 * Design anchors: D-07 (decimal money, `BudgetRecord@1` currency/unit).
 * Requirements: NN-OBS-003 (explicit currency/pricing version),
 * NN-ORCH-013 (hard budget), NN-DATA-010 (round-trip equivalence).
 */

/** ISO-4217-shaped currency/unit code: 3–12 upper-case alphanumerics. */
const CURRENCY_PATTERN = /^[A-Z][A-Z0-9]{2,11}$/;

/** A decimal string: optional sign, integer part, optional fractional part. */
const DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

/** Maximum supported fractional scale (guards against pathological input). */
export const MAX_MONEY_SCALE = 18;

/**
 * A decimal money amount as an exact integer count of minor units. `minorUnits`
 * is a `BigInt`; `scale` is the number of fractional decimal digits that define
 * one minor unit (2 for cents, 6 for micro-USD). Never a binary float.
 */
export interface Money {
  readonly currency: string;
  readonly scale: number;
  readonly minorUnits: bigint;
}

/** Whether a value is a syntactically valid currency/unit code. */
export function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_PATTERN.test(value);
}

/** Whether a value is a valid non-negative integer scale within bounds. */
export function isScale(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_MONEY_SCALE
  );
}

/**
 * Construct a {@link Money} from a currency, scale, and minor-unit integer.
 * Throws on an invalid currency or scale. `minorUnits` may be negative for an
 * intermediate difference, though budget balances are held non-negative by the
 * authority.
 */
export function money(currency: string, scale: number, minorUnits: bigint): Money {
  if (!isCurrencyCode(currency)) {
    throw new Error(`money: invalid currency code ${JSON.stringify(currency)}`);
  }
  if (!isScale(scale)) {
    throw new Error(`money: invalid scale ${JSON.stringify(scale)}`);
  }
  if (typeof minorUnits !== 'bigint') {
    throw new Error('money: minorUnits must be a bigint');
  }
  return { currency, scale, minorUnits };
}

/** A zero amount in the given currency and scale. */
export function zeroMoney(currency: string, scale: number): Money {
  return money(currency, scale, 0n);
}

/**
 * Parse a canonical decimal string (e.g. `"10.50"`) into {@link Money} at the
 * given `scale` using pure string arithmetic — never `parseFloat`/`Number`.
 * The fractional part must not exceed `scale` digits (exactness is not
 * silently discarded); fewer digits are right-padded with zeros. Returns
 * `undefined` on any malformed input so callers can produce a typed error.
 */
export function parseDecimalMoney(
  decimal: string,
  currency: string,
  scale: number,
): Money | undefined {
  if (typeof decimal !== 'string' || !DECIMAL_PATTERN.test(decimal)) {
    return undefined;
  }
  if (!isCurrencyCode(currency) || !isScale(scale)) {
    return undefined;
  }
  const negative = decimal.startsWith('-');
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [intPart, fracPart = ''] = unsigned.split('.');
  if (fracPart.length > scale) {
    // More precision than the minor unit can represent: reject rather than
    // round with binary float (exactness is a requirement, not a nicety).
    return undefined;
  }
  const paddedFrac = fracPart.padEnd(scale, '0');
  const digits = `${intPart}${paddedFrac}`;
  // BigInt parses an arbitrary-length decimal integer string exactly.
  const magnitude = digits.length > 0 ? BigInt(digits) : 0n;
  const minorUnits = negative ? -magnitude : magnitude;
  return { currency, scale, minorUnits };
}

/**
 * Render {@link Money} as its canonical decimal string (e.g. `"10.50"`) using
 * pure `BigInt`/string arithmetic. The fractional part always has exactly
 * `scale` digits; a scale of `0` renders no decimal point.
 */
export function formatDecimalMoney(amount: Money): string {
  const negative = amount.minorUnits < 0n;
  const magnitude = negative ? -amount.minorUnits : amount.minorUnits;
  const digits = magnitude.toString();
  const sign = negative ? '-' : '';
  if (amount.scale === 0) {
    return `${sign}${digits}`;
  }
  const padded = digits.padStart(amount.scale + 1, '0');
  const cut = padded.length - amount.scale;
  const intPart = padded.slice(0, cut);
  const fracPart = padded.slice(cut);
  return `${sign}${intPart}.${fracPart}`;
}

/** Whether two amounts share the same currency AND scale (combinable). */
export function sameDenomination(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.scale === b.scale;
}

function assertSameDenomination(a: Money, b: Money, op: string): void {
  if (!sameDenomination(a, b)) {
    throw new Error(
      `${op}: denomination mismatch ${a.currency}@${a.scale} vs ${b.currency}@${b.scale}`,
    );
  }
}

/** Exact addition. Throws on a currency/scale mismatch (never converts). */
export function addMoney(a: Money, b: Money): Money {
  assertSameDenomination(a, b, 'addMoney');
  return { currency: a.currency, scale: a.scale, minorUnits: a.minorUnits + b.minorUnits };
}

/** Exact subtraction. Throws on a currency/scale mismatch (never converts). */
export function subMoney(a: Money, b: Money): Money {
  assertSameDenomination(a, b, 'subMoney');
  return { currency: a.currency, scale: a.scale, minorUnits: a.minorUnits - b.minorUnits };
}

/**
 * Compare two amounts of the same denomination: `-1` if `a < b`, `0` if equal,
 * `1` if `a > b`. Throws on a currency/scale mismatch (never converts).
 */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameDenomination(a, b, 'compareMoney');
  if (a.minorUnits < b.minorUnits) return -1;
  if (a.minorUnits > b.minorUnits) return 1;
  return 0;
}

/** Whether the amount is negative. */
export function isNegativeMoney(a: Money): boolean {
  return a.minorUnits < 0n;
}

/** Whether the amount is exactly zero. */
export function isZeroMoney(a: Money): boolean {
  return a.minorUnits === 0n;
}

/**
 * A durable, JSON-safe projection of {@link Money}. `minorUnits` is a decimal
 * string (BigInt is not JSON-serializable) and `decimal` is the canonical
 * human decimal string; neither is a binary float, so a store→read round trip
 * is exact (NN-DATA-010).
 */
export interface MoneyWire {
  readonly currency: string;
  readonly scale: number;
  readonly minorUnits: string;
  readonly decimal: string;
}

/** Project {@link Money} to its durable wire form (no binary float). */
export function toMoneyWire(amount: Money): MoneyWire {
  return {
    currency: amount.currency,
    scale: amount.scale,
    minorUnits: amount.minorUnits.toString(),
    decimal: formatDecimalMoney(amount),
  };
}

/**
 * Rebuild {@link Money} from its wire form. The `minorUnits` string is the
 * source of truth (parsed exactly by `BigInt`); `decimal` is display-only.
 * Returns `undefined` on malformed input.
 */
export function fromMoneyWire(wire: unknown): Money | undefined {
  if (wire === null || typeof wire !== 'object') return undefined;
  const w = wire as Record<string, unknown>;
  if (!isCurrencyCode(w.currency) || !isScale(w.scale)) return undefined;
  if (typeof w.minorUnits !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/.test(w.minorUnits)) {
    return undefined;
  }
  return {
    currency: w.currency,
    scale: w.scale,
    minorUnits: BigInt(w.minorUnits),
  };
}
