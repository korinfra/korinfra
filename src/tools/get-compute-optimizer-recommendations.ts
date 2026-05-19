/**
 * MCP tool: get_compute_optimizer_recommendations.
 *
 * Surfaces AWS Compute Optimizer recommendations alongside korinfra's
 * rule-based ones. Compute Optimizer is opt-in (account-level); the first
 * call returns OptInRequiredException if it isn't enabled, which we coalesce
 * into a friendly `status: 'not_enabled'` payload.
 *
 * For local multi-signal idle detection (CPU + network) from rule data, see
 * the `find_idle_ec2` tool. This tool surfaces AWS's own ML-based sizing
 * recommendations.
 */

import {
  ComputeOptimizerClient,
  GetAutoScalingGroupRecommendationsCommand,
  GetEBSVolumeRecommendationsCommand,
  GetEC2InstanceRecommendationsCommand,
  GetECSServiceRecommendationsCommand,
  GetLambdaFunctionRecommendationsCommand,
  GetRDSDatabaseRecommendationsCommand,
} from '@aws-sdk/client-compute-optimizer';
import { getCredentials, resolveRegion } from '../aws/credentials.js';
import { redactObject } from '../redaction/index.js';
import { jsonResult, errorResult } from './types.js';
import type { ToolDefinition, ToolResult } from './types.js';

type ResourceTypeKey = 'ec2' | 'asg' | 'ebs' | 'lambda' | 'ecs' | 'rds';

interface NormalizedRecommendation {
  source: 'compute-optimizer';
  resourceType: ResourceTypeKey;
  resourceArn: string;
  region: string;
  currentConfiguration: Record<string, unknown>;
  recommendedConfiguration: Record<string, unknown>;
  finding: string;
  estimatedMonthlySavingsUsd: number;
  performanceRisk: string;
  lookbackPeriodInDays: number;
}

const ALL_TYPES: ResourceTypeKey[] = ['ec2', 'asg', 'ebs', 'lambda', 'ecs', 'rds'];

function asNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function isOptInRequired(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string };
  if (e.name === 'OptInRequiredException') return true;
  const msg = (e.message ?? '').toLowerCase();
  return msg.includes('not opted in') || msg.includes('opt-in required');
}

function bestOption<T extends { rank?: number }>(opts: T[] | undefined): T | undefined {
  if (!opts || opts.length === 0) return undefined;
  // Lowest rank = best option per the CO API contract (rank 1 is recommended).
  return [...opts].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99))[0];
}

function normalizeEc2(rec: Record<string, unknown>, region: string): NormalizedRecommendation | null {
  const arn = asString(rec['instanceArn']);
  if (!arn) return null;
  const opts = rec['recommendationOptions'] as Array<Record<string, unknown>> | undefined;
  const best = bestOption(opts as Array<{ rank?: number }> | undefined) as Record<string, unknown> | undefined;
  const savingsOpp = best?.['savingsOpportunity'] as { estimatedMonthlySavings?: { value?: unknown } } | undefined;
  return {
    source: 'compute-optimizer',
    resourceType: 'ec2',
    resourceArn: arn,
    region,
    currentConfiguration: { instanceType: asString(rec['currentInstanceType']) },
    recommendedConfiguration: { instanceType: asString(best?.['instanceType']) },
    finding: asString(rec['finding']),
    estimatedMonthlySavingsUsd: asNumber(savingsOpp?.estimatedMonthlySavings?.value),
    performanceRisk: asString(rec['currentPerformanceRisk']),
    lookbackPeriodInDays: asNumber(rec['lookBackPeriodInDays']),
  };
}

function normalizeAsg(rec: Record<string, unknown>, region: string): NormalizedRecommendation | null {
  const arn = asString(rec['autoScalingGroupArn']);
  if (!arn) return null;
  const opts = rec['recommendationOptions'] as Array<Record<string, unknown>> | undefined;
  const best = bestOption(opts as Array<{ rank?: number }> | undefined) as Record<string, unknown> | undefined;
  const savingsOpp = best?.['savingsOpportunity'] as { estimatedMonthlySavings?: { value?: unknown } } | undefined;
  const currentCfg = rec['currentConfiguration'] as Record<string, unknown> | undefined;
  const recommendedCfg = best?.['configuration'] as Record<string, unknown> | undefined;
  return {
    source: 'compute-optimizer',
    resourceType: 'asg',
    resourceArn: arn,
    region,
    currentConfiguration: currentCfg ?? {},
    recommendedConfiguration: recommendedCfg ?? {},
    finding: asString(rec['finding']),
    estimatedMonthlySavingsUsd: asNumber(savingsOpp?.estimatedMonthlySavings?.value),
    performanceRisk: asString(rec['currentPerformanceRisk']),
    lookbackPeriodInDays: asNumber(rec['lookBackPeriodInDays']),
  };
}

function normalizeEbs(rec: Record<string, unknown>, region: string): NormalizedRecommendation | null {
  const arn = asString(rec['volumeArn']);
  if (!arn) return null;
  const opts = rec['volumeRecommendationOptions'] as Array<Record<string, unknown>> | undefined;
  const best = bestOption(opts as Array<{ rank?: number }> | undefined) as Record<string, unknown> | undefined;
  const savingsOpp = best?.['savingsOpportunity'] as { estimatedMonthlySavings?: { value?: unknown } } | undefined;
  return {
    source: 'compute-optimizer',
    resourceType: 'ebs',
    resourceArn: arn,
    region,
    currentConfiguration: (rec['currentConfiguration'] as Record<string, unknown>) ?? {},
    recommendedConfiguration: (best?.['configuration'] as Record<string, unknown>) ?? {},
    finding: asString(rec['finding']),
    estimatedMonthlySavingsUsd: asNumber(savingsOpp?.estimatedMonthlySavings?.value),
    performanceRisk: asString(rec['currentPerformanceRisk']),
    lookbackPeriodInDays: asNumber(rec['lookBackPeriodInDays']),
  };
}

function normalizeLambda(rec: Record<string, unknown>, region: string): NormalizedRecommendation | null {
  const arn = asString(rec['functionArn']);
  if (!arn) return null;
  const opts = rec['memorySizeRecommendationOptions'] as Array<Record<string, unknown>> | undefined;
  const best = bestOption(opts as Array<{ rank?: number }> | undefined) as Record<string, unknown> | undefined;
  const savingsOpp = best?.['savingsOpportunity'] as { estimatedMonthlySavings?: { value?: unknown } } | undefined;
  return {
    source: 'compute-optimizer',
    resourceType: 'lambda',
    resourceArn: arn,
    region,
    currentConfiguration: { memorySize: asNumber(rec['currentMemorySize']) },
    recommendedConfiguration: { memorySize: asNumber(best?.['memorySize']) },
    finding: asString(rec['finding']),
    estimatedMonthlySavingsUsd: asNumber(savingsOpp?.estimatedMonthlySavings?.value),
    performanceRisk: asString(rec['currentPerformanceRisk']),
    // Lambda uses lowercase b
    lookbackPeriodInDays: asNumber(rec['lookbackPeriodInDays']),
  };
}

function normalizeEcs(rec: Record<string, unknown>, region: string): NormalizedRecommendation | null {
  const arn = asString(rec['serviceArn']);
  if (!arn) return null;
  const opts = rec['serviceRecommendationOptions'] as Array<Record<string, unknown>> | undefined;
  const best = bestOption(opts as Array<{ rank?: number }> | undefined) as Record<string, unknown> | undefined;
  const savingsOpp = best?.['savingsOpportunity'] as { estimatedMonthlySavings?: { value?: unknown } } | undefined;
  return {
    source: 'compute-optimizer',
    resourceType: 'ecs',
    resourceArn: arn,
    region,
    currentConfiguration: (rec['currentServiceConfiguration'] as Record<string, unknown>) ?? {},
    recommendedConfiguration: {
      cpu: asNumber(best?.['cpu']),
      memory: asNumber(best?.['memory']),
    },
    finding: asString(rec['finding']),
    estimatedMonthlySavingsUsd: asNumber(savingsOpp?.estimatedMonthlySavings?.value),
    performanceRisk: asString(rec['currentPerformanceRisk']),
    // ECS uses lowercase b
    lookbackPeriodInDays: asNumber(rec['lookbackPeriodInDays']),
  };
}

function normalizeRds(rec: Record<string, unknown>, region: string): NormalizedRecommendation[] {
  const arn = asString(rec['resourceArn']);
  if (!arn) return [];
  const out: NormalizedRecommendation[] = [];

  // Instance-level recommendation
  const instOpts = rec['instanceRecommendationOptions'] as Array<Record<string, unknown>> | undefined;
  const bestInst = bestOption(instOpts as Array<{ rank?: number }> | undefined) as Record<string, unknown> | undefined;
  if (bestInst) {
    const savingsOpp = bestInst['savingsOpportunity'] as { estimatedMonthlySavings?: { value?: unknown } } | undefined;
    out.push({
      source: 'compute-optimizer',
      resourceType: 'rds',
      resourceArn: arn,
      region,
      currentConfiguration: { dbInstanceClass: asString(rec['currentDBInstanceClass']) },
      recommendedConfiguration: { dbInstanceClass: asString(bestInst['dbInstanceClass']) },
      // RDS has no plain `finding` — it splits into instanceFinding + storageFinding.
      finding: asString(rec['instanceFinding']),
      estimatedMonthlySavingsUsd: asNumber(savingsOpp?.estimatedMonthlySavings?.value),
      performanceRisk: asString(rec['currentInstancePerformanceRisk']),
      lookbackPeriodInDays: asNumber(rec['lookbackPeriodInDays']),
    });
  }

  // Storage-level recommendation (separate options array)
  const storOpts = rec['storageRecommendationOptions'] as Array<Record<string, unknown>> | undefined;
  const bestStor = bestOption(storOpts as Array<{ rank?: number }> | undefined) as Record<string, unknown> | undefined;
  if (bestStor) {
    const savingsOpp = bestStor['savingsOpportunity'] as { estimatedMonthlySavings?: { value?: unknown } } | undefined;
    out.push({
      source: 'compute-optimizer',
      resourceType: 'rds',
      resourceArn: arn,
      region,
      currentConfiguration: { storage: rec['currentStorageConfiguration'] ?? {} },
      recommendedConfiguration: { storage: bestStor['storageConfiguration'] ?? {} },
      finding: asString(rec['storageFinding']),
      estimatedMonthlySavingsUsd: asNumber(savingsOpp?.estimatedMonthlySavings?.value),
      // Storage doesn't have its own performance risk; reuse the instance value.
      performanceRisk: asString(rec['currentInstancePerformanceRisk']),
      lookbackPeriodInDays: asNumber(rec['lookbackPeriodInDays']),
    });
  }

  return out;
}

async function callRegion(
  client: ComputeOptimizerClient,
  region: string,
  types: ResourceTypeKey[],
  maxItems: number,
): Promise<{ items: NormalizedRecommendation[]; optInRequired: boolean }> {
  const items: NormalizedRecommendation[] = [];
  let optInRequired = false;

  const callsByType: Record<ResourceTypeKey, () => Promise<NormalizedRecommendation[]>> = {
    ec2: async () => {
      const out = await client.send(new GetEC2InstanceRecommendationsCommand({ maxResults: maxItems }));
      return (out.instanceRecommendations ?? [])
        .map((r) => normalizeEc2(r as unknown as Record<string, unknown>, region))
        .filter((x): x is NormalizedRecommendation => x !== null);
    },
    asg: async () => {
      const out = await client.send(new GetAutoScalingGroupRecommendationsCommand({ maxResults: maxItems }));
      return (out.autoScalingGroupRecommendations ?? [])
        .map((r) => normalizeAsg(r as unknown as Record<string, unknown>, region))
        .filter((x): x is NormalizedRecommendation => x !== null);
    },
    ebs: async () => {
      const out = await client.send(new GetEBSVolumeRecommendationsCommand({ maxResults: maxItems }));
      return (out.volumeRecommendations ?? [])
        .map((r) => normalizeEbs(r as unknown as Record<string, unknown>, region))
        .filter((x): x is NormalizedRecommendation => x !== null);
    },
    lambda: async () => {
      const out = await client.send(new GetLambdaFunctionRecommendationsCommand({ maxResults: maxItems }));
      return (out.lambdaFunctionRecommendations ?? [])
        .map((r) => normalizeLambda(r as unknown as Record<string, unknown>, region))
        .filter((x): x is NormalizedRecommendation => x !== null);
    },
    ecs: async () => {
      const out = await client.send(new GetECSServiceRecommendationsCommand({ maxResults: maxItems }));
      return (out.ecsServiceRecommendations ?? [])
        .map((r) => normalizeEcs(r as unknown as Record<string, unknown>, region))
        .filter((x): x is NormalizedRecommendation => x !== null);
    },
    rds: async () => {
      const out = await client.send(new GetRDSDatabaseRecommendationsCommand({ maxResults: maxItems }));
      return (out.rdsDBRecommendations ?? [])
        .flatMap((r) => normalizeRds(r as unknown as Record<string, unknown>, region));
    },
  };

  const results = await Promise.allSettled(types.map((t) => callsByType[t]()));
  for (const result of results) {
    if (result.status === 'fulfilled') {
      items.push(...result.value);
    } else if (isOptInRequired(result.reason)) {
      optInRequired = true;
    }
    // Other per-type rejections (regional outage, throttling) are silently swallowed
    // — Promise.allSettled keeps the rest of the call set alive.
  }

  return { items, optInRequired };
}

export const getComputeOptimizerRecommendationsTool: ToolDefinition = {
  name: 'get_compute_optimizer_recommendations',
  description:
    'Surface AWS Compute Optimizer ML-based rightsizing recommendations for EC2, Auto Scaling, EBS, Lambda, ECS, and RDS. ' +
    'Opt-in: requires Compute Optimizer to be enabled on the account. For local multi-signal idle detection (CPU + network) ' +
    'from rule data, see `find_idle_ec2`.',
  inputSchema: {
    type: 'object',
    properties: {
      profile: { type: 'string', description: 'AWS CLI profile.' },
      regions: {
        type: 'array',
        items: { type: 'string' },
        description: 'Regions to query. Defaults to the resolved region (config.regions[0] or AWS_REGION env).',
      },
      resourceTypes: {
        type: 'array',
        items: { type: 'string', enum: ['ec2', 'asg', 'ebs', 'lambda', 'ecs', 'rds'] },
        description: 'Subset of CO resource types to query. Default: all six.',
      },
      maxItemsPerType: {
        type: 'number',
        description: 'Per-type cap. Default 50, max 500.',
      },
    },
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true },
  handler: async (args): Promise<ToolResult> => {
    try {
      const profile = typeof args['profile'] === 'string' ? args['profile'] : undefined;
      const rawRegions = Array.isArray(args['regions'])
        ? (args['regions'] as unknown[]).filter((r): r is string => typeof r === 'string' && r.length > 0)
        : [];
      const rawTypes = Array.isArray(args['resourceTypes'])
        ? (args['resourceTypes'] as unknown[]).filter(
            (t): t is ResourceTypeKey => typeof t === 'string' && (ALL_TYPES as string[]).includes(t),
          )
        : [];
      const types: ResourceTypeKey[] = rawTypes.length > 0 ? rawTypes : ALL_TYPES;
      const maxItems = typeof args['maxItemsPerType'] === 'number'
        ? Math.max(1, Math.min(args['maxItemsPerType'], 500))
        : 50;

      const baseConfig = profile ? { profile, regions: rawRegions } : { regions: rawRegions };
      const regions = rawRegions.length > 0 ? rawRegions : [resolveRegion(baseConfig)];
      const credentials = getCredentials(baseConfig);

      const allRecommendations: NormalizedRecommendation[] = [];
      let anyOptInRequired = false;

      const perRegion = await Promise.allSettled(
        regions.map(async (region) => {
          const client = new ComputeOptimizerClient({ region, credentials });
          return callRegion(client, region, types, maxItems);
        }),
      );

      for (const result of perRegion) {
        if (result.status === 'fulfilled') {
          allRecommendations.push(...result.value.items);
          if (result.value.optInRequired) anyOptInRequired = true;
        }
        // Per-region rejection (e.g. unsupported region) is swallowed silently.
      }

      // If we got nothing AND the opt-in flag is set, treat as account-level not_enabled.
      if (allRecommendations.length === 0 && anyOptInRequired) {
        return jsonResult({
          source: 'compute-optimizer',
          status: 'not_enabled',
          message: 'AWS Compute Optimizer is not enabled on this account.',
          regions,
          next: [
            { label: 'enable in console', url: 'https://console.aws.amazon.com/compute-optimizer/' },
            { label: 'enable via CLI', command: 'aws compute-optimizer update-enrollment-status --status Active' },
          ],
        });
      }

      const byType: Partial<Record<ResourceTypeKey, number>> = {};
      let estimatedMonthlySavingsUsd = 0;
      for (const r of allRecommendations) {
        byType[r.resourceType] = (byType[r.resourceType] ?? 0) + 1;
        estimatedMonthlySavingsUsd += r.estimatedMonthlySavingsUsd;
      }

      return jsonResult(redactObject({
        source: 'compute-optimizer',
        status: 'ok',
        regions,
        summary: {
          total: allRecommendations.length,
          byType,
          estimatedMonthlySavingsUsd,
        },
        recommendations: allRecommendations,
      }, 'moderate'));
    } catch (err) {
      if (isOptInRequired(err)) {
        return jsonResult({
          source: 'compute-optimizer',
          status: 'not_enabled',
          message: 'AWS Compute Optimizer is not enabled on this account.',
          next: [
            { label: 'enable in console', url: 'https://console.aws.amazon.com/compute-optimizer/' },
            { label: 'enable via CLI', command: 'aws compute-optimizer update-enrollment-status --status Active' },
          ],
        });
      }
      return errorResult(err);
    }
  },
};
