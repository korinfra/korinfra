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
import pThrottle from 'p-throttle';
import { getCredentials, resolveRegion } from '../aws/credentials.js';
import { logApiCall } from '../aws/rate-limiter.js';
import { redactObject } from '../redaction/index.js';
import { logger } from '../utils/logger.js';
import { jsonResult, errorResult } from './types.js';
import type { ToolDefinition, ToolResult } from './types.js';

const OPERATION_NAMES: Record<string, string> = {
  ec2: 'GetEC2InstanceRecommendations',
  asg: 'GetAutoScalingGroupRecommendations',
  ebs: 'GetEBSVolumeRecommendations',
  lambda: 'GetLambdaFunctionRecommendations',
  ecs: 'GetECSServiceRecommendations',
  rds: 'GetRDSDatabaseRecommendations',
};

// 5 req/sec — conservative; AWS Compute Optimizer default TPS is 20.
// throttledCoCall is defined at module level so ALL regions share one token bucket.
const _coThrottle = pThrottle({ limit: 5, interval: 1000 });
const throttledCoCall = _coThrottle(
  async (
    callFn: () => Promise<NormalizedRecommendation[]>,
    operation: string,
    region: string,
  ): Promise<NormalizedRecommendation[]> => {
    const ts = Date.now();
    try {
      const result = await callFn();
      logApiCall({ service: 'compute-optimizer', operation, region, timestamp: new Date(ts).toISOString(), durationMs: Date.now() - ts, estimatedCost: 0 });
      return result;
    } catch (err) {
      logApiCall({ service: 'compute-optimizer', operation, region, timestamp: new Date(ts).toISOString(), durationMs: Date.now() - ts, estimatedCost: 0, error: String(err) });
      throw err;
    }
  },
);

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

/**
 * Detect the IAM-missing case (separate from opt-in). Surfaces a different
 * message because the user fix is different: they must add the
 * `compute-optimizer:Get*` permissions to the calling role.
 */
function isAccessDenied(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  if (e.name === 'AccessDeniedException') return true;
  if (e.$metadata?.httpStatusCode === 403) return true;
  const msg = (e.message ?? '').toLowerCase();
  return msg.includes('not authorized') || msg.includes('access denied');
}

function extractMissingPermission(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { message?: string };
  // AWS messages look like: "User: arn:... is not authorized to perform: compute-optimizer:GetEC2InstanceRecommendations"
  const m = /perform:\s*([a-zA-Z0-9_:-]+)/.exec(e.message ?? '');
  return m ? (m[1] ?? null) : null;
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

interface Page<R> {
  items: R[];
  nextToken: string | undefined;
}

/**
 * Loop on `nextToken` until either the per-type cap is reached or AWS stops
 * paginating. AWS Compute Optimizer's `maxResults` parameter is per-page
 * (typical max 100) and pagination is required to honour `maxItemsPerType`.
 */
async function paginate<R>(
  caller: (nextToken: string | undefined, pageSize: number) => Promise<Page<R>>,
  cap: number,
): Promise<R[]> {
  const collected: R[] = [];
  let nextToken: string | undefined;
  // AWS Compute Optimizer caps maxResults at 100 for most operations.
  const PAGE_LIMIT = 100;
  do {
    const remaining = cap - collected.length;
    if (remaining <= 0) break;
    const pageSize = Math.min(PAGE_LIMIT, remaining);
    const page = await caller(nextToken, pageSize);
    collected.push(...page.items);
    nextToken = page.nextToken;
  } while (nextToken && collected.length < cap);
  return collected.slice(0, cap);
}

async function callRegion(
  client: ComputeOptimizerClient,
  region: string,
  types: ResourceTypeKey[],
  maxItems: number,
): Promise<{
  items: NormalizedRecommendation[];
  optInRequired: boolean;
  accessDenied: boolean;
  missingPermission: string | null;
  /** Per-type errors that were neither opt-in nor access-denied (throttling, regional, network). */
  otherErrors: Array<{ resourceType: ResourceTypeKey; message: string }>;
}> {
  const items: NormalizedRecommendation[] = [];
  let optInRequired = false;
  let accessDenied = false;
  let missingPermission: string | null = null;
  const otherErrors: Array<{ resourceType: ResourceTypeKey; message: string }> = [];

  // Each fetcher pages through nextToken until the per-type cap is reached.
  const callsByType: Record<ResourceTypeKey, () => Promise<NormalizedRecommendation[]>> = {
    ec2: async () => {
      const raw = await paginate<unknown>(async (nextToken, pageSize) => {
        const out = await client.send(new GetEC2InstanceRecommendationsCommand({ maxResults: pageSize, nextToken }));
        return { items: out.instanceRecommendations ?? [], nextToken: out.nextToken };
      }, maxItems);
      return raw
        .map((r) => normalizeEc2(r as Record<string, unknown>, region))
        .filter((x): x is NormalizedRecommendation => x !== null);
    },
    asg: async () => {
      const raw = await paginate<unknown>(async (nextToken, pageSize) => {
        const out = await client.send(new GetAutoScalingGroupRecommendationsCommand({ maxResults: pageSize, nextToken }));
        return { items: out.autoScalingGroupRecommendations ?? [], nextToken: out.nextToken };
      }, maxItems);
      return raw
        .map((r) => normalizeAsg(r as Record<string, unknown>, region))
        .filter((x): x is NormalizedRecommendation => x !== null);
    },
    ebs: async () => {
      const raw = await paginate<unknown>(async (nextToken, pageSize) => {
        const out = await client.send(new GetEBSVolumeRecommendationsCommand({ maxResults: pageSize, nextToken }));
        return { items: out.volumeRecommendations ?? [], nextToken: out.nextToken };
      }, maxItems);
      return raw
        .map((r) => normalizeEbs(r as Record<string, unknown>, region))
        .filter((x): x is NormalizedRecommendation => x !== null);
    },
    lambda: async () => {
      const raw = await paginate<unknown>(async (nextToken, pageSize) => {
        const out = await client.send(new GetLambdaFunctionRecommendationsCommand({ maxResults: pageSize, nextToken }));
        return { items: out.lambdaFunctionRecommendations ?? [], nextToken: out.nextToken };
      }, maxItems);
      return raw
        .map((r) => normalizeLambda(r as Record<string, unknown>, region))
        .filter((x): x is NormalizedRecommendation => x !== null);
    },
    ecs: async () => {
      const raw = await paginate<unknown>(async (nextToken, pageSize) => {
        const out = await client.send(new GetECSServiceRecommendationsCommand({ maxResults: pageSize, nextToken }));
        return { items: out.ecsServiceRecommendations ?? [], nextToken: out.nextToken };
      }, maxItems);
      return raw
        .map((r) => normalizeEcs(r as Record<string, unknown>, region))
        .filter((x): x is NormalizedRecommendation => x !== null);
    },
    rds: async () => {
      const raw = await paginate<unknown>(async (nextToken, pageSize) => {
        const out = await client.send(new GetRDSDatabaseRecommendationsCommand({ maxResults: pageSize, nextToken }));
        return { items: out.rdsDBRecommendations ?? [], nextToken: out.nextToken };
      }, maxItems);
      return raw.flatMap((r) => normalizeRds(r as Record<string, unknown>, region));
    },
  };

  // Tag each call with its resource type so errors can be attributed and
  // surfaced in `otherErrors` rather than silently dropped.
  const tagged = await Promise.all(types.map(async (t): Promise<
    | { type: ResourceTypeKey; status: 'ok'; items: NormalizedRecommendation[] }
    | { type: ResourceTypeKey; status: 'opt_in' }
    | { type: ResourceTypeKey; status: 'access_denied'; missingPermission: string | null }
    | { type: ResourceTypeKey; status: 'error'; message: string }
  > => {
    try {
      const fetched = await throttledCoCall(callsByType[t], OPERATION_NAMES[t] ?? `Get${t}Recommendations`, region);
      return { type: t, status: 'ok', items: fetched };
    } catch (err) {
      if (isOptInRequired(err)) return { type: t, status: 'opt_in' };
      if (isAccessDenied(err)) return { type: t, status: 'access_denied', missingPermission: extractMissingPermission(err) };
      const e = err as { name?: string; message?: string } | undefined;
      return { type: t, status: 'error', message: e?.message ?? e?.name ?? 'unknown error' };
    }
  }));

  for (const r of tagged) {
    if (r.status === 'ok') items.push(...r.items);
    else if (r.status === 'opt_in') optInRequired = true;
    else if (r.status === 'access_denied') {
      accessDenied = true;
      missingPermission = missingPermission ?? r.missingPermission;
    } else {
      otherErrors.push({ resourceType: r.type, message: r.message });
      logger.debug({ err: r.message, region, resourceType: r.type }, '[compute-optimizer] per-type call failed');
    }
  }

  return { items, optInRequired, accessDenied, missingPermission, otherErrors };
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
      let anyAccessDenied = false;
      let firstMissingPermission: string | null = null;
      const warnings: string[] = [];

      const perRegion = await Promise.allSettled(
        regions.map(async (region) => {
          const client = new ComputeOptimizerClient({ region, credentials });
          return { region, result: await callRegion(client, region, types, maxItems) };
        }),
      );

      for (const settled of perRegion) {
        if (settled.status === 'fulfilled') {
          const { region, result } = settled.value;
          allRecommendations.push(...result.items);
          if (result.optInRequired) anyOptInRequired = true;
          if (result.accessDenied) {
            anyAccessDenied = true;
            firstMissingPermission = firstMissingPermission ?? result.missingPermission;
          }
          for (const e of result.otherErrors) {
            warnings.push(`${region}/${e.resourceType}: ${e.message}`);
          }
        } else {
          const reason = settled.reason as { name?: string; message?: string } | undefined;
          warnings.push(`region failed: ${reason?.message ?? reason?.name ?? 'unknown error'}`);
          logger.debug({ err: settled.reason }, '[compute-optimizer] per-region call failed');
        }
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

      // If everything failed with AccessDenied and we got no recs, surface the missing IAM hint.
      if (allRecommendations.length === 0 && anyAccessDenied) {
        return jsonResult({
          source: 'compute-optimizer',
          status: 'access_denied',
          message: firstMissingPermission
            ? `The calling role is not authorized to call ${firstMissingPermission}.`
            : 'The calling role is not authorized to call the Compute Optimizer APIs.',
          regions,
          next: [
            { label: 'required IAM policy', permissions: [
              'compute-optimizer:GetEC2InstanceRecommendations',
              'compute-optimizer:GetAutoScalingGroupRecommendations',
              'compute-optimizer:GetEBSVolumeRecommendations',
              'compute-optimizer:GetLambdaFunctionRecommendations',
              'compute-optimizer:GetECSServiceRecommendations',
              'compute-optimizer:GetRDSDatabaseRecommendations',
            ] },
          ],
        });
      }

      // If everything failed for some other reason (throttling, regional outage,
      // network) we'd otherwise return a misleading `status: 'ok'` with zero
      // recommendations. Surface it as a partial-failure status instead.
      if (allRecommendations.length === 0 && warnings.length > 0) {
        return jsonResult(redactObject({
          source: 'compute-optimizer',
          status: 'partial_failure',
          message: 'All Compute Optimizer calls failed; no recommendations could be retrieved.',
          regions,
          warnings,
        }, 'moderate'));
      }

      const byType: Partial<Record<ResourceTypeKey, number>> = {};
      let estimatedMonthlySavingsUsd = 0;
      for (const r of allRecommendations) {
        byType[r.resourceType] = (byType[r.resourceType] ?? 0) + 1;
        estimatedMonthlySavingsUsd += r.estimatedMonthlySavingsUsd;
      }

      // Sort descending by savings so the most actionable items show first.
      const sorted = [...allRecommendations].sort(
        (a, b) => b.estimatedMonthlySavingsUsd - a.estimatedMonthlySavingsUsd,
      );

      return jsonResult(redactObject({
        source: 'compute-optimizer',
        // If we got recommendations but also some failures, mark as partial so
        // consumers (CI especially) know the dataset is incomplete.
        status: warnings.length > 0 ? 'partial' : 'ok',
        regions,
        summary: {
          total: sorted.length,
          byType,
          estimatedMonthlySavingsUsd,
        },
        recommendations: sorted,
        ...(warnings.length > 0 ? { warnings } : {}),
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
      if (isAccessDenied(err)) {
        const perm = extractMissingPermission(err);
        return jsonResult({
          source: 'compute-optimizer',
          status: 'access_denied',
          message: perm
            ? `The calling role is not authorized to call ${perm}.`
            : 'The calling role is not authorized to call the Compute Optimizer APIs.',
          next: [
            { label: 'required IAM policy', permissions: [
              'compute-optimizer:GetEC2InstanceRecommendations',
              'compute-optimizer:GetAutoScalingGroupRecommendations',
              'compute-optimizer:GetEBSVolumeRecommendations',
              'compute-optimizer:GetLambdaFunctionRecommendations',
              'compute-optimizer:GetECSServiceRecommendations',
              'compute-optimizer:GetRDSDatabaseRecommendations',
            ] },
          ],
        });
      }
      return errorResult(err);
    }
  },
};
