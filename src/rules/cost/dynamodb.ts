/**
 * DynamoDB cost optimization rules.
 * Ported from Go internal/ai/rules.go (DDB-001, DDB-002).
 */

import type { Resource } from '../../aws/types.js';
import type { Recommendation, RuleContext } from '../types.js';
import { RULE_WARN_REASONS } from '../types.js';
import type { ThresholdsOverride } from '../config.js';
import type { THRESHOLDS } from '../config.js';
import { strConfig, boolConfig, getMonthlyCost, confidenceFromUtilization } from './helpers.js';
import { clampConfidence, guardSavings } from '../../utils/numeric-guards.js';
import { logger } from '../../utils/logger.js';

// DynamoDB billing mode switch savings: highly variable.
// PAY_PER_REQUEST is cheaper for unpredictable/low traffic (<50% of provisioned capacity used).
// For consistent high-traffic tables, PAY_PER_REQUEST can be 2-5x MORE expensive.
// This ratio is now tunable via cfg.dynamoDBOnDemandSavingsMultiplier.

type Cfg = typeof THRESHOLDS & ThresholdsOverride;

/** DDB-001: DynamoDB provisioned capacity at low utilisation. */
export function checkDDB001(r: Resource, cfg: Cfg, ctx?: RuleContext): Recommendation | null {
  if (r.type !== 'dynamodb_table') return null;
  const billingMode = strConfig(r, 'billing_mode');
  if (billingMode === 'PAY_PER_REQUEST') return null;

  // Only recommend switching to on-demand when utilization data indicates low
  // usage. If utilization data is unavailable, still flag but with lower
  // confidence and a note to evaluate manually.
  const provisionedRead = (r.configuration['read_capacity'] as number | undefined) ?? 0;
  const provisionedWrite = (r.configuration['write_capacity'] as number | undefined) ?? 0;
  const consumedRead = (r.configuration['consumed_read_capacity_units'] as number | undefined);
  const consumedWrite = (r.configuration['consumed_write_capacity_units'] as number | undefined);

  const hasUtilizationData = consumedRead !== undefined && consumedWrite !== undefined;
  if (hasUtilizationData) {
    if (!Number.isFinite(consumedRead) || !Number.isFinite(consumedWrite)) {
      logger.debug({ resourceId: r.id }, 'DDB-001: non-finite consumed capacity, skipping');
      ctx?.warn('DDB-001', r.id, r.type, RULE_WARN_REASONS.DDB_NON_FINITE);
      return null;
    }
    if (provisionedRead === 0 && provisionedWrite === 0 && consumedRead === 0 && consumedWrite === 0) {
      logger.debug({ resourceId: r.id }, 'DDB-001: zero provisioned and zero consumed capacity (paused or new table), skipping');
      ctx?.warn('DDB-001', r.id, r.type, RULE_WARN_REASONS.DDB_ZERO_CAPACITY);
      return null;
    }
    // Skip if consumed capacity is above the threshold of provisioned — table is well-utilized.
    // This is a legitimate skip (no rightsizing needed), not a data-quality issue — no warning emitted.
    const readUtilPct = provisionedRead > 0 ? ((consumedRead) / provisionedRead) * 100 : 0;
    const writeUtilPct = provisionedWrite > 0 ? ((consumedWrite) / provisionedWrite) * 100 : 0;
    if (readUtilPct >= cfg.dynamoDBProvisionedUtilThreshold && writeUtilPct >= cfg.dynamoDBProvisionedUtilThreshold) return null;
  }

  const monthlyCost = getMonthlyCost(r);
  const savings = monthlyCost * cfg.dynamoDBOnDemandSavingsMultiplier;
  const filePath = strConfig(r, 'file_path');

  const utilizationNote = hasUtilizationData
    ? ''
    : ' NOTE: Utilization data was not available — evaluate consumed RCU/WCU metrics before switching.';

  return {
    ruleId: 'DDB-001',
    resourceId: r.id,
    resourceType: r.type,
    title: `Switch DynamoDB table ${r.name} to on-demand pricing`,
    description: `DynamoDB table ${r.name} uses provisioned capacity. On-demand pricing pays only for actual request throughput and is typically more cost-effective for variable or low-traffic tables.${utilizationNote} ⚠ Savings estimate assumes low/unpredictable traffic. If traffic is consistent and high, switching to PAY_PER_REQUEST may INCREASE costs. Verify with CloudWatch ConsumedReadCapacityUnits and ConsumedWriteCapacityUnits metrics.`,
    reasoning: 'Provisioned capacity charges for reserved RCUs/WCUs regardless of actual usage. On-demand charges only for consumed requests, with no capacity planning required.',
    impact: 'high',
    risk: 'high',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'switch_to_on_demand',
    // When no utilization data: use 0.55 (no CloudWatch data available).
    // When config-level utilization data is present: use 0.85 directly.
    // r.utilization is a separate telemetry struct populated by the collector;
    // consumed_read/write_capacity_units in configuration is rule-level evidence.
    confidence: hasUtilizationData ? 0.85 : 0.55,
    filePath,
    currentConfig: { billing_mode: billingMode || 'PROVISIONED' },
    suggestedConfig: { billing_mode: 'PAY_PER_REQUEST' },
    patchContent: '  billing_mode = "PAY_PER_REQUEST"  # was: PROVISIONED',
    implementationSteps: [
      'Review the table\'s consumed RCU/WCU metrics over the past 30 days',
      'If usage is variable or low, switch billing mode to PAY_PER_REQUEST in the DynamoDB console',
      filePath ? `Update ${filePath}: billing_mode = "PAY_PER_REQUEST"` : 'Update Terraform: billing_mode = "PAY_PER_REQUEST"',
      'Run terraform plan to verify, then terraform apply',
      'Monitor costs for 2 weeks to confirm savings',
    ],
  };
}

/** DDB-002: DynamoDB provisioned table without auto-scaling. */
export function checkDDB002(r: Resource, cfg: Cfg): Recommendation | null {
  if (r.type !== 'dynamodb_table') return null;
  const billingMode = strConfig(r, 'billing_mode');
  if (billingMode !== 'PROVISIONED') return null;

  if (boolConfig(r, 'auto_scaling_enabled')) return null;

  const monthlyCost = getMonthlyCost(r);
  const savings = monthlyCost * cfg.dynamoDBAutoScalingSavingsMultiplier;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'DDB-002',
    resourceId: r.id,
    resourceType: r.type,
    title: `DynamoDB table ${r.name} is provisioned without auto-scaling`,
    description: `DynamoDB table ${r.name} uses PROVISIONED billing mode but does not have auto-scaling configured. Unused capacity during off-peak hours is wasted.`,
    reasoning: 'DynamoDB provisioned capacity without auto-scaling locks you into peak capacity costs 24/7. Auto-scaling adjusts capacity to match traffic and can save 20-40% on average workloads.',
    impact: 'medium',
    risk: 'low',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'enable_auto_scaling',
    confidence: clampConfidence(confidenceFromUtilization(0.80, r.utilization)),
    filePath,
    currentConfig: { billing_mode: 'PROVISIONED', auto_scaling_enabled: false },
    suggestedConfig: { auto_scaling_enabled: true },
    patchContent: '  # Add aws_appautoscaling_target and aws_appautoscaling_policy for read and write capacity',
    implementationSteps: [
      'Enable DynamoDB auto-scaling via the AWS console or add aws_appautoscaling_target resources',
      'Set min/max capacity based on observed traffic patterns',
      filePath ? `Add auto-scaling resources to ${filePath}` : 'Add auto-scaling resources in Terraform',
      'Alternatively, consider switching to PAY_PER_REQUEST if traffic is unpredictable',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

export const dynamodbRules = [checkDDB001, checkDDB002];
