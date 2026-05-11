/**
 * Shared helpers for cost rule evaluation.
 * Ported from Go internal/ai/rules.go utility functions.
 */

import type { Resource } from '../../aws/types.js';

/** Parse "7d" → 7, "14d" → 14, "30d" → 30. Returns 30 for unrecognized formats. */
function parsePeriodDays(period: string): number {
  const known: Record<string, number> = { '7d': 7, '14d': 14, '30d': 30 };
  if (period in known) return known[period] ?? 30;
  // Fallback: parse numeric prefix (e.g. "1d" → 1) for backward compatibility
  const n = parseInt(period, 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

/** Normalize a raw metric count to a monthly rate using the collection period. */
export function normalizeToMonth(rawCount: number, period: string): number {
  const days = parsePeriodDays(period);
  return rawCount * (30 / days);
}

/** Ordered list of instance sizes from smallest to largest. */
export const instanceSizeOrder = [
  'nano',
  'micro',
  'small',
  'medium',
  'large',
  'xlarge',
  '2xlarge',
  '4xlarge',
  '8xlarge',
  '12xlarge',
  '16xlarge',
  '24xlarge',
  '32xlarge',
  '48xlarge',
] as const;

/** Previous-generation EC2 families with their current-gen replacements (April 2026). */
export const previousGenFamilies: Record<string, string> = {
  // Very old → m5/c5/r5
  m1: 'm5', m2: 'm5', m3: 'm5', m4: 'm5',
  c1: 'c5', c3: 'c5', c4: 'c5',
  r3: 'r5', r4: 'r5',
  t1: 't3',
  i2: 'i3en',
  // m5/c5/r5 generation → 6i
  m5: 'm6i', m5a: 'm6a', m5n: 'm6in', m5zn: 'm6in',
  c5: 'c6i', c5a: 'c6a', c5n: 'c6in',
  r5: 'r6i', r5a: 'r6a', r5b: 'r6i', r5n: 'r6in',
  // 6th gen → 7th gen (current gen as of 2026)
  m6i: 'm7i', m6a: 'm7a',
  c6i: 'c7i', c6a: 'c7a',
  r6i: 'r7i', r6a: 'r7a',
  // Storage optimized
  i3: 'i4i', i3en: 'i4i',
  d2: 'd3',
};

/** x86 EC2 families mapped to their Graviton equivalents (April 2026). */
export const gravitonFamilies: Record<string, string> = {
  // 5th gen x86 → Graviton 2
  m5: 'm6g', c5: 'c6g', r5: 'r6g',
  // 6th gen x86 → Graviton 3
  m6i: 'm7g', c6i: 'c7g', r6i: 'r7g',
  // 6th gen AMD → Graviton 3
  m6a: 'm7g', c6a: 'c7g', r6a: 'r7g',
  // 7th gen x86 → Graviton 4
  m7i: 'm8g', c7i: 'c8g', r7i: 'r8g',
  // 7th gen AMD → Graviton 4
  m7a: 'm8g', c7a: 'c8g',
  // Burstable
  t2: 't4g', t3: 't4g', t3a: 't4g',
};

/** Splits "m5.2xlarge" into ["m5", "2xlarge"]. */
export function splitInstanceType(it: string): [string, string] {
  const idx = it.indexOf('.');
  if (idx === -1) return [it, ''];
  return [it.slice(0, idx), it.slice(idx + 1)];
}

/** Returns the index of size in instanceSizeOrder, or -1. */
export function sizeIndex(size: string): number {
  return instanceSizeOrder.indexOf(size as (typeof instanceSizeOrder)[number]);
}

/** Returns a suggested (smaller) instance type based on CPU P95 utilization. */
export function suggestRightsize(currentType: string, cpuP95: number, rightsizeThreshold: number): string {
  const [family, size] = splitInstanceType(currentType);
  if (size === 'metal') return currentType;
  const idx = sizeIndex(size);
  if (idx <= 0) return currentType;
  const drop = cpuP95 < rightsizeThreshold / 2 ? 2 : 1;
  const newIdx = Math.max(idx - drop, 0);
  return family + '.' + instanceSizeOrder[newIdx];
}

/** Handles RDS instance classes like "db.m5.large". */
export function suggestRDSRightsize(currentClass: string, cpuP95: number, rightsizeThreshold: number): string {
  return suggestPrefixedRightsize(currentClass, 'db.', cpuP95, rightsizeThreshold);
}

/** Handles ElastiCache node types like "cache.r5.large". */
export function suggestCacheRightsize(currentType: string, metric: number, rightsizeThreshold: number): string {
  return suggestPrefixedRightsize(currentType, 'cache.', metric, rightsizeThreshold);
}

function suggestPrefixedRightsize(
  currentType: string,
  prefix: string,
  metric: number,
  rightsizeThreshold: number,
): string {
  if (!currentType.startsWith(prefix)) {
    return suggestRightsize(currentType, metric, rightsizeThreshold);
  }
  const inner = currentType.slice(prefix.length);
  const suggested = suggestRightsize(inner, metric, rightsizeThreshold);
  if (suggested === inner) return currentType;
  return prefix + suggested;
}

/** Returns true if the instance type belongs to a previous-gen family. */
export function isPreviousGen(instanceType: string): boolean {
  if (!instanceType) return false;
  const [family] = splitInstanceType(instanceType);
  return family in previousGenFamilies;
}

/** Returns days between ISO date string and now, or null for empty/invalid dates. */
export function daysSince(dateStr: string): number | null {
  if (!dateStr) return null;
  if (!/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

/** Reads a string from resource.configuration. */
export function strConfig(r: Resource, key: string): string {
  const v = r.configuration?.[key];
  if (typeof v === 'string') return v;
  return '';
}

/** Reads a boolean from resource.configuration. */
export function boolConfig(r: Resource, key: string): boolean {
  const v = r.configuration?.[key];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.toLowerCase() === 'true';
  return false;
}

/** Reads a number from resource.configuration. */
export function numConfig(r: Resource, key: string): number {
  const v = r.configuration?.[key];
  if (typeof v === 'number') return v;
  return 0;
}

/** Reads monthlyCost from resource.configuration with a safe fallback to 0. */
export function getMonthlyCost(r: Resource): number {
  const v = r.configuration?.['monthlyCost'];
  return typeof v === 'number' ? v : 0;
}

/**
 * Sanitizes a resource name/id for safe interpolation into patchContent and
 * implementationSteps strings, preventing prompt injection.
 * Strips control characters, newlines, null bytes, and backticks.
 * Truncates to 200 characters.
 */
export function sanitizeResourceName(value: string | undefined | null): string {
  if (!value) return '';
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/[\n\r\x00`]/g, '')
    .slice(0, 200);
}

/**
 * Adjusts base confidence by utilization data quality.
 * Penalizes sparse data, coverage gaps, and stale metrics.
 * Rewards high-coverage 30-day observation windows.
 */
export function confidenceFromUtilization(
  base: number,
  util: Resource['utilization'],
): number {
  if (!util) return base;
  if (util.dataPoints === 0) return Math.min(base, 0.45);

  const total = util.dataPoints + util.dataGaps;
  const coverageRatio = total > 0 ? util.dataPoints / total : 1;
  if (coverageRatio < 0.50) return Math.min(base, 0.55);
  if (coverageRatio < 0.75) return Math.min(base, 0.70);

  if (util.dataPoints < 30) return Math.min(base, 0.60);

  if (util.freshnessHrs > 48) return Math.min(base, base * 0.80);

  if (util.period === '30d' && coverageRatio > 0.90) return Math.min(1.0, base * 1.05);

  if (util.period === '7d') return Math.min(base, base * 0.90);

  return base;
}

/** Checks if resource has all required tags. */
export function missingRequiredTags(r: Resource, required: readonly string[]): string[] {
  if (!r.tags) return [...required];
  const missing: string[] = [];
  for (const k of required) {
    if (!(k in r.tags)) missing.push(k);
  }
  return missing;
}
