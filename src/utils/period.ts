/**
 * Parses a period string like "30d", "7d" into a number of days.
 * Returns 30 for unrecognized or zero/negative values to avoid division-by-zero.
 */
export function parsePeriodDays(period: string): number {
  if (!period.endsWith('d')) return 30;
  const n = parseInt(period.slice(0, -1), 10);
  return isNaN(n) || n <= 0 ? 30 : n;
}
