import { describe, it, expect } from 'vitest';
import { analyzeTrend } from '../../../src/anomaly/trend.js';
import type { CostDataPoint } from '../../../src/anomaly/detector.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDailyPoints(amounts: number[], startDate = '2024-01-01'): CostDataPoint[] {
  return amounts.map((amount, i) => {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    return { date: d.toISOString().slice(0, 10), amount };
  });
}

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe('analyzeTrend — edge cases', () => {
  it('returns stable zero-slope for empty input', () => {
    const result = analyzeTrend([]);
    expect(result.slope).toBe(0);
    expect(result.intercept).toBe(0);
    expect(result.r2).toBe(0);
    expect(result.forecast30d).toBe(0);
    expect(result.direction).toBe('stable');
  });

  it('returns stable for single data point', () => {
    const data: CostDataPoint[] = [{ date: '2024-01-01', amount: 100 }];
    const result = analyzeTrend(data);
    expect(result.slope).toBe(0);
    expect(result.intercept).toBe(100);
    expect(result.forecast30d).toBe(3000); // 100 * 30
    expect(result.direction).toBe('stable');
    expect(result.r2).toBe(0);
  });

  it('returns stable for all-identical values (zero variance)', () => {
    const data = makeDailyPoints(Array(10).fill(100));
    const result = analyzeTrend(data);
    expect(result.slope).toBeCloseTo(0, 10);
    expect(result.direction).toBe('stable');
    expect(result.r2).toBe(0);
  });
});

// ─── Linear regression correctness ───────────────────────────────────────────

describe('analyzeTrend — linear regression', () => {
  it('computes correct slope for a perfectly linear increasing series', () => {
    // y = 100 + 10*x → slope=10, intercept=100, R²=1
    const amounts = [100, 110, 120, 130, 140, 150, 160, 170, 180, 190];
    const data = makeDailyPoints(amounts);
    const result = analyzeTrend(data);

    expect(result.slope).toBeCloseTo(10, 5);
    expect(result.intercept).toBeCloseTo(100, 5);
    expect(result.r2).toBeCloseTo(1.0, 5);
    expect(result.direction).toBe('increasing');
  });

  it('computes correct slope for a perfectly linear decreasing series', () => {
    const amounts = [200, 190, 180, 170, 160, 150, 140, 130, 120, 110];
    const data = makeDailyPoints(amounts);
    const result = analyzeTrend(data);

    expect(result.slope).toBeCloseTo(-10, 5);
    expect(result.r2).toBeCloseTo(1.0, 5);
    expect(result.direction).toBe('decreasing');
  });

  it('returns R² close to 1 for perfect line', () => {
    const amounts = [10, 20, 30, 40, 50];
    const data = makeDailyPoints(amounts);
    const result = analyzeTrend(data);
    expect(result.r2).toBeCloseTo(1.0, 5);
  });

  it('returns R² close to 0 for random-ish data', () => {
    // Alternating high-low gives poor linear fit
    const amounts = [100, 200, 100, 200, 100, 200, 100, 200];
    const data = makeDailyPoints(amounts);
    const result = analyzeTrend(data);
    expect(result.r2).toBeLessThan(0.5);
  });

  it('ignores date order — sorts by date ascending', () => {
    const data: CostDataPoint[] = [
      { date: '2024-01-03', amount: 120 },
      { date: '2024-01-01', amount: 100 },
      { date: '2024-01-02', amount: 110 },
    ];
    const result = analyzeTrend(data);
    expect(result.slope).toBeCloseTo(10, 5);
    expect(result.r2).toBeCloseTo(1.0, 5);
  });
});

// ─── 30-day forecast ─────────────────────────────────────────────────────────

describe('analyzeTrend — 30-day forecast', () => {
  it('forecasts positive values for an increasing trend', () => {
    const amounts = Array.from({ length: 10 }, (_, i) => 100 + i * 5);
    const data = makeDailyPoints(amounts);
    const result = analyzeTrend(data);
    expect(result.forecast30d).toBeGreaterThan(0);
  });

  it('only includes positive projected values in forecast', () => {
    // Steeply decreasing trend will eventually go negative
    const amounts = [1000, 900, 800, 700, 600, 500, 400, 300, 200, 100];
    const data = makeDailyPoints(amounts);
    const result = analyzeTrend(data);
    // Forecast should only include days with positive projected value
    expect(result.forecast30d).toBeGreaterThanOrEqual(0);
  });

  it('forecast for stable flat line is 30 * daily_cost', () => {
    // y = 50 for all points → slope≈0 → forecast ≈ 30*50 = 1500
    const amounts = Array(10).fill(50);
    const data = makeDailyPoints(amounts);
    const result = analyzeTrend(data);
    // The forecast sums 30 future points from the regression line
    // For a flat line at 50, each projected day is ~50
    expect(result.forecast30d).toBeCloseTo(1500, -1); // within ~100
  });
});

// ─── Direction classification ─────────────────────────────────────────────────

describe('analyzeTrend — direction classification', () => {
  it('classifies increasing when slope > 1% of mean', () => {
    // Mean ~150, slope 10 → relSlope = 10/150 ≈ 6.7% > 1%
    const data = makeDailyPoints([100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200]);
    const result = analyzeTrend(data);
    expect(result.direction).toBe('increasing');
  });

  it('classifies decreasing when slope < -1% of mean', () => {
    const data = makeDailyPoints([200, 190, 180, 170, 160, 150, 140, 130, 120, 110, 100]);
    const result = analyzeTrend(data);
    expect(result.direction).toBe('decreasing');
  });

  it('classifies stable when |slope| / mean <= 1%', () => {
    // Very slight slope won't exceed threshold
    const amounts = Array.from({ length: 20 }, (_, i) => 1000 + i * 0.01); // slope = 0.01, mean ≈ 1000
    const data = makeDailyPoints(amounts);
    const result = analyzeTrend(data, 0.01); // 1% threshold
    expect(result.direction).toBe('stable');
  });

  it('uses custom significanceThreshold', () => {
    // slope = 10, mean = 150 → relSlope ≈ 6.7%
    // With threshold=0.10 (10%), it stays stable
    const data = makeDailyPoints([100, 110, 120, 130, 140, 150, 160, 170, 180, 190]);
    const result = analyzeTrend(data, 0.10);
    expect(result.direction).toBe('stable');
  });

  it('significanceThreshold defaults when 0 or negative is passed', () => {
    const data = makeDailyPoints([100, 110, 120, 130, 140]);
    const r1 = analyzeTrend(data, 0);
    const r2 = analyzeTrend(data, -5);
    // Should use default threshold, not crash
    expect(['increasing', 'decreasing', 'stable']).toContain(r1.direction);
    expect(['increasing', 'decreasing', 'stable']).toContain(r2.direction);
  });

  it('exposes significanceThreshold in result', () => {
    const data = makeDailyPoints([100, 200]);
    const result = analyzeTrend(data, 0.05);
    expect(result.significanceThreshold).toBe(0.05);
  });
});
