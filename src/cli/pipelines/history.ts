/**
 * History pipeline — no-AI deterministic history display.
 *
 * Pure DB reads: list scans, show scan details, diff two scans.
 */

import type { PipelineStep, PipelineContext } from '../components/DirectPipeline.js';
import { DOT_SEP } from '../ui/text.js';
import { asStr } from '../../utils/coerce.js';
import { getDb } from '../../storage/db.js';
import { listScans, getScan } from '../../storage/queries/scans.js';
import { listResources } from '../../storage/queries/resources.js';
import { listCosts } from '../../storage/queries/costs.js';
import { listRecommendations } from '../../storage/queries/recommendations.js';

export type HistorySubcommand = 'list' | 'show' | 'diff';

interface HistoryPipelineOptions {
  subcommand: HistorySubcommand;
  id1?: string | null;
  id2?: string | null;
}

export function buildHistoryPipelineSteps(opts: HistoryPipelineOptions): PipelineStep[] {
  switch (opts.subcommand) {
    case 'list':
      return [
        {
          name: 'Loading scan history',
          completedName: 'Loaded scan history',
          key: 'scans',
          getDetail: (result) => {
            const r = result as { scans?: unknown[] } | null | undefined;
            const count = r?.scans?.length ?? 0;
            return `${count} scan${count !== 1 ? 's' : ''}`;
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- implements PipelineStep.run: () => Promise<unknown>
          run: async () => {
            const db = getDb();
            const scans = listScans(db, 50);
            return { scans };
          },
        },
      ];

    case 'show':
      return [
        {
          name: `Loading scan ${opts.id1 ?? ''}`,
          completedName: `Loaded scan ${opts.id1 ?? ''}`,
          key: 'scan_detail',
          getDetail: (result) => {
            const r = result as { resources?: unknown[]; recommendations?: unknown[] } | null | undefined;
            const resources = r?.resources?.length ?? 0;
            const recs = r?.recommendations?.length ?? 0;
            return `${resources} resources${DOT_SEP}${recs} recommendations`;
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- implements PipelineStep.run: () => Promise<unknown>
          run: async () => {
            if (!opts.id1) throw new Error('Scan ID is required');
            const db = getDb();
            const scan = getScan(db, opts.id1);
            if (!scan) throw new Error(`Scan "${opts.id1}" not found`);
            const resources = listResources(db, opts.id1);
            const costs = listCosts(db, opts.id1);
            const recommendations = listRecommendations(db, opts.id1);
            return { scan, resources, costs, recommendations };
          },
        },
      ];

    case 'diff':
      return [
        {
          name: `Loading scan ${opts.id1 ?? ''}`,
          completedName: `Loaded scan ${opts.id1 ?? ''}`,
          key: 'scan_a',
          getDetail: (result) => {
            const r = result as { resources?: unknown[] } | null | undefined;
            const count = r?.resources?.length ?? 0;
            return `${count} resources`;
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- implements PipelineStep.run: () => Promise<unknown>
          run: async () => {
            if (!opts.id1) throw new Error('First scan ID is required');
            const db = getDb();
            const scan = getScan(db, opts.id1);
            if (!scan) throw new Error(`Scan "${opts.id1}" not found`);
            const resources = listResources(db, opts.id1);
            const costs = listCosts(db, opts.id1);
            return { scan, resources, costs };
          },
        },
        {
          name: `Loading scan ${opts.id2 ?? ''}`,
          completedName: `Loaded scan ${opts.id2 ?? ''}`,
          key: 'scan_b',
          getDetail: (result) => {
            const r = result as { resources?: unknown[] } | null | undefined;
            const count = r?.resources?.length ?? 0;
            return `${count} resources`;
          },
          // eslint-disable-next-line @typescript-eslint/require-await -- implements PipelineStep.run: () => Promise<unknown>
          run: async () => {
            if (!opts.id2) throw new Error('Second scan ID is required');
            const db = getDb();
            const scan = getScan(db, opts.id2);
            if (!scan) throw new Error(`Scan "${opts.id2}" not found`);
            const resources = listResources(db, opts.id2);
            const costs = listCosts(db, opts.id2);
            return { scan, resources, costs };
          },
        },
      ];
  }
}

interface ScanListRow {
  id: string;
  date: string;
  resourceCount: number;
  totalCost: number;
  recommendationCount: number;
}

/** Extract scan list from pipeline context. */
export function extractScanList(ctx: PipelineContext): ScanListRow[] {
  const result = ctx.results.get('scans') as {
    scans?: Array<Record<string, unknown>>;
  } | undefined;
  const scans = result?.scans ?? [];

  return scans.map((s) => ({
    id: asStr(s['id']),
    date: asStr(s['started_at']) || asStr(s['created_at']),
    resourceCount: typeof s['total_resources'] === 'number' ? s['total_resources'] : (typeof s['resource_count'] === 'number' ? s['resource_count'] : 0),
    totalCost: typeof s['total_cost'] === 'number' ? s['total_cost'] : 0,
    recommendationCount: typeof s['total_recommendations'] === 'number' ? s['total_recommendations'] : (typeof s['recommendation_count'] === 'number' ? s['recommendation_count'] : 0),
  }));
}

/** Extract scan detail from pipeline context. */
export function extractScanDetail(ctx: PipelineContext): {
  scan: Record<string, unknown>;
  resources: unknown[];
  costs: unknown[];
  recommendations: unknown[];
} {
  const result = ctx.results.get('scan_detail') as {
    scan: Record<string, unknown>;
    resources: unknown[];
    costs: unknown[];
    recommendations: unknown[];
  } | undefined;

  return {
    scan: result?.scan ?? {},
    resources: result?.resources ?? [],
    costs: result?.costs ?? [],
    recommendations: result?.recommendations ?? [],
  };
}

/** Extract diff data from pipeline context. */
export function extractScanDiff(ctx: PipelineContext): {
  scanA: Record<string, unknown>;
  scanB: Record<string, unknown>;
  resourceCountDelta: number;
  costDelta: number;
} {
  const a = ctx.results.get('scan_a') as {
    scan: Record<string, unknown>;
    resources: unknown[];
    costs: Array<{ amount?: number }>;
  } | undefined;
  const b = ctx.results.get('scan_b') as {
    scan: Record<string, unknown>;
    resources: unknown[];
    costs: Array<{ amount?: number }>;
  } | undefined;

  const costA = (a?.costs ?? []).reduce((sum, c) => sum + (c.amount ?? 0), 0);
  const costB = (b?.costs ?? []).reduce((sum, c) => sum + (c.amount ?? 0), 0);

  return {
    scanA: a?.scan ?? {},
    scanB: b?.scan ?? {},
    resourceCountDelta: (b?.resources?.length ?? 0) - (a?.resources?.length ?? 0),
    costDelta: costB - costA,
  };
}
