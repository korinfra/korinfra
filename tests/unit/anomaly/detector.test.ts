import { describe, it, expect } from 'vitest';
import { detectAnomalies } from '../../../src/anomaly/detector.js';
import type { CostDataPoint } from '../../../src/anomaly/detector.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDataPoints(amounts: number[], startDate = '2024-01-01'): CostDataPoint[] {
  return amounts.map((amount, i) => {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    return { date: d.toISOString().slice(0, 10), amount };
  });
}

/** Builds 20 points at baseline then appends a spike/drop at the end. */
function withSpike(baseline: number, spikeValue: number): CostDataPoint[] {
  const pts = makeDataPoints(Array(20).fill(baseline));
  const nextDate = new Date('2024-01-21').toISOString().slice(0, 10);
  pts.push({ date: nextDate, amount: spikeValue });
  return pts;
}

// ─── Spike detection ──────────────────────────────────────────────────────────

describe('detectAnomalies — spike detection', () => {
  it('detects a clear cost spike', () => {
    // 20 days at $100, then one day at $500
    const data = withSpike(100, 500);
    const anomalies = detectAnomalies(data, { windowSize: 0, minDataPoints: 7 });
    expect(anomalies.length).toBeGreaterThan(0);
    const spike = anomalies.find((a) => a.direction === 'spike');
    expect(spike).toBeDefined();
  });

  it('sets direction=spike when amount > baseline', () => {
    const data = withSpike(100, 1000);
    const anomalies = detectAnomalies(data, { windowSize: 0, minDataPoints: 7 });
    const spike = anomalies.find((a) => a.amount === 1000);
    expect(spike).toBeDefined();
    expect(spike!.direction).toBe('spike');
    expect(spike!.deviation).toBeGreaterThan(0);
  });
});

// ─── Drop detection ───────────────────────────────────────────────────────────

describe('detectAnomalies — drop detection', () => {
  it('detects a clear cost drop', () => {
    // 20 days at $1000, then one day at $1
    // z-score ≈ 4.47, pctDev ≈ 99.9% — well above both thresholds
    const data = withSpike(1000, 1);
    const anomalies = detectAnomalies(data, { windowSize: 0, minDataPoints: 7 });
    const drop = anomalies.find((a) => a.direction === 'drop');
    expect(drop).toBeDefined();
    expect(drop!.direction).toBe('drop');
    expect(drop!.deviation).toBeLessThan(0);
  });
});

// ─── Severity tiers ───────────────────────────────────────────────────────────

describe('detectAnomalies — severity tiers', () => {
  it('assigns critical severity for very large spikes (z >= 4)', () => {
    // Very stable baseline, then massive spike — always detected and always critical
    const baseline = Array(30).fill(100);
    const data = makeDataPoints(baseline);
    data.push({ date: '2024-01-31', amount: 100000 }); // extreme z-score
    const anomalies = detectAnomalies(data, { windowSize: 0, minDataPoints: 7 });
    expect(anomalies.length).toBeGreaterThan(0);
    const critical = anomalies.find((a) => a.severity === 'critical');
    expect(critical).toBeDefined();
  });

  it('assigns correct severity based on z-score thresholds', () => {
    // 20 points at 100, spike at 800 → z≈4.44 → critical
    const data = withSpike(100, 800);
    const anomalies = detectAnomalies(data, {
      windowSize: 0,
      minDataPoints: 7,
      criticalZScore: 4.0,
      highZScore: 3.0,
      mediumZScore: 2.5,
    });
    expect(anomalies.length).toBeGreaterThan(0);
    expect(anomalies[0].severity).toBe('critical');
  });

  it('higher severity anomalies sort first (critical before medium)', () => {
    // Build a 40-point dataset with alternating 90/110 baseline (mean=100, stddev=10).
    // Spike 1 at idx 40: amount=50000 → z≈4990 → critical
    // Spike 2 at idx 55: amount=126 → z≈2.6 → medium (≥2.5 but <3.0)
    // Windows don't overlap (windowSize=10): window for idx 40 is [30..39], window for idx 55 is [45..54].
    // This guarantees a strict severity gap: critical (4) > medium (2).
    const cleanPts: CostDataPoint[] = Array.from({ length: 40 }, (_, i) => {
      const d = new Date('2024-01-01');
      d.setDate(d.getDate() + i);
      return { date: d.toISOString().slice(0, 10), amount: i % 2 === 0 ? 90 : 110 };
    });
    const d1 = new Date('2024-02-11'); // idx 40
    cleanPts.push({ date: d1.toISOString().slice(0, 10), amount: 50000 }); // critical
    // 14 stable points between spikes so spike2's window [45..54] is clean
    for (let i = 0; i < 14; i++) {
      const d = new Date(d1);
      d.setDate(d.getDate() + 1 + i);
      cleanPts.push({ date: d.toISOString().slice(0, 10), amount: i % 2 === 0 ? 90 : 110 });
    }
    const d2 = new Date('2024-03-01'); // idx 55
    cleanPts.push({ date: d2.toISOString().slice(0, 10), amount: 126 }); // z≈2.6 → medium
    const anomalies = detectAnomalies(cleanPts, { windowSize: 10, minDataPoints: 7 });
    expect(anomalies.length).toBeGreaterThanOrEqual(2);
    const first = anomalies[0]!;
    const second = anomalies[1]!;
    const severityOrder: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
    // Strict greater-than: critical (4) > medium (2) — not merely >=
    expect(severityOrder[first.severity]).toBeGreaterThan(severityOrder[second.severity]);
  });
});

// ─── Z-score math ─────────────────────────────────────────────────────────────

describe('detectAnomalies — z-score math', () => {
  it('returns correct expectedAmount (global mean including spike)', () => {
    const data = withSpike(100, 1000);
    const anomalies = detectAnomalies(data, { windowSize: 0, minDataPoints: 7 });
    // z≈4.47, pctDev≈600% — spike is always detected
    const spike = anomalies.find((a) => a.amount === 1000);
    expect(spike).toBeDefined();
    // With windowSize=0, expectedAmount is the global mean of all 21 points:
    // (20×100 + 1000) / 21 ≈ 142.86
    const expectedGlobalMean = (20 * 100 + 1000) / 21;
    expect(spike!.expectedAmount).toBeCloseTo(expectedGlobalMean, 1);
  });

  it('populates zScore, expectedAmount, deviation, date, service', () => {
    const data = withSpike(200, 10000);
    data[data.length - 1].service = 'EC2';
    const anomalies = detectAnomalies(data, { windowSize: 0, minDataPoints: 7 });
    // z≈4.47 — spike is always detected
    expect(anomalies.length).toBeGreaterThan(0);
    const a = anomalies[0];
    expect(a.zScore).toBeGreaterThan(0);
    expect(a.expectedAmount).toBeGreaterThan(0);
    expect(typeof a.deviation).toBe('number');
    expect(typeof a.date).toBe('string');
    expect(a.service).toBe('EC2');
  });

  it('respects custom zScoreThreshold', () => {
    // With threshold=10, essentially nothing gets flagged
    const data = withSpike(100, 500);
    const anomalies = detectAnomalies(data, { windowSize: 0, minDataPoints: 7, zScoreThreshold: 100 });
    expect(anomalies).toHaveLength(0);
  });

  it('respects custom pctThreshold', () => {
    // With pct threshold=500%, a 2x spike won't be flagged
    const data = withSpike(100, 200);
    const anomalies = detectAnomalies(data, { windowSize: 0, minDataPoints: 7, pctThreshold: 500 });
    expect(anomalies).toHaveLength(0);
  });
});

// ─── Rolling window ───────────────────────────────────────────────────────────

describe('detectAnomalies — rolling window', () => {
  it('uses rolling window baseline when windowSize > 0 and idx >= windowSize', () => {
    // Alternating 90/110 so stddev > 0 in every rolling window
    const amounts = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 90 : 110));
    const data = makeDataPoints(amounts);
    data.push({ date: '2024-01-21', amount: 5000 });
    const anomalies = detectAnomalies(data, { windowSize: 14, minDataPoints: 7 });
    // Should still detect the spike
    expect(anomalies.length).toBeGreaterThan(0);
    expect(anomalies[0]!.direction).toBe('spike');
  });
});
