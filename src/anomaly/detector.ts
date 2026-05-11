/**
 * Z-score anomaly detection for cost data.
 * Ported from Go internal/anomaly/detector.go.
 */

export interface CostDataPoint {
  date: string;
  amount: number;
  service?: string;
}

export interface Anomaly {
  date: string;
  amount: number;
  zScore: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  direction: 'spike' | 'drop';
  service?: string;
  expectedAmount: number;
  deviation: number;
}

export interface DetectorConfig {
  /** Window size in days for rolling baseline (default 14). */
  windowSize: number;
  /** Minimum data points required before detecting anomalies (default 7). */
  minDataPoints: number;
  /** Z-score threshold to flag an anomaly (default 2.0). */
  zScoreThreshold: number;
  /** Minimum % deviation to flag (default 20). */
  pctThreshold: number;
  /** Minimum cost value to consider (default 1.0). */
  minCost: number;
  /** Z-score for critical severity (default 4.0). */
  criticalZScore: number;
  /** Z-score for high severity (default 3.0). */
  highZScore: number;
  /** Z-score for medium severity (default 2.5). */
  mediumZScore: number;
}

const MIN_STATS_POINTS = 3; // minimum data points needed for valid mean/stddev

const DEFAULTS: DetectorConfig = {
  windowSize: 14,
  minDataPoints: 7,
  zScoreThreshold: 2.0,
  pctThreshold: 20.0,
  minCost: 1.0,
  criticalZScore: 4.0,
  highZScore: 3.0,
  mediumZScore: 2.5,
};

/** Compute mean and sample standard deviation. */
function meanStddev(vals: number[]): { mean: number; stddev: number } {
  if (vals.length === 0) return { mean: 0, stddev: 0 };
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  if (vals.length < 2) return { mean, stddev: 0 };
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / (vals.length - 1);
  return { mean, stddev: Math.sqrt(variance) };
}

function severityFromZScore(
  z: number,
  cfg: DetectorConfig,
): 'low' | 'medium' | 'high' | 'critical' {
  if (z >= cfg.criticalZScore) return 'critical';
  if (z >= cfg.highZScore) return 'high';
  if (z >= cfg.mediumZScore) return 'medium';
  return 'low';
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/**
 * Detect cost anomalies using a rolling z-score baseline.
 *
 * Data points are sorted by date before analysis. When a rolling window of
 * `windowSize` preceding points is available, it is used as the baseline;
 * otherwise the global mean/stddev for the dataset is used. Both spikes
 * (positive z-score) and drops (negative z-score) are detected.
 */
export function detectAnomalies(
  data: CostDataPoint[],
  config?: Partial<DetectorConfig>,
): Anomaly[] {
  if (data.length === 0) return [];

  const cfg: DetectorConfig = { ...DEFAULTS, ...config };

  // Sort by date ascending.
  const sorted = [...data].sort((a, b) => a.date.localeCompare(b.date));

  if (sorted.length < cfg.minDataPoints) return [];

  const amounts = sorted.map((p) => p.amount);
  // The global baseline window size (used for early points without enough history).
  const baselineEnd = cfg.windowSize > 0 ? Math.min(cfg.windowSize, amounts.length) : amounts.length;
  if (baselineEnd === 0) return [];

  const anomalies: Anomaly[] = [];

  for (let idx = 0; idx < sorted.length; idx++) {
    const point = sorted[idx];
    if (!point) continue;
    if (point.amount < cfg.minCost) continue;

    let baselineMean: number;
    let baselineStddev: number;

    if (cfg.windowSize > 0 && idx >= cfg.windowSize) {
      // Rolling window: use the windowSize points immediately before this one.
      // Apply minCost filter to match global baseline behaviour.
      const windowVals = amounts.slice(idx - cfg.windowSize, idx).filter((a) => a >= cfg.minCost);
      if (windowVals.length < MIN_STATS_POINTS) {
        // Not enough usable values in rolling window — fall back to global baseline for this point.
        const globalSlice = amounts.slice(0, idx).filter((a) => a >= cfg.minCost);
        if (globalSlice.length < MIN_STATS_POINTS) continue;
        const stats = meanStddev(globalSlice);
        baselineMean = stats.mean;
        baselineStddev = stats.stddev;
      } else {
        const stats = meanStddev(windowVals);
        baselineMean = stats.mean;
        baselineStddev = stats.stddev;
      }
    } else if (cfg.windowSize > 0 && idx < cfg.windowSize) {
      // Early points (idx < windowSize): use global baseline but exclude the
      // current point to avoid self-contamination.
      const baselineSlice = amounts
        .slice(0, baselineEnd)
        .filter((_, i) => i !== idx)
        .filter((a) => a >= cfg.minCost);
      if (baselineSlice.length < MIN_STATS_POINTS) continue; // not enough data to score
      const stats = meanStddev(baselineSlice);
      baselineMean = stats.mean;
      baselineStddev = stats.stddev;
    } else {
      // windowSize=0: use all points as global baseline (including the current
      // point). This matches the original behaviour expected by callers that
      // pass windowSize=0 to opt out of rolling-window logic.
      const baselineSlice = amounts.slice(0, baselineEnd).filter((a) => a >= cfg.minCost);
      if (baselineSlice.length < MIN_STATS_POINTS) continue;
      const stats = meanStddev(baselineSlice);
      baselineMean = stats.mean;
      baselineStddev = stats.stddev;
    }

    if (baselineMean < cfg.minCost) continue;
    if (baselineStddev === 0) continue;

    const signedZ = (point.amount - baselineMean) / baselineStddev;
    if (Math.abs(signedZ) < cfg.zScoreThreshold) continue;

    const pctDev = (Math.abs(point.amount - baselineMean) / baselineMean) * 100;
    if (pctDev < cfg.pctThreshold) continue;

    const anomaly: Anomaly = {
      date: point.date,
      amount: point.amount,
      zScore: signedZ,
      severity: severityFromZScore(Math.abs(signedZ), cfg),
      direction: point.amount >= baselineMean ? 'spike' : 'drop',
      expectedAmount: baselineMean,
      deviation: point.amount - baselineMean,
    };
    if (point.service) {
      anomaly.service = point.service;
    }
    anomalies.push(anomaly);
  }

  // Sort: highest severity first, then most recent date first.
  anomalies.sort((a, b) => {
    const so = (SEVERITY_ORDER[b.severity] ?? 1) - (SEVERITY_ORDER[a.severity] ?? 1);
    if (so !== 0) return so;
    return b.date.localeCompare(a.date);
  });

  return anomalies;
}
