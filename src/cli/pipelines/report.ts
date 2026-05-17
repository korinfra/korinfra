/**
 * Report pipeline — no-AI deterministic report generation.
 *
 * Steps: read last scan from DB → export to format (JSON/CSV/HTML)
 */

import path from 'node:path';
import type { PipelineStep, PipelineContext } from '../components/DirectPipeline.js';
import type { ScanReport } from '../../output/formatter.js';
import { createFormatter } from '../../output/formatter.js';
import { getDb } from '../../storage/db.js';
import { DOT_SEP } from '../ui/text.js';
import { asStr } from '../../utils/coerce.js';
import { safeWriteFile } from '../../utils/safe-fs.js';
import { getScan, listScans } from '../../storage/queries/scans.js';
import { listResources } from '../../storage/queries/resources.js';
import { listCosts } from '../../storage/queries/costs.js';
import { listRecommendations } from '../../storage/queries/recommendations.js';

export type ReportFormat = 'json' | 'csv' | 'html';

interface ReportPipelineOptions {
  format?: ReportFormat | undefined;
  outputPath?: string | undefined;
  scanId?: string | undefined;
}

export function buildReportPipelineSteps(opts: ReportPipelineOptions = {}): PipelineStep[] {
  const format = opts.format ?? 'json';

  return [
    {
      name: 'Reading last scan from database',
      completedName: 'Read scan data from database',
      key: 'scan_data',
      getDetail: (result) => {
        const r = result as { resourceCount?: number; recommendationCount?: number } | null | undefined;
        const resources = r?.resourceCount ?? 0;
        const recs = r?.recommendationCount ?? 0;
        return `${resources} resources${DOT_SEP}${recs} recommendations`;
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- implements PipelineStep.run: () => Promise<unknown>
      run: async () => {
        const db = getDb();
        const latestScan = opts.scanId !== undefined
          ? getScan(db, opts.scanId)
          : listScans(db, 1)[0];
        if (latestScan === null || latestScan === undefined) {
          if (opts.scanId !== undefined) {
            throw new Error(`Scan "${opts.scanId}" was not found. Open history and choose an existing scan ID.`);
          }
          throw new Error('No scan data found. Start a scan first.');
        }
        const scanId = latestScan.id;

        const resources = listResources(db, scanId);
        const costs = listCosts(db, scanId);
        const recommendations = listRecommendations(db, scanId);

        return {
          scan: latestScan,
          resources,
          costs,
          recommendations,
          resourceCount: resources.length,
          totalCost: costs.reduce((sum, c) => sum + (c.monthly_cost ?? c.daily_cost ?? 0), 0),
          recommendationCount: recommendations.length,
        };
      },
    },
    {
      name: `Generating ${format.toUpperCase()} report`,
      completedName: `Generated ${format.toUpperCase()} report`,
      key: 'report',
      getDetail: (result) => {
        const r = result as { format?: string; outputPath?: string; written?: boolean } | null | undefined;
        if (r?.written && r.outputPath) return path.basename(r.outputPath);
        return r?.format?.toUpperCase() ?? format.toUpperCase();
      },
      // eslint-disable-next-line @typescript-eslint/require-await -- implements PipelineStep.run: () => Promise<unknown>
      run: async (ctx: PipelineContext) => {
        const data = ctx.results.get('scan_data') as {
          scan: Record<string, unknown>;
          resources: unknown[];
          costs: unknown[];
          recommendations: unknown[];
          resourceCount: number;
          totalCost: number;
          recommendationCount: number;
        };

        // Build ScanReport from database records
        const scan = data.scan;
        const potentialSavings = (data.recommendations).reduce<number>((sum, rec: unknown) => {
          const r = rec as Record<string, unknown>;
          return sum + (Number(r['estimated_savings'] ?? 0) || 0);
        }, 0);

        const scanReport: ScanReport = {
          scanId: asStr(scan['id']),
          timestamp: asStr(scan['created_at'], new Date().toISOString()),
          resources: (data.resources).map((r: unknown) => {
            const rec = r as Record<string, unknown>;
            const instanceType = rec['instance_type'] ? asStr(rec['instance_type']) : undefined;
            const tags = typeof rec['tags'] === 'object' ? (rec['tags'] as Record<string, string>) : undefined;
            return {
              id: asStr(rec['resource_id']) || asStr(rec['id']),
              type: asStr(rec['resource_type']) || asStr(rec['type']),
              name: asStr(rec['name']),
              region: asStr(rec['region']),
              state: asStr(rec['state']),
              ...(instanceType !== undefined ? { instanceType } : {}),
              monthlyCost: Number(rec['monthly_cost'] ?? 0) || 0,
              monthlyCostSource: (rec['monthly_cost_source'] as 'cost_explorer' | 'pricing_api' | null | undefined) ?? null,
              ...(tags !== undefined ? { tags } : {}),
            };
          }),
          recommendations: (data.recommendations).map((r: unknown) => {
            const rec = r as Record<string, unknown>;
            const description = rec['description'] ? asStr(rec['description']) : undefined;
            return {
              id: asStr(rec['id']),
              resourceId: asStr(rec['resource_id']),
              type: asStr(rec['type']),
              title: asStr(rec['title']),
              ...(description !== undefined ? { description } : {}),
              estimatedSavings: Number(rec['estimated_savings'] ?? 0) || 0,
              confidence: Number(rec['confidence'] ?? 0) || 0,
              impact: asStr(rec['impact'], 'medium'),
              risk: asStr(rec['risk'], 'medium'),
              status: asStr(rec['status'], 'open'),
            };
          }),
          costs: (data.costs).map((c: unknown) => {
            const cost = c as Record<string, unknown>;
            return {
              serviceName: asStr(cost['service_name']),
              region: asStr(cost['region']),
              costDate: asStr(cost['cost_date']),
              dailyCost: Number(cost['daily_cost'] ?? 0) || 0,
              monthlyCost: Number(cost['monthly_cost'] ?? 0) || 0,
              currency: asStr(cost['currency'], 'USD'),
            };
          }),
          summary: {
            totalResources: data.resourceCount,
            totalMonthlyCost: data.totalCost,
            potentialSavings,
            recommendationCount: data.recommendationCount,
          },
        };

        // Use the appropriate formatter
        const formatter = createFormatter(format);
        const content = formatter.format(scanReport);

        if (opts.outputPath) {
          const resolved = path.resolve(opts.outputPath);
          safeWriteFile(resolved, content, { mode: 0o600, dirMode: 0o700 });
          return { format, outputPath: resolved, written: true, size: content.length };
        }

        return { format, content, written: false, size: content.length };
      },
    },
  ];
}

/** Extract report result info from pipeline context. */
export function extractReportResult(ctx: PipelineContext): {
  format: string;
  outputPath?: string;
  written: boolean;
  content?: string;
  size: number;
  resourceCount: number;
  totalCost: number;
  recommendationCount: number;
} {
  const scanData = ctx.results.get('scan_data') as {
    resourceCount: number;
    totalCost: number;
    recommendationCount: number;
  } | undefined;
  const report = ctx.results.get('report') as {
    format: string;
    outputPath?: string;
    written: boolean;
    content?: string;
    size: number;
  } | undefined;

  const result: Record<string, unknown> = {
    format: report?.format ?? 'json',
    written: report?.written ?? false,
    size: report?.size ?? 0,
    resourceCount: scanData?.resourceCount ?? 0,
    totalCost: scanData?.totalCost ?? 0,
    recommendationCount: scanData?.recommendationCount ?? 0,
  };
  if (report?.outputPath !== undefined) result['outputPath'] = report.outputPath;
  if (report?.content !== undefined) result['content'] = report.content;
  return result as {
    format: string;
    outputPath?: string;
    written: boolean;
    content?: string;
    size: number;
    resourceCount: number;
    totalCost: number;
    recommendationCount: number;
  };
}
