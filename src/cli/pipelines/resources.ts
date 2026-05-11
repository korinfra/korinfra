/**
 * Resources pipeline — no-AI deterministic resource listing.
 *
 * Steps: collect_aws_resources → evaluate_rules (for cost annotations)
 */

import type { PipelineStep, PipelineContext } from '../components/DirectPipeline.js';
import { parseToolResult } from './scan.js';
import { collectAwsTool } from '../../tools/collect-aws.js';
import { asStr } from '../../utils/coerce.js';
import { evaluateRulesTool } from '../../tools/evaluate-rules.js';

interface ResourcesPipelineOptions {
  regions?: string[];
  profile?: string | null;
  typeFilter?: string | null;
}

export function buildResourcesPipelineSteps(opts: ResourcesPipelineOptions = {}): PipelineStep[] {
  return [
    {
      name: 'Collecting AWS resources',
      completedName: 'Collected AWS resources',
      key: 'collect',
      getDetail: (result) => {
        const r = result as { resources?: unknown[] } | null | undefined;
        const count = r?.resources?.length ?? 0;
        return count > 0 ? `${count} resources` : '';
      },
      run: async () => {
        const args: Record<string, unknown> = {
          skipMetrics: true,
          compact: true,
        };
        if (opts.regions && opts.regions.length > 0) args['regions'] = opts.regions;
        if (opts.profile) args['profile'] = opts.profile;
        if (opts.typeFilter) args['typeFilter'] = opts.typeFilter;
        const result = await collectAwsTool.handler(args);
        return parseToolResult(result);
      },
    },
    {
      name: 'Evaluating cost rules',
      completedName: 'Evaluated cost rules',
      key: 'rules',
      getDetail: (result) => {
        const r = result as { recommendations?: unknown[] } | null | undefined;
        const count = r?.recommendations?.length ?? 0;
        return count > 0 ? `${count} findings` : 'no findings';
      },
      run: async (ctx: PipelineContext) => {
        const collectResult = ctx.results.get('collect') as { resources?: unknown[] } | undefined;
        const resources = collectResult?.resources ?? [];
        const result = await evaluateRulesTool.handler({ resources });
        return parseToolResult(result);
      },
    },
  ];
}

/** Extract resource rows for ResourceTable from pipeline context. */
export function extractResourceRows(ctx: PipelineContext): Array<{
  id: string;
  name: string;
  type: string;
  region: string;
  state: string;
  instanceType: string;
  engine?: string;
  sizeGb?: number;
  monthlyCostUsd?: number;
  monthlyCostSource?: 'cost_explorer' | 'pricing_api' | null;
  arn?: string;
  collectedAt?: string;
}> {
  const collectResult = ctx.results.get('collect') as {
    resources?: Array<Record<string, unknown>>;
  } | undefined;
  const resources = (collectResult?.resources ?? []).filter(
    (r): r is Record<string, unknown> => r !== null && r !== undefined && typeof r === 'object',
  );

  return resources.map((r) => {
    const engine = typeof r['engine'] === 'string' ? r['engine'] : undefined;
    const sizeGb = typeof r['size_gb'] === 'number' ? r['size_gb'] : undefined;
    const monthlyCostUsd = typeof r['monthly_cost'] === 'number' ? r['monthly_cost'] : (typeof r['monthlyCost'] === 'number' ? r['monthlyCost'] : undefined);
    const arn = typeof r['arn'] === 'string' ? r['arn'] : undefined;
    const collectedAt = typeof r['collected_at'] === 'string' ? r['collected_at'] : undefined;
    return {
      id: asStr(r['id']) || asStr(r['resourceId']),
      name: asStr(r['name']) || asStr(r['resourceId']),
      type: asStr(r['type']) || asStr(r['resourceType']) || 'unknown',
      region: asStr(r['region'], '—'),
      state: asStr(r['state'], 'unknown'),
      instanceType: asStr(r['instance_type']) || asStr(r['instanceType']),
      ...(engine !== undefined ? { engine } : {}),
      ...(sizeGb !== undefined ? { sizeGb } : {}),
      ...(monthlyCostUsd !== undefined ? { monthlyCostUsd } : {}),
      monthlyCostSource: ((r['monthly_cost_source'] ?? r['monthlyCostSource']) as 'cost_explorer' | 'pricing_api' | null | undefined) ?? null,
      ...(arn !== undefined ? { arn } : {}),
      ...(collectedAt !== undefined ? { collectedAt } : {}),
    };
  });
}
