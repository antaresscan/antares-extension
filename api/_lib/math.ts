// api/_lib/math.ts — Small numeric helpers shared by the engine layers.

/**
 * A plain decimal number written as text: optional sign, digits with an optional fraction, optional exponent ("12", "-0.5", ".5",
 * "1e-3", "2.5E+4"). Nothing else: no hexadecimal, no unit, no thousands separator, no trailing text.
 */
const DECIMAL_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Read an upstream value as a finite number, 0 when it is not one. A number is taken as is; a string only when it is a plain decimal
 * once trimmed. parseFloat used to be lenient: "12abc" read 12, "1,234.5" read 1 and "5%" read 5, a small wrong number where the honest
 * reading is "unknown" (0). Anything else (null, undefined, booleans, objects, arrays) reads 0, as before.
 */
export function asNumber(v: unknown): number {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string") {
    const s = v.trim();
    n = DECIMAL_RE.test(s) ? Number(s) : Number.NaN;
  } else if (typeof v === "bigint") n = Number(v);
  else n = Number.NaN;
  return Number.isFinite(n) ? n : 0;
}

/** Arithmetic mean, 0 for an empty list. */
export function _mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Population standard deviation (divides by n, not n - 1), 0 for fewer than two values. */
export function _std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = _mean(xs);
  return Math.sqrt(_mean(xs.map(x => (x - m) ** 2)));
}

/** Percentage change from `from` to `to`, 0 when `from` is 0 or not finite (no base to compare with). */
export function _pct(from: number, to: number): number {
  if (!Number.isFinite(from) || from === 0) return 0;
  return ((to - from) / Math.abs(from)) * 100;
}
