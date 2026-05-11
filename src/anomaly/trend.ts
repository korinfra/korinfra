/**
 * Linear regression and cost trend forecasting.
 * Ported from Go internal/anomaly/trend.go.
 */

import type { CostDataPoint } from './detector.js';

export interface TrendResult {
  /** Slope of the regression line ($/day). */
  slope: number;
  /** Y-intercept of the regression line. */
  intercept: number;
  /** Coefficient of determination (0–1). */
  r2: number;
  /** Projected total cost over the next 30 days. */
  forecast30d: number;
  /** Trend direction. */
  direction: 'increasing' | 'decreasing' | 'stable';
  /**
   * Relative-slope threshold used to classify the trend as non-stable.
   * A trend is non-stable when |slope| / mean > this value.
   */
  significanceThreshold: number;
}

/** Default relative-slope significance threshold (matches Go source). */
const DEFAULT_SIGNIFICANCE_THRESHOLD = 0.01;

/**
 * Compute slope, intercept, and R² for a set of (x, y) points using
 * the ordinary least-squares method.
 */
function linearRegression(
  xs: number[],
  ys: number[],
): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: n === 1 ? (ys[0] ?? 0) : 0, r2: 0 };

  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumXX = 0;
  for (let i = 0; i < n; i++) {
    const xi = xs[i] ?? 0; // Loop bound i < n guarantees element existence
    const yi = ys[i] ?? 0;
    sumX += xi;
    sumY += yi;
    sumXY += xi * yi;
    sumXX += xi * xi;
  }

  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) {
    return { slope: 0, intercept: sumY / n, r2: 0 };
  }

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // R² = 1 − SS_res / SS_tot
  const meanY = sumY / n;
  let ssTot = 0,
    ssRes = 0;
  for (let i = 0; i < n; i++) {
    const xi = xs[i] ?? 0; // Loop bound i < n guarantees element existence
    const yi = ys[i] ?? 0;
    const pred = slope * xi + intercept;
    ssRes += (yi - pred) ** 2;
    ssTot += (yi - meanY) ** 2;
  }

  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { slope, intercept, r2 };
}

/**
 * Analyse the cost trend in `data` using linear regression.
 *
 * Requires at least 2 data points; returns a stable zero-slope result for
 * degenerate inputs (empty, single point, all-identical values).
 *
 * @param data               Array of cost data points (order doesn't matter).
 * @param significanceThreshold  Relative-slope threshold for stable/non-stable
 *                               classification. Defaults to 0.01 (1 %).
 */
export function analyzeTrend(
  data: CostDataPoint[],
  significanceThreshold = DEFAULT_SIGNIFICANCE_THRESHOLD,
): TrendResult {
  const threshold = significanceThreshold > 0 ? significanceThreshold : DEFAULT_SIGNIFICANCE_THRESHOLD;

  if (data.length < 2) {
    return {
      slope: 0,
      intercept: data.length === 1 ? (data[0]?.amount ?? 0) : 0,
      r2: 0,
      forecast30d: data.length === 1 ? ((data[0]?.amount ?? 0) * 30) : 0,
      direction: 'stable',
      significanceThreshold: threshold,
    };
  }

  // Sort by date ascending, then express x as day-offset from the first date
  // so that slope is truly $/day regardless of gaps between data points.
  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));
  const first = sorted[0];
  if (!first) {
    return { slope: 0, intercept: 0, r2: 0, forecast30d: 0, direction: 'stable', significanceThreshold: threshold };
  }
  const baseDate = new Date(first.date).getTime();
  const xs = sorted.map((p) => (new Date(p.date).getTime() - baseDate) / (24 * 60 * 60 * 1000));
  const ys = sorted.map((p) => p.amount);

  const { slope, intercept, r2 } = linearRegression(xs, ys);

  // Direction: non-stable when |slope| / mean > threshold
  const mean = ys.reduce((s, v) => s + v, 0) / ys.length;
  let direction: 'increasing' | 'decreasing' | 'stable' = 'stable';
  if (mean > 0) {
    const relSlope = Math.abs(slope) / mean;
    if (relSlope > threshold) {
      direction = slope > 0 ? 'increasing' : 'decreasing';
    }
  }

  // 30-day forecast: sum projected values for the next 30 days from the last point.
  const lastIdx = xs[xs.length - 1] ?? 0;
  let forecast30d = 0;
  for (let day = 1; day <= 30; day++) {
    const v = intercept + slope * (lastIdx + day);
    if (v > 0) forecast30d += v;
  }

  return { slope, intercept, r2, forecast30d, direction, significanceThreshold: threshold };
}
