/**
 * Shared numeric guards applied at the rule / pipeline boundary.
 * See GitHub issue #37 for the motivation.
 */

/** Clamps `v` to [0, 1]. NaN / ±Infinity / non-numbers collapse to 0. */
export function clampConfidence(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Returns a finite positive number, or null when the input is missing /
 * non-coercible / non-finite / ≤ 0. Accepts numbers and numeric strings only;
 * everything else (Symbol throws on Number() coercion; BigInt would coerce
 * with precision loss; objects coerce to NaN) is rejected up-front.
 */
export function guardCost(monthlyCost: unknown): number | null {
  const t = typeof monthlyCost;
  if (t !== 'number' && t !== 'string') return null;
  const n = t === 'number' ? (monthlyCost as number) : Number(monthlyCost);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Non-negative finite number suitable for `estimatedSavings`. Zero is
 * preserved (security-only rules legitimately emit 0). NaN / Infinity /
 * negative / non-numbers collapse to 0.
 */
export function guardSavings(savings: unknown): number {
  if (typeof savings !== 'number' || !Number.isFinite(savings)) return 0;
  if (savings < 0) return 0;
  return savings;
}

/**
 * True when the utilization struct has at least one data point with finite,
 * non-negative counters. Used to short-circuit before doing
 * dataPoints / (dataPoints + dataGaps) arithmetic.
 */
export function isValidUtilization(u: { dataPoints?: number; dataGaps?: number } | undefined): boolean {
  if (!u) return false;
  const dp = u.dataPoints;
  if (typeof dp !== 'number' || !Number.isFinite(dp) || dp <= 0) return false;
  const dg = u.dataGaps;
  if (dg !== undefined && (typeof dg !== 'number' || !Number.isFinite(dg) || dg < 0)) return false;
  return true;
}
