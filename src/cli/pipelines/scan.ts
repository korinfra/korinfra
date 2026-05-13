/**
 * Scan pipeline — no-AI deterministic scan.
 *
 * Runs the same tools as the AI-orchestrated scan, in a fixed order:
 *   collect_aws_resources → evaluate_rules → [scan_terraform + classify_resources] → get_costs → detect_anomalies → save_scan
 */

import type { PipelineStep, PipelineContext } from '../components/DirectPipeline.js';
import type { ToolResult } from '../../tools/types.js';
import type { CollectError } from '../../aws/types.js';
import { collectAwsTool } from '../../tools/collect-aws.js';
import { DOT_SEP } from '../ui/text.js';
import { asStr } from '../../utils/coerce.js';
import { evaluateRulesTool } from '../../tools/evaluate-rules.js';
import { getCostsTool } from '../../tools/get-costs.js';
import { detectAnomalesTool } from '../../tools/detect-anomalies.js';
import { saveScanTool } from '../../tools/save-scan.js';
import { scanTerraformTool } from '../../tools/scan-terraform.js';
import { classifyResourcesTool } from '../../tools/classify-resources.js';
import { AWS_REGION_RE } from '../utils/validateRegions.js';

/** Parse a ToolResult's JSON text content. Throws on error results. */
export function parseToolResult(result: ToolResult): unknown {
  const text = result.content[0]?.text ?? '';
  if (result.isError) throw new Error(text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

interface ScanPipelineOptions {
  regions?: string[];
  profile?: string | null;
  skipCosts?: boolean;
  skipMetrics?: boolean;
  /** Path to a Terraform directory. When provided, scan_terraform + classify_resources run to classify A/B/C. */
  dir?: string | null;
}

export function buildScanPipelineSteps(opts: ScanPipelineOptions = {}): PipelineStep[] {
  // Capture the real pipeline start time so save_scan can record an accurate started_at.
  const pipelineStartedAt = new Date().toISOString();

  let collectCompletedServices: Array<{ svc: string; ms: number }> = [];

  return [
    {
      name: 'Collecting AWS resources',
      completedName: 'Collected AWS resources',
      key: 'collect',
      getDetail: () => {
        if (collectCompletedServices.length === 0) return '';
        return `${collectCompletedServices.length} services`;
      },
      run: async (ctx: PipelineContext) => {
        const completed: Array<{ svc: string; ms: number }> = [];

        const SVC_LABELS: Record<string, string> = {
          ec2: 'EC2', rds: 'RDS', lambda: 'λ', ecs: 'ECS', elb: 'ELB',
          elasticache: 'Cache', dynamodb: 'DDB', nat_gateway: 'NAT', s3: 'S3',
        };
        const TOTAL_SERVICES = Object.keys(SVC_LABELS).length;

        const args: Record<string, unknown> = {
          skipMetrics: opts.skipMetrics ?? true,
          skipCosts: opts.skipCosts ?? false,
          compact: false,
          _onProgress: (svc: string, _region: string, ms: number, _count: number) => {
            completed.push({ svc, ms });
            collectCompletedServices = [...completed];
            const doneLabels = completed.map(({ svc: s, ms: m }) =>
              `${SVC_LABELS[s] ?? s} ✓ ${m < 1000 ? `${m}ms` : `${(m / 1000).toFixed(1)}s`}`
            );
            const remaining = TOTAL_SERVICES - completed.length;
            const subStatus = remaining > 0
              ? `${doneLabels.join(DOT_SEP)}${DOT_SEP}${remaining} remaining`
              : doneLabels.join(DOT_SEP);
            ctx.setSubStatus?.(subStatus);
          },
        };
        if (opts.regions && opts.regions.length > 0) args['regions'] = opts.regions;
        if (opts.profile) args['profile'] = opts.profile;
        const result = await collectAwsTool.handler(args);
        return parseToolResult(result);
      },
    },
    {
      name: 'Evaluating 65 cost rules',
      completedName: 'Evaluated 65 cost rules',
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
    ...(opts.dir
      ? [
          {
            name: 'Scanning Terraform files',
            completedName: 'Scanned Terraform files',
            key: 'terraform',
            getDetail: (result: unknown) => {
              const r = result as { resources?: unknown[] } | null | undefined;
              const count = r?.resources?.length ?? 0;
              return `${count} resources`;
            },
            run: async () => {
              const result = await scanTerraformTool.handler({ dir: opts.dir });
              return parseToolResult(result);
            },
          },
          {
            name: 'Classifying resources (A/B/C)',
            completedName: 'Classified resources',
            key: 'classify',
            getDetail: (result: unknown) => {
              const r = result as { classification?: { matched?: unknown[]; unmatched?: unknown[]; notDeployed?: unknown[] } } | null | undefined;
              const matched = r?.classification?.matched?.length ?? 0;
              const unmatched = r?.classification?.unmatched?.length ?? 0;
              return `${matched} managed${DOT_SEP}${unmatched} unmanaged`;
            },
            run: async (ctx: PipelineContext) => {
              const collectResult = ctx.results.get('collect') as { resources?: unknown[] } | undefined;
              const tfResult = ctx.results.get('terraform') as { resources?: unknown[]; stateResources?: unknown[] } | undefined;
              const result = await classifyResourcesTool.handler({
                awsResources: collectResult?.resources ?? [],
                terraformResources: tfResult?.resources ?? [],
                stateResources: tfResult?.stateResources ?? [],
              });
              return parseToolResult(result);
            },
          },
        ]
      : []),
    ...(opts.skipCosts
      ? []
      : [
          {
            name: 'Fetching cost data',
            completedName: 'Fetched cost data',
            key: 'costs',
            getDetail: (_result: unknown) => 'last 30 days',
            run: async () => {
              const result = await getCostsTool.handler({ granularity: 'MONTHLY' });
              return parseToolResult(result);
            },
          },
          {
            name: 'Detecting cost anomalies',
            completedName: 'Detected cost anomalies',
            key: 'anomalies',
            getDetail: (result: unknown) => {
              const r = result as { anomalies?: unknown[] } | null | undefined;
              const count = r?.anomalies?.length ?? 0;
              return count > 0 ? `${count} spike${count !== 1 ? 's' : ''}` : 'none';
            },
            run: async (ctx: PipelineContext) => {
              const costsResult = ctx.results.get('costs') as { costs?: unknown[] } | undefined;
              const costData = costsResult?.costs ?? [];
              const result = await detectAnomalesTool.handler({ costData });
              return parseToolResult(result);
            },
          },
        ]),
    {
      name: 'Saving scan results',
      completedName: 'Saved scan results',
      key: 'save',
      run: async (ctx: PipelineContext) => {
        const collectResult = ctx.results.get('collect') as {
          resources?: unknown[];
          errors?: CollectError[];
        } | undefined;
        const costsResult = ctx.results.get('costs') as { costs?: unknown[] } | undefined;
        const rulesResult = ctx.results.get('rules') as { recommendations?: unknown[] } | undefined;

        const classifyResult = ctx.results.get('classify') as {
          recommendations?: unknown[];
          classification?: { matched?: Array<{ aws: { id: string } }> };
        } | undefined;

        const resources = collectResult?.resources ?? [];
        const costs = costsResult?.costs ?? [];

        // Matched AWS resource IDs from classify_resources → these are Scenario B resources.
        // evaluate_rules recs for matched resources should be tagged B, not C.
        const scenarioBIds = new Set(
          (classifyResult?.classification?.matched ?? []).map((p) => p.aws.id),
        );

        // Build filePath lookup: aws resource ID → terraform filePath for scenario B recs
        const matchedFilePathMap = new Map<string, string>();
        for (const pair of (classifyResult?.classification?.matched ?? [])) {
          const p = pair as { aws?: { id?: string }; terraform?: { filePath?: string } };
          if (p.aws?.id && p.terraform?.filePath) {
            matchedFilePathMap.set(p.aws.id, p.terraform.filePath);
          }
        }

        // evaluate_rules recs: tag B if resource is matched (TF+AWS), else C (AWS-only).
        const rulesRecs = (rulesResult?.recommendations ?? []).map((r: unknown) => {
          const rec = r as Record<string, unknown>;
          const resourceId = typeof rec['resource_id'] === 'string' ? rec['resource_id'] : '';
          const scenario: 'B' | 'C' = classifyResult && scenarioBIds.has(resourceId) ? 'B' : 'C';
          const file_path = scenario === 'B' ? (matchedFilePathMap.get(resourceId) ?? null) : null;
          return {
            id: rec['id'],
            resource_id: rec['resource_id'],
            resource_type: rec['resource_type'],
            type: rec['impact'] === 'high' ? 'rightsize' : 'general',
            title: rec['title'],
            description: rec['description'],
            reasoning: rec['reasoning'] ?? '',
            estimated_savings: rec['estimated_savings'],
            confidence: rec['confidence'],
            quality_score: rec['qualityScore'],
            impact: rec['impact'],
            risk: rec['risk'],
            scenario,
            file_path,
            patch_content: rec['patch_content'] ?? null,
            implementation_steps: rec['implementation_steps'] ?? null,
            current_config: rec['current_config'] ?? null,
            suggested_config: rec['suggested_config'] ?? null,
          };
        });

        // Scenario recs from classify_resources: A (TF-only, not deployed), B (matched TF+AWS), C (AWS-only, unmanaged).
        // Classifier outputs camelCase (resourceId, filePath, estimatedSavings) — normalize to snake_case.
        // Empty id ('') causes primary key conflicts — omit so save_scan generates a UUID.
        const scenarioRecs = (classifyResult?.recommendations ?? []).map((r: unknown) => {
          const rec = r as Record<string, unknown>;
          const rawId = rec['id'];
          return {
            id: typeof rawId === 'string' && rawId.length > 0 ? rawId : undefined,
            resource_id: rec['resourceId'] ?? rec['resource_id'],
            resource_type: rec['resourceType'] ?? rec['resource_type'],
            type: typeof rec['type'] === 'string' ? rec['type'] : 'general',
            title: rec['title'],
            description: rec['description'],
            reasoning: rec['reasoning'] ?? '',
            estimated_savings: rec['estimatedSavings'] ?? rec['estimated_savings'],
            confidence: rec['confidence'],
            quality_score: rec['qualityScore'],
            impact: rec['impact'],
            risk: rec['risk'],
            scenario: rec['scenario'] as string | undefined,
            file_path: rec['filePath'] ?? rec['file_path'],
            patch_content: rec['patchContent'] ?? rec['patch_content'],
            implementation_steps: rec['implementationSteps'] ?? rec['implementation_steps'] ?? null,
            current_config: rec['currentConfig'] ?? rec['current_config'] ?? null,
            suggested_config: rec['suggestedConfig'] ?? rec['suggested_config'] ?? null,
          };
        });

        // Merge: evaluate_rules recs (tagged B or C) + scenario recs (A/B/C from classify_resources).
        // Scenario recs take priority; filter out rules recs for the same resource+title.
        const scenarioKeys = new Set(scenarioRecs.map((r) => `${asStr(r.resource_id)}::${asStr(r.title)}`));
        const filteredRulesRecs = classifyResult
          ? rulesRecs.filter((r) => !scenarioKeys.has(`${asStr(r.resource_id)}::${asStr(r.title)}`))
          : rulesRecs;
        const recommendations = [...filteredRulesRecs, ...scenarioRecs];

        const collectErrors = collectResult?.errors ?? [];
        const isPartial = collectErrors.length > 0;
        const failedRegions = [...new Set(
          collectErrors
            .filter((e) => e.region !== undefined && AWS_REGION_RE.test(e.region))
            .map((e) => e.region as string),
        )];

        const result = await saveScanTool.handler({
          resources,
          costs,
          recommendations,
          started_at: pipelineStartedAt,
          ...(isPartial ? {
            metadata: {
              partial: true,
              error_count: collectErrors.length,
              failed_regions: failedRegions,
            },
          } : {}),
        });
        return parseToolResult(result);
      },
    },
  ];
}

/** Extract ScanSummaryData-compatible shape from pipeline context. */
export function extractScanSummary(ctx: PipelineContext): {
  resourceCount: number;
  totalMonthlyCostUsd: number;
  recommendationCount: number;
  anomalyCount: number;
  durationMs: number;
  scanId: string | undefined;
  tfManaged?: number;
  tfUndeployed?: number;
  partial: boolean;
  errorCount: number;
  failedRegions: string[];
} {
  const collectResult = ctx.results.get('collect') as {
    resourceCount?: number;
    errors?: CollectError[];
  } | undefined;
  const rulesResult = ctx.results.get('rules') as {
    summary?: { estimatedSavings?: number; recommendationsFound?: number };
    recommendations?: unknown[];
  } | undefined;
  const anomalyResult = ctx.results.get('anomalies') as { anomalyCount?: number } | undefined;
  const saveResult = ctx.results.get('save') as { total_cost?: number; scan_id?: string } | undefined;
  const pipelineDurationMs = (ctx.results.get('__pipelineDurationMs') as number | undefined) ?? 0;

  const classifyResult = ctx.results.get('classify') as {
    recommendations?: unknown[];
    classification?: {
      matched?: unknown[];
      terraformOnly?: unknown[];
      awsOnly?: unknown[];
    };
  } | undefined;

  const tfManaged = classifyResult?.classification?.matched?.length;
  const tfUndeployed = classifyResult?.classification?.terraformOnly?.length;

  const collectErrors = collectResult?.errors ?? [];
  const failedRegions = [...new Set(
    collectErrors
      .filter((e) => e.region !== undefined && AWS_REGION_RE.test(e.region))
      .map((e) => e.region as string),
  )];

  return {
    resourceCount: collectResult?.resourceCount ?? 0,
    totalMonthlyCostUsd: saveResult?.total_cost ?? 0,
    recommendationCount: (rulesResult?.recommendations?.length ?? 0) + (classifyResult?.recommendations?.length ?? 0),
    anomalyCount: anomalyResult?.anomalyCount ?? 0,
    durationMs: pipelineDurationMs,
    scanId: saveResult?.scan_id,
    ...(tfManaged !== undefined ? { tfManaged } : {}),
    ...(tfUndeployed !== undefined ? { tfUndeployed } : {}),
    partial: collectErrors.length > 0,
    errorCount: collectErrors.length,
    failedRegions,
  };
}

/** Extract recommendation list from pipeline context for rendering. */
export function extractRecommendations(ctx: PipelineContext): Array<{
  id: string;
  title: string;
  description: string;
  impact: 'critical' | 'high' | 'medium' | 'low';
  risk: 'critical' | 'high' | 'medium' | 'low';
  estimatedSavingsUsd: number;
  resourceId?: string;
  type?: string;
  scenario?: string;
}> {
  const rulesResult = ctx.results.get('rules') as { recommendations?: unknown[] } | undefined;
  const classifyResult = ctx.results.get('classify') as { recommendations?: unknown[]; classification?: { matched?: Array<{ aws: { id: string } }> } } | undefined;

  // Build the set of AWS IDs that matched TF resources (Scenario B).
  const scenarioBIds = new Set(
    (classifyResult?.classification?.matched ?? []).map((p) => p.aws.id),
  );

  // Normalise a raw rec object into the display shape.
  function normalise(rec: Record<string, unknown>, isScenarioRec: boolean) {
    const impact = (rec['impact'] ?? 'medium') as string;
    const risk = (rec['risk'] ?? 'low') as string;
    const resourceId = typeof (rec['resourceId'] ?? rec['resource_id']) === 'string'
      ? String(rec['resourceId'] ?? rec['resource_id'])
      : undefined;
    const type = typeof (rec['resourceType'] ?? rec['resource_type']) === 'string'
      ? String(rec['resourceType'] ?? rec['resource_type'])
      : undefined;
    // Derive scenario for cost rules (no scenario in raw output): B if matched, C if AWS-only.
    const rawScenario = typeof rec['scenario'] === 'string' ? rec['scenario'] : undefined;
    const scenario = rawScenario ?? (
      !isScenarioRec && classifyResult && resourceId
        ? (scenarioBIds.has(resourceId) ? 'B' : 'C')
        : undefined
    );
    const savings = isScenarioRec
      ? (typeof rec['estimatedSavings'] === 'number' ? rec['estimatedSavings'] : typeof rec['estimated_savings'] === 'number' ? rec['estimated_savings'] : 0)
      : (typeof rec['estimated_savings'] === 'number' ? rec['estimated_savings'] : 0);
    return {
      id: asStr(rec['id']),
      title: asStr(rec['title']),
      description: asStr(rec['description']),
      impact: (['critical', 'high', 'medium', 'low'].includes(impact) ? impact : 'medium') as 'critical' | 'high' | 'medium' | 'low',
      risk: (['critical', 'high', 'medium', 'low'].includes(risk) ? risk : 'low') as 'critical' | 'high' | 'medium' | 'low',
      estimatedSavingsUsd: savings,
      ...(resourceId !== undefined ? { resourceId } : {}),
      ...(type !== undefined ? { type } : {}),
      ...(scenario !== undefined ? { scenario } : {}),
    };
  }

  const rulesRecs = (rulesResult?.recommendations ?? []).map((r) => normalise(r as Record<string, unknown>, false));
  const scenarioRecs = (classifyResult?.recommendations ?? []).map((r) => normalise(r as Record<string, unknown>, true));

  // Scenario recs (A/B/C) take priority — deduplicate by resource+title.
  const scenarioKeys = new Set(scenarioRecs.map((r) => `${r.resourceId ?? ''}::${r.title}`));
  const filteredRules = rulesRecs.filter((r) => !scenarioKeys.has(`${r.resourceId ?? ''}::${r.title}`));

  return [...filteredRules, ...scenarioRecs];
}
