/**
 * Costs pipeline — no-AI deterministic cost analysis.
 *
 * Dataset steps: get_costs (daily) → detect_anomalies  [days-only, no groupBy]
 * View step: get_costs (by groupBy)  [per (days, groupBy) pair, cached in CostsCommand]
 *
 * buildCostsDatasetSteps — used by TUI HybridPipeline (re-runs only when days changes)
 * buildCostsPipelineSteps — headless/legacy callers (unchanged signature, includes grouped fetch)
 */

import type { PipelineStep, PipelineContext } from '../components/DirectPipeline.js';
import { parseToolResult } from './scan.js';
import { getCostsTool } from '../../tools/get-costs.js';
import { detectAnomalesTool } from '../../tools/detect-anomalies.js';

interface CostsPipelineOptions {
  days?: number;
  startDate?: string;
  endDate?: string;
  groupBy?: 'service' | 'region' | 'account' | 'tag';
}

/**
 * Dataset-only steps — daily costs + anomaly detection.
 * Does NOT include grouped_costs; that fetch is managed by CostsCommand per groupBy.
 * Used by TUI HybridPipeline so AI does not re-run on groupBy changes.
 *
 * When startDate/endDate are provided (current month mode), daily_costs covers the
 * visible period only. A separate anomaly_daily step always fetches 30 rolling days
 * so the Z-score baseline has enough data points regardless of how far into the month we are.
 */
export function buildCostsDatasetSteps(opts: Pick<CostsPipelineOptions, 'days' | 'startDate' | 'endDate'> = {}): PipelineStep[] {
  const days = opts.days ?? 30;
  const startDate = opts.startDate;
  const endDate = opts.endDate;
  const periodArgs = startDate !== undefined ? { startDate, endDate } : { days };

  return [
    {
      name: 'Fetching daily cost data',
      completedName: 'Fetched daily cost data',
      key: 'daily_costs',
      getDetail: (result) => {
        const r = result as { costs?: unknown[] } | null | undefined;
        const count = r?.costs?.length ?? 0;
        return `${count} days`;
      },
      run: async () => {
        const result = await getCostsTool.handler({ ...periodArgs, granularity: 'DAILY' });
        return parseToolResult(result);
      },
    },
    {
      name: 'Fetching service cost breakdown',
      completedName: 'Fetched service cost breakdown',
      key: 'grouped_costs',
      getDetail: (result) => {
        const r = result as { costs?: unknown[] } | null | undefined;
        const count = r?.costs?.length ?? 0;
        return `${count} services`;
      },
      run: async () => {
        const result = await getCostsTool.handler({ ...periodArgs, granularity: 'MONTHLY', groupBy: 'SERVICE' });
        return parseToolResult(result);
      },
    },
    {
      name: 'Fetching anomaly baseline',
      completedName: 'Fetched anomaly baseline',
      key: 'anomaly_daily',
      getDetail: (result) => {
        const r = result as { costs?: unknown[] } | null | undefined;
        const count = r?.costs?.length ?? 0;
        return `${count} days`;
      },
      run: async () => {
        const result = await getCostsTool.handler({ days: 30, granularity: 'DAILY' });
        return parseToolResult(result);
      },
    },
    {
      name: 'Detecting cost anomalies',
      completedName: 'Detected cost anomalies',
      key: 'anomalies',
      getDetail: (result) => {
        const r = result as { anomalies?: unknown[] } | null | undefined;
        const count = r?.anomalies?.length ?? 0;
        return count > 0 ? `${count} spike${count !== 1 ? 's' : ''}` : 'none';
      },
      run: async (ctx: PipelineContext) => {
        const dailyResult = ctx.results.get('anomaly_daily') as { costs?: unknown[] } | undefined;
        const costData = dailyResult?.costs ?? [];
        const result = await detectAnomalesTool.handler({ costData });
        return parseToolResult(result);
      },
    },
  ];
}

/**
 * Full pipeline including grouped costs — used by headless mode and legacy callers.
 * Preserved unchanged so external callers are unaffected.
 */
export function buildCostsPipelineSteps(opts: CostsPipelineOptions = {}): PipelineStep[] {
  const days = opts.days ?? 30;
  const groupBy = opts.groupBy ?? 'service';
  const startDate = opts.startDate;
  const endDate = opts.endDate;
  const periodArgs = startDate !== undefined ? { startDate, endDate } : { days };

  return [
    {
      name: 'Fetching daily cost data',
      completedName: 'Fetched daily cost data',
      key: 'daily_costs',
      getDetail: (result) => {
        const r = result as { costs?: unknown[] } | null | undefined;
        const count = r?.costs?.length ?? 0;
        return `${count} days`;
      },
      run: async () => {
        const result = await getCostsTool.handler({ ...periodArgs, granularity: 'DAILY' });
        return parseToolResult(result);
      },
    },
    {
      name: `Fetching costs by ${groupBy}`,
      completedName: `Fetched costs by ${groupBy}`,
      key: 'grouped_costs',
      getDetail: (result) => {
        const r = result as { costs?: unknown[] } | null | undefined;
        const count = r?.costs?.length ?? 0;
        return `${count} services`;
      },
      run: async () => {
        const result = await getCostsTool.handler({ ...periodArgs, granularity: 'MONTHLY', groupBy: groupBy.toUpperCase() });
        return parseToolResult(result);
      },
    },
    {
      name: 'Detecting cost anomalies',
      completedName: 'Detected cost anomalies',
      key: 'anomalies',
      getDetail: (result) => {
        const r = result as { anomalies?: unknown[] } | null | undefined;
        const count = r?.anomalies?.length ?? 0;
        return count > 0 ? `${count} spike${count !== 1 ? 's' : ''}` : 'none';
      },
      run: async (ctx: PipelineContext) => {
        const dailyResult = ctx.results.get('daily_costs') as { costs?: unknown[] } | undefined;
        const costData = dailyResult?.costs ?? [];
        const result = await detectAnomalesTool.handler({ costData });
        return parseToolResult(result);
      },
    },
  ];
}

/** Extract chart data points from grouped costs pipeline context. */
export function extractCostChartData(ctx: PipelineContext): Array<{ label: string; value: number }> {
  const grouped = ctx.results.get('grouped_costs') as {
    costs?: Array<{ service?: string; region?: string; account?: string; tag?: string; amount?: number }>;
  } | undefined;
  const costs = grouped?.costs ?? [];

  return costs
    .map((c) => ({
      label: String(c.service ?? c.region ?? c.account ?? c.tag ?? 'unknown'),
      // Refunds and EDP credits are valid negative entries but should not
      // surface in the "top services" chart — `.filter(value > 0)` below drops them.
      value: typeof c.amount === 'number' && Number.isFinite(c.amount) ? c.amount : 0,
    }))
    .filter((p) => p.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 15);
}

/** Extract anomaly summary from pipeline context. */
export function extractAnomalies(ctx: PipelineContext): {
  anomalyCount: number;
  anomalies: Array<{ service: string; date: string; amount: number; expected: number }>;
} {
  const result = ctx.results.get('anomalies') as {
    anomalyCount?: number;
    anomalies?: Array<{ service?: string; date?: string; amount?: number; expected?: number }>;
  } | undefined;

  return {
    anomalyCount: result?.anomalyCount ?? 0,
    anomalies: (result?.anomalies ?? []).map((a) => ({
      service: String(a.service ?? 'unknown'),
      date: String(a.date ?? ''),
      amount: typeof a.amount === 'number' ? a.amount : 0,
      expected: typeof a.expected === 'number' ? a.expected : 0,
    })),
  };
}

/** Extract total cost from daily data. */
export function extractTotalCost(ctx: PipelineContext): number {
  const grouped = ctx.results.get('grouped_costs') as {
    totalCost?: number;
    costs?: Array<{ amount?: number }>;
  } | undefined;

  if (typeof grouped?.totalCost === 'number' && Number.isFinite(grouped.totalCost)) return grouped.totalCost;
  const costs = grouped?.costs ?? [];
  const total = costs.reduce(
    (sum, c) => sum + (typeof c.amount === 'number' && Number.isFinite(c.amount) ? c.amount : 0),
    0,
  );
  return Number.isFinite(total) ? total : 0;
}
