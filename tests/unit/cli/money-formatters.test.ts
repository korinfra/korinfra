/**
 * Tests for money formatters in src/cli/ui/format.ts.
 * Finding 104: split compact vs exact formatters.
 * Finding 103: timestamps show timezone.
 */

import { describe, it, expect } from 'vitest';
import {
  formatMoney,
  formatMoneyExact,
  formatMoneyPerMonth,
  formatMoneyPerMonthExact,
  formatTimestamp,
} from '../../../src/cli/ui/format.js';

describe('formatMoney (compact)', () => {
  it('formats zero as $0', () => {
    expect(formatMoney(0)).toBe('$0');
  });

  it('formats sub-penny as <$0.01', () => {
    expect(formatMoney(0.001)).toBe('<$0.01');
  });

  it('formats cents correctly', () => {
    expect(formatMoney(0.05)).toBe('$0.05');
  });

  it('formats whole dollars', () => {
    expect(formatMoney(42)).toBe('$42');
    expect(formatMoney(999)).toBe('$999');
  });

  it('abbreviates thousands with k suffix', () => {
    expect(formatMoney(1000)).toBe('$1.0k');
    expect(formatMoney(1204.42)).toBe('$1.2k');
  });

  it('abbreviates millions with M suffix', () => {
    expect(formatMoney(1_500_000)).toBe('$1.5M');
  });

  it('negative returns $0', () => {
    expect(formatMoney(-10)).toBe('$0');
  });
});

describe('formatMoneyExact', () => {
  it('formats exact value with two decimal places', () => {
    expect(formatMoneyExact(1204.42)).toBe('$1,204.42');
  });

  it('formats small values with cents', () => {
    expect(formatMoneyExact(0.05)).toBe('$0.05');
  });

  it('formats zero correctly', () => {
    expect(formatMoneyExact(0)).toBe('$0.00');
  });

  it('formats large values with commas', () => {
    expect(formatMoneyExact(1_500_000)).toBe('$1,500,000.00');
  });

  it('rounds to two decimal places', () => {
    expect(formatMoneyExact(1.999)).toBe('$2.00');
  });
});

describe('formatMoneyPerMonth', () => {
  it('appends /mo to compact format', () => {
    expect(formatMoneyPerMonth(1204.42)).toBe('$1.2k/mo');
    expect(formatMoneyPerMonth(0)).toBe('$0/mo');
  });
});

describe('formatMoneyPerMonthExact', () => {
  it('appends /mo to exact format', () => {
    expect(formatMoneyPerMonthExact(1204.42)).toBe('$1,204.42/mo');
    expect(formatMoneyPerMonthExact(0)).toBe('$0.00/mo');
  });
});

describe('formatTimestamp (with timezone)', () => {
  it('returns a non-empty string for a valid ISO date', () => {
    const result = formatTimestamp('2026-04-14T09:30:00Z');
    expect(result).toBeTruthy();
    expect(result).toContain('2026-04-14');
  });

  it('includes a timezone indicator', () => {
    const result = formatTimestamp('2026-04-14T09:30:00Z');
    // Default UTC format: "YYYY-MM-DD HH:MMZ" — ends with "Z"
    // Local format appends TZ abbreviation (e.g. " EST") or UTC offset (e.g. " UTC+05:30")
    const hasTimezone =
      result.endsWith('Z') ||
      result.includes('UTC') ||
      /[+-]\d{2}:\d{2}/.test(result) ||
      /\s[A-Z]{2,5}$/.test(result);
    expect(hasTimezone).toBe(true);
  });

  it('returns original string for invalid date', () => {
    const result = formatTimestamp('not-a-date');
    expect(result).toBe('not-a-date');
  });

  it('handles numeric timestamps (ms since epoch)', () => {
    const ts = new Date('2026-04-14T09:30:00Z').getTime();
    const result = formatTimestamp(ts);
    expect(result).toContain('2026-04-14');
  });
});
