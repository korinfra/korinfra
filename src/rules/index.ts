/**
 * Rule runner — evaluates all cost rules against all resources.
 * Ported from Go internal/ai/rules.go Evaluate().
 */

import type { Resource } from '../aws/types.js';
import type { Recommendation, RuleContext, RuleWarning } from './types.js';
import type { ThresholdsOverride } from './config.js';
import { THRESHOLDS } from './config.js';
import { scoreRecommendation } from './quality.js';
import type { QualityConfig } from '../config/types.js';
import { logger } from '../utils/logger.js';

const DEFAULT_QUALITY_CONFIG: QualityConfig = {
  excellent_threshold: 85,
  good_threshold: 70,
  fair_threshold: 50,
  savings_tier_high: 500,
  savings_tier_medium: 100,
  savings_tier_low: 20,
  title_min_length: 10,
  title_max_length: 80,
  description_full_length: 80,
  description_partial_length: 30,
  reasoning_full_length: 50,
  actionability_confidence_threshold: 0.9,
  actionability_max_bonus: 5,
  min_confidence_threshold: 0.40,
  savings_pct_high: 0.20,
  savings_pct_medium: 0.05,
};

import { ec2Rules } from './cost/ec2.js';
import { ebsRules } from './cost/ebs.js';
import { eipRules } from './cost/eip.js';
import { rdsRules } from './cost/rds.js';
import { s3Rules } from './cost/s3.js';
import { lambdaRules } from './cost/lambda.js';
import { elbRules } from './cost/elb.js';
import { elastiCacheRules } from './cost/elasticache.js';
import { dynamodbRules } from './cost/dynamodb.js';
import { natRules } from './cost/nat.js';
import { ecsRules } from './cost/ecs.js';
import { tagsRules } from './cost/tags.js';
import { generalRules } from './cost/general.js';

type RuleFn = (
  r: Resource,
  cfg: typeof THRESHOLDS & ThresholdsOverride & { currency: string },
  ctx?: RuleContext,
) => Recommendation | null;

/** Rules that apply to all resources (cross-cutting / global checks). */
const globalRuleFns: RuleFn[] = [
  ...tagsRules,
  ...generalRules,
];

/** Resource-type specific rule dispatch table. */
const ruleFnsByType: Readonly<Record<string, RuleFn[]>> = {
  ec2_instance: [...ec2Rules, ...globalRuleFns],
  ebs_volume: [...ebsRules, ...globalRuleFns],
  ebs_snapshot: [...ebsRules, ...globalRuleFns],
  elastic_ip: [...eipRules, ...globalRuleFns],
  rds_instance: [...rdsRules, ...globalRuleFns],
  s3_bucket: [...s3Rules, ...globalRuleFns],
  lambda_function: [...lambdaRules, ...globalRuleFns],
  load_balancer: [...elbRules, ...globalRuleFns],
  elasticache_cluster: [...elastiCacheRules, ...globalRuleFns],
  dynamodb_table: [...dynamodbRules, ...globalRuleFns],
  nat_gateway: [...natRules, ...globalRuleFns],
  ecs_service: [...ecsRules, ...globalRuleFns],
};

/**
 * Evaluates all cost rules against the provided resources.
 *
 * Returns recommendations alongside per-resource warnings emitted by rules
 * that skipped evaluation (e.g. monthly_cost missing). Warnings let JSON
 * consumers and the CLI surface which resources were silently dropped.
 */
export function evaluateRules(
  resources: Resource[],
  overrides?: ThresholdsOverride,
  ruleIds?: string[],
  currency = 'USD',
  qualityConfig: QualityConfig = DEFAULT_QUALITY_CONFIG,
): { recommendations: Recommendation[]; warnings: RuleWarning[] } {
  const cfg = { ...THRESHOLDS, ...(overrides ?? {}), currency } as typeof THRESHOLDS & ThresholdsOverride & { currency: string };
  const allowedRuleIds = ruleIds && ruleIds.length > 0 ? new Set(ruleIds) : null;

  const recs: Recommendation[] = [];
  const warnings: RuleWarning[] = [];
  // Mirror the recommendations filter at the source: when the caller restricts
  // execution to a subset of ruleIds, no-op warnings emitted by other rules so
  // they never enter the output array.
  const ctx: RuleContext = {
    warn(ruleId, resourceId, resourceType, reason) {
      if (allowedRuleIds !== null && !allowedRuleIds.has(ruleId)) return;
      warnings.push({ ruleId, resourceId, resourceType, reason });
    },
  };
  let seq = 1;

  for (const resource of resources) {
    const ruleFns = ruleFnsByType[resource.type] ?? globalRuleFns;
    for (const fn of ruleFns) {
      let rec: Recommendation | null = null;
      try {
        rec = fn(resource, cfg, ctx);
      } catch (err: unknown) {
        logger.debug({ ruleName: fn.name, resourceId: resource.id, err }, 'Rule threw, skipping');
      }
      if (!rec) continue;
      if (allowedRuleIds !== null && !allowedRuleIds.has(rec.ruleId ?? '')) continue;
      const seqStr = String(seq).padStart(3, '0');
      seq++;
      rec.id = (rec.ruleId ?? '') + '-' + seqStr;
      rec.qualityScore = scoreRecommendation(rec, qualityConfig);
      if ((rec.confidence ?? 1) < qualityConfig.min_confidence_threshold) continue;
      recs.push(rec);
    }
  }

  recs.sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0));

  return { recommendations: dedup(recs, cfg.maxRecommendations), warnings };
}

/**
 * Deduplicates recommendations by (ruleId, resourceId) pair.
 * Input must be pre-sorted by quality score desc — first occurrence = highest quality.
 */
const CONFLICTING_RULE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['EC2-001', 'EC2-004'],
  ['EC2-014', 'EC2-005'], // Spot opportunity is more specific than generic RI candidate
  ['RDS-001', 'RDS-003'],
] as const;

const CONFLICT_MAP = new Map<string, string>();
for (const [a, b] of CONFLICTING_RULE_PAIRS) {
  CONFLICT_MAP.set(b, a);
}

function dedup(recs: Recommendation[], maxCount: number): Recommendation[] {
  const seen = new Set<string>();
  const result: Recommendation[] = [];
  for (const rec of recs) {
    const key = `${rec.ruleId ?? ''}::${rec.resourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(rec);
    if (maxCount > 0 && result.length >= maxCount) break;
  }

  const byResource = new Map<string, Set<string>>();
  for (const rec of result) {
    const set = byResource.get(rec.resourceId) ?? new Set<string>();
    set.add(rec.ruleId ?? '');
    byResource.set(rec.resourceId, set);
  }

  const finalResult = result.filter((rec) => {
    const suppressedBy = CONFLICT_MAP.get(rec.ruleId ?? '');
    if (!suppressedBy) return true;
    return !(byResource.get(rec.resourceId)?.has(suppressedBy));
  });

  return finalResult;
}

export type { Recommendation, RuleContext, RuleWarning } from './types.js';
export type { ThresholdsOverride } from './config.js';
export { THRESHOLDS } from './config.js';
export { ruleRegistry } from './registry.js';
export { scoreRecommendation } from './quality.js';
