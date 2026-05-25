/**
 * Tests for period-string normalization via normalizeToMonth.
 *
 * Previously there were two separate parsePeriodDays implementations that could
 * diverge (pricing/engine.ts returned 0 for unknown formats; rules/cost/helpers.ts
 * returned 30). Both now use the shared implementation in src/utils/period.ts
 * which always returns 30 for unrecognized or zero/negative values, preventing
 * division-by-zero in cost calculations.
 *
 * These tests verify the safe fallback behaviour through the public
 * normalizeToMonth surface.
 */

import { describe, it, expect } from 'vitest';
import { normalizeToMonth } from '../../../src/rules/cost/helpers.js';

describe('normalizeToMonth — period string handling', () => {
  it('correctly normalizes standard 30d window', () => {
    // 3000 invocations over 30 days → 3000/mo
    expect(normalizeToMonth(3000, '30d')).toBeCloseTo(3000, 5);
  });

  it('correctly normalizes 7d window', () => {
    // 700 over 7d → 700 * (30/7) ≈ 3000/mo
    expect(normalizeToMonth(700, '7d')).toBeCloseTo(3000, 0);
  });

  it('correctly normalizes 14d window', () => {
    expect(normalizeToMonth(1400, '14d')).toBeCloseTo(3000, 0);
  });

  it('returns finite, positive result for unrecognized period (falls back to 30d)', () => {
    // Unknown format should NOT produce Infinity or NaN
    const result = normalizeToMonth(1000, '1w');
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
  });

  it('returns finite result for numeric-string period without "d" suffix', () => {
    // e.g. "30" (no 'd') — shared parsePeriodDays has no 'd' suffix → falls back to 30
    const result = normalizeToMonth(1000, '30');
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
  });

  it('never returns Infinity or NaN regardless of period string', () => {
    const badPeriods = ['0d', 'monthly', '', 'NaN', 'undefined', '-7d', '999w'];
    for (const p of badPeriods) {
      const result = normalizeToMonth(1000, p);
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
    }
  });

  it('handles zero count without producing NaN', () => {
    expect(normalizeToMonth(0, '30d')).toBe(0);
    expect(normalizeToMonth(0, '7d')).toBe(0);
  });
});
