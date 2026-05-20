/**
 * Shared aggregation utilities for output formatters.
 */

/**
 * Groups items by a string key and sums a numeric value.
 */
export function groupBySum<T>(
  items: T[],
  keyFn: (item: T) => string,
  valueFn: (item: T) => number,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const item of items) {
    const key = keyFn(item);
    m.set(key, (m.get(key) ?? 0) + valueFn(item));
  }
  return m;
}

/**
 * Aggregates daily costs by date string (YYYY-MM-DD prefix).
 * `items` must have a `costDate` string and `dailyCost` number field.
 */
export function aggregateDailyCosts(
  items: Array<{ costDate: string; dailyCost: number }>,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of items) {
    const d = c.costDate.slice(0, 10);
    m.set(d, (m.get(d) ?? 0) + c.dailyCost);
  }
  return m;
}

/**
 * Calculates savings as a percentage of total spend.
 * Returns '0' when total is 0 to avoid division by zero.
 */
export function calcSavingsPct(savings: number, total: number, decimals = 1): string {
  return total > 0 ? (savings / total * 100).toFixed(decimals) : '0';
}
