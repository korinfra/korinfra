/**
 * MCP tool: detect_cost_anomalies
 *
 * Runs z-score anomaly detection and linear-regression trend analysis on a
 * caller-supplied array of cost data points and returns a structured report.
 */

import { detectAnomalies, analyzeTrend } from '../anomaly/index.js';
import type { CostDataPoint, Anomaly } from '../anomaly/index.js';
import { jsonResult, errorResult } from './types.js';
import type { ToolDefinition } from './types.js';
import { redactObject } from '../redaction/index.js';
import { loadConfig } from '../config/index.js';

export const detectAnomalesTool: ToolDefinition = {
  name: 'detect_cost_anomalies',
  description: 'Detects unusual cost patterns and trends in daily cost data. Returns findings by severity and a forecast.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      costData: {
        type: 'array',
        description: 'Daily cost data: [{date: "YYYY-MM-DD", amount: number (USD), service?: string}]. Pass the costs array from get_costs directly.',
        maxItems: 3650,
        items: {
          type: 'object',
          properties: {
            date: { type: 'string' },
            amount: { type: 'number' },
            service: { type: 'string' },
          },
          required: ['date', 'amount'],
        },
      },
      windowSize: { type: 'number', description: 'Baseline window days. Default 14.' },
      minDataPoints: { type: 'number', description: 'Min points before detection. Default 7.' },
    },
    required: ['costData'],
  },
  handler: async (args) => {
    try {
      const cfg = await loadConfig().catch(() => null);
      const anomalyCfg = cfg?.anomaly;

      const rawData = (args['costData'] as CostDataPoint[] | null | undefined) ?? [];
      const rawWindow = args['windowSize'];
      const windowSize =
        typeof rawWindow === 'number' && Number.isFinite(rawWindow) && rawWindow > 0 && rawWindow <= 365
          ? Math.floor(rawWindow)
          : (anomalyCfg?.rolling_window_days ?? 14);

      const rawMinPoints = args['minDataPoints'];
      const minDataPoints =
        typeof rawMinPoints === 'number' && Number.isFinite(rawMinPoints) && rawMinPoints > 0
          ? Math.floor(rawMinPoints)
          : (anomalyCfg?.trend_min_data_points ?? 3);

      const validData = rawData.filter(
        (p): p is { date: string; amount: number; service?: string } =>
          typeof p.date === 'string' &&
          typeof p.amount === 'number' &&
          !isNaN(p.amount) &&
          p.amount >= 0,
      );
      const skipped = rawData.length - validData.length;

      const anomalies = detectAnomalies(validData, {
        windowSize,
        minDataPoints,
        ...(anomalyCfg && {
          zScoreThreshold: anomalyCfg.z_score_threshold,
          pctThreshold: anomalyCfg.pct_threshold,
          minCost: anomalyCfg.min_cost,
          criticalZScore: anomalyCfg.critical_z_score,
          highZScore: anomalyCfg.high_z_score,
          mediumZScore: anomalyCfg.medium_z_score,
        }),
      });

      const trend = analyzeTrend(validData);

      // Build bySeverity summary.
      const bySeverity: Record<string, number> = {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
      };
      for (const a of anomalies) {
        bySeverity[a.severity] = (bySeverity[a.severity] ?? 0) + 1;
      }

      const summary = {
        totalAnomalies: anomalies.length,
        bySeverity,
        direction: trend.direction,
      };

      const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      const cleanAnomalies = anomalies
        .sort((a, b) => (severityOrder[a.severity] ?? 4) - (severityOrder[b.severity] ?? 4))
        .slice(0, 10)
        .map((a: Anomaly) => ({
          date: a.date,
          amount: Math.round(a.amount * 100) / 100,
          zScore: Math.round(a.zScore * 10000) / 10000,
          severity: a.severity,
          direction: a.direction,
          expectedAmount: Math.round((a.expectedAmount ?? 0) * 100) / 100,
          deviation: Math.round(a.deviation * 100) / 100,
          ...(a.service !== undefined && { service: a.service }),
        }));

      // Trend with full regression details
      const slimTrend = {
        direction: trend.direction,
        slope: Math.round(trend.slope * 100) / 100,
        r2: Math.round(trend.r2 * 10000) / 10000,
        forecast30d: Math.round(trend.forecast30d * 100) / 100,
      };

      return jsonResult(redactObject({
        anomalies: cleanAnomalies,
        trend: slimTrend,
        summary,
        ...(skipped > 0 && { skipped }),
      }, 'moderate'));
    } catch (err) {
      return errorResult(err);
    }
  },
};
