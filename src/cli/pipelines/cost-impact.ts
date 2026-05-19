/**
 * Cost-impact pipeline — no-AI deterministic analysis of a Terraform plan.
 *
 * Single step that delegates to the `analyze_plan` MCP tool. The pipeline
 * exists so the TUI and headless paths share the same flow + extractor as
 * other commands.
 */

import { analyzePlanTool } from '../../tools/analyze-plan.js';
import type {
  AnalyzePlanChangeRow,
  AnalyzePlanFinding,
  AnalyzePlanResult,
} from '../../tools/analyze-plan.js';
import type { PipelineContext, PipelineStep } from '../components/DirectPipeline.js';
import { parseToolResult } from './scan.js';

export type CostImpactView = AnalyzePlanResult;
export type CostImpactRow = AnalyzePlanChangeRow;
export type CostImpactFinding = AnalyzePlanFinding;

interface CostImpactPipelineOptions {
  planFile: string;
  currency?: string;
}

export function buildCostImpactPipelineSteps(opts: CostImpactPipelineOptions): PipelineStep[] {
  return [
    {
      name: 'Analyzing Terraform plan',
      completedName: 'Analyzed Terraform plan',
      key: 'cost_impact',
      getDetail: (result) => {
        const r = result as { summary?: { counts?: Record<string, number> } } | null | undefined;
        const c = r?.summary?.counts;
        if (c === undefined) return '';
        const parts: string[] = [];
        if ((c['create'] ?? 0) > 0) parts.push(`${c['create']}c`);
        if ((c['update'] ?? 0) > 0) parts.push(`${c['update']}u`);
        if ((c['destroy'] ?? 0) > 0) parts.push(`${c['destroy']}d`);
        if ((c['replace'] ?? 0) > 0) parts.push(`${c['replace']}r`);
        return parts.length > 0 ? parts.join(' · ') : 'no changes';
      },
      run: async () => {
        const result = await analyzePlanTool.handler({
          planFile: opts.planFile,
          ...(opts.currency !== undefined ? { currency: opts.currency } : {}),
        });
        return parseToolResult(result);
      },
    },
  ];
}

const EMPTY_VIEW: CostImpactView = {
  summary: {
    netDeltaMonthlyUsd: 0,
    netDeltaAnnualUsd: 0,
    counts: { create: 0, update: 0, destroy: 0, replace: 0 },
    unpricedCount: 0,
    unknownCount: 0,
    variableCount: 0,
    skippedCount: 0,
  },
  changes: [],
  findings: [],
  warnings: [],
};

/** Extract the normalized cost-impact view from a pipeline context. */
export function extractCostImpact(ctx: PipelineContext): CostImpactView {
  const raw = ctx.results.get('cost_impact') as CostImpactView | null | undefined;
  if (raw === null || raw === undefined) return { ...EMPTY_VIEW };
  return {
    summary: { ...EMPTY_VIEW.summary, ...(raw.summary ?? {}) },
    changes: Array.isArray(raw.changes) ? raw.changes : [],
    findings: Array.isArray(raw.findings) ? raw.findings : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
  };
}
