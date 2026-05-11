/**
 * Tags pipeline — no-AI deterministic tag compliance audit.
 *
 * Steps: collect_aws_resources → post-process tag compliance
 */

import type { PipelineStep, PipelineContext } from '../components/DirectPipeline.js';
import { parseToolResult } from './scan.js';
import { collectAwsTool } from '../../tools/collect-aws.js';

const DEFAULT_REQUIRED_TAGS = ['Environment', 'Team', 'Project'];

interface TagsPipelineOptions {
  requiredTags?: string[] | undefined;
  resource?: string | undefined;
}

export function buildTagsPipelineSteps(_opts: TagsPipelineOptions = {}): PipelineStep[] {
  return [
    {
      name: 'Collecting AWS resources with tags',
      completedName: 'Collected AWS resources with tags',
      key: 'collect',
      getDetail: (result) => {
        const r = result as { resources?: unknown[] } | null | undefined;
        const count = r?.resources?.length ?? 0;
        return count > 0 ? `${count} resources` : '';
      },
      run: async () => {
        const result = await collectAwsTool.handler({
          skipMetrics: true,
          compact: false, // Need full tag data
        });
        return parseToolResult(result);
      },
    },
  ];
}

export interface TagComplianceRow {
  id: string;
  name: string;
  type: string;
  region: string;
  tags: Record<string, string>;
  missingTags: string[];
  isCompliant: boolean;
}

/** Extract tag compliance data from pipeline context. */
export function extractTagCompliance(ctx: PipelineContext, opts: TagsPipelineOptions = {}): {
  resources: TagComplianceRow[];
  totalCount: number;
  compliantCount: number;
  compliancePercent: number;
  missingTagCounts: Record<string, number>;
} {
  const requiredTags = opts.requiredTags ?? DEFAULT_REQUIRED_TAGS;
  const resourceFilter = opts.resource;

  const collectResult = ctx.results.get('collect') as {
    resources?: Array<Record<string, unknown>>;
  } | undefined;
  let rawResources = collectResult?.resources ?? [];

  // Apply resource filter if provided
  if (resourceFilter) {
    const filter = resourceFilter.toLowerCase();
    rawResources = rawResources.filter((r) => {
      const id = String((r['id'] as string | null | undefined) ?? (r['resourceId'] as string | null | undefined) ?? '').toLowerCase();
      const name = String((r['name'] as string | null | undefined) ?? '').toLowerCase();
      return id.includes(filter) || name.includes(filter);
    });
  }

  const missingTagCounts: Record<string, number> = {};
  for (const tag of requiredTags) missingTagCounts[tag] = 0;

  const resources: TagComplianceRow[] = rawResources.map((r) => {
    const tags = (typeof r['tags'] === 'object' && r['tags'] !== null ? r['tags'] : {}) as Record<string, string>;
    const missingTags = requiredTags.filter((t) => !(t in tags));
    for (const t of missingTags) missingTagCounts[t] = (missingTagCounts[t] ?? 0) + 1;

    return {
      id: String((r['id'] as string | null | undefined) ?? (r['resourceId'] as string | null | undefined) ?? ''),
      name: String((r['name'] as string | null | undefined) ?? (r['resourceId'] as string | null | undefined) ?? ''),
      type: String((r['type'] as string | null | undefined) ?? (r['resourceType'] as string | null | undefined) ?? 'unknown'),
      region: String((r['region'] as string | null | undefined) ?? '—'),
      tags,
      missingTags,
      isCompliant: missingTags.length === 0,
    };
  });

  const compliantCount = resources.filter((r) => r.isCompliant).length;
  const totalCount = resources.length;
  const compliancePercent = totalCount > 0 ? Math.round((compliantCount / totalCount) * 100) : 100;

  return { resources, totalCount, compliantCount, compliancePercent, missingTagCounts };
}
