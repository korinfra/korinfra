/**
 * S3 cost optimization rules.
 * Ported from Go internal/ai/rules.go (S3-001 through S3-004).
 */

import type { Resource } from '../../aws/types.js';
import type { Recommendation, RuleContext } from '../types.js';
import { RULE_WARN_REASONS } from '../types.js';
import type { ThresholdsOverride } from '../config.js';
import type { THRESHOLDS } from '../config.js';
import { strConfig, boolConfig, numConfig, getMonthlyCost, triStateConfig } from './helpers.js';
import { clampConfidence, guardSavings } from '../../utils/numeric-guards.js';

type Cfg = typeof THRESHOLDS & ThresholdsOverride;

/** S3-001: Bucket without lifecycle policy. */
export function checkS3001(r: Resource, cfg: Cfg, ctx?: RuleContext): Recommendation | null {
  if (r.type !== 's3_bucket') return null;
  // Skip when the collector could not determine lifecycle state (transient
  // API failure / IAM denied) — emitting a "no lifecycle" recommendation
  // would be a false positive.
  const lifecycleState = triStateConfig(r, 'has_lifecycle');
  const lifecycleCountRaw = r.configuration?.['lifecycle_rules_count'];
  if (lifecycleState === 'unknown' || lifecycleCountRaw === 'unknown') {
    ctx?.warn('S3-001', r.id, r.type, RULE_WARN_REASONS.S3_LIFECYCLE_UNKNOWN);
    return null;
  }
  if (numConfig(r, 'lifecycle_rules_count') > 0) return null;
  if (boolConfig(r, 'has_lifecycle')) return null;
  const monthlyCost = getMonthlyCost(r);
  const savings = guardSavings(monthlyCost * cfg.s3LifecycleSavingsMultiplier);
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'S3-001',
    resourceId: r.id,
    resourceType: r.type,
    title: `Add lifecycle policy to S3 bucket ${r.name}`,
    description: `S3 bucket ${r.name} has no lifecycle rules. Moving infrequently accessed objects to S3-IA or Glacier can reduce storage costs significantly. Note: Savings depend on actual access patterns. Glacier/Deep Archive retrieval costs $0.01–0.03/GB standard retrieval. Objects must meet minimum storage durations (30 days for Standard-IA, 90 days for Glacier) to be cost-effective.`,
    reasoning: 'S3 Standard costs $0.023/GB/mo. S3-IA is $0.0125/GB and Glacier is $0.004/GB. Objects not accessed for 30+ days are good lifecycle candidates.',
    impact: 'medium',
    risk: 'low',
    estimatedSavings: savings,
    suggestedAction: 'add_lifecycle_policy',
    confidence: clampConfidence(0.7),
    filePath,
    currentConfig: { lifecycle_rules_count: 0 },
    suggestedConfig: { lifecycle_rule: 'transition_to_ia_30d_glacier_90d' },
    patchContent: '  # Add aws_s3_bucket_lifecycle_configuration:\n  # transition to STANDARD_IA after 30 days, GLACIER after 90 days',
    implementationSteps: [
      'Analyse object access patterns using S3 Storage Lens',
      'Add a lifecycle rule: transition to STANDARD_IA after 30 days, GLACIER after 90 days',
      filePath ? `Add aws_s3_bucket_lifecycle_configuration resource in ${filePath}` : 'Add aws_s3_bucket_lifecycle_configuration resource',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

/** S3-002: Bucket with lifecycle rules but without Intelligent-Tiering transition. */
export function checkS3002(r: Resource, cfg: Cfg, ctx?: RuleContext): Recommendation | null {
  if (r.type !== 's3_bucket') return null;
  // Skip when collector failed to determine lifecycle or tiering state.
  const lifecycleState = triStateConfig(r, 'has_lifecycle');
  const tieringState = triStateConfig(r, 'has_intelligent_tiering');
  if (lifecycleState === 'unknown' || tieringState === 'unknown') {
    ctx?.warn('S3-002', r.id, r.type, RULE_WARN_REASONS.S3_LIFECYCLE_TIERING_UNKNOWN);
    return null;
  }
  if (r.configuration?.['lifecycle_rules_count'] === 'unknown') {
    ctx?.warn('S3-002', r.id, r.type, RULE_WARN_REASONS.S3_LIFECYCLE_COUNT_UNKNOWN);
    return null;
  }
  // Only fire when the bucket already has lifecycle rules (S3-001 handles the no-lifecycle case)
  // but is not using Intelligent-Tiering for automatic storage class optimisation.
  const lifecycleCount = numConfig(r, 'lifecycle_rules_count');
  const hasLifecycle = boolConfig(r, 'has_lifecycle');
  if (lifecycleCount === 0 && !hasLifecycle) return null; // S3-001 covers this
  if (boolConfig(r, 'has_intelligent_tiering')) return null;
  const monthlyCost = getMonthlyCost(r);
  const filePath = strConfig(r, 'file_path');

  // Intelligent-Tiering monitoring fee: $0.0025 per 1,000 objects/month
  const objectCount = (r.configuration['object_count'] as number | undefined) ?? 0;
  const monitoringFeeMonthly = (objectCount / 1000) * 0.0025;
  const grossSavings = monthlyCost * cfg.s3IntelligentTieringSavingsMultiplier;
  const savings = guardSavings(Math.max(0, grossSavings - monitoringFeeMonthly));
  // Only skip when the monitoring fee provably exceeds savings (both must be non-zero).
  // When monthlyCost is unavailable (0), still flag the bucket — we simply can't estimate savings.
  if (monitoringFeeMonthly > 0 && savings <= 0) return null;

  return {
    ruleId: 'S3-002',
    resourceId: r.id,
    resourceType: r.type,
    title: `Add Intelligent-Tiering storage class to S3 bucket ${r.name}`,
    description: `S3 bucket ${r.name} has lifecycle rules but does not use S3 Intelligent-Tiering. Intelligent-Tiering automatically optimises costs for unpredictable access patterns with no retrieval fees. Savings estimate assumes mixed access patterns. Note: Intelligent-Tiering charges a per-object monitoring fee of $0.0025/1,000 objects/month — not cost-effective for buckets with many small objects (<128 KB each).`,
    reasoning: 'S3 Intelligent-Tiering moves objects between access tiers automatically with no retrieval fees, ideal for buckets with unpredictable access. Monitoring fee: $0.0025 per 1,000 objects/month.',
    impact: 'low',
    risk: 'low',
    estimatedSavings: savings,
    suggestedAction: 'add_intelligent_tiering',
    confidence: clampConfidence(0.6),
    filePath,
    currentConfig: { lifecycle_rules_count: lifecycleCount, has_intelligent_tiering: false },
    suggestedConfig: { storage_class: 'INTELLIGENT_TIERING' },
    patchContent: '  # Add lifecycle rule to transition objects to INTELLIGENT_TIERING storage class',
    implementationSteps: [
      'Add a lifecycle rule transitioning objects to INTELLIGENT_TIERING after 0 days',
      'Objects will automatically move between tiers based on access frequency',
      filePath ? `Add aws_s3_bucket_lifecycle_configuration in ${filePath} with INTELLIGENT_TIERING transition` : 'Add aws_s3_bucket_lifecycle_configuration with INTELLIGENT_TIERING transition',
    ],
  };
}

/** S3-003: Bucket without versioning. */
export function checkS3003(r: Resource, cfg: Cfg, ctx?: RuleContext): Recommendation | null {
  void cfg;
  if (r.type !== 's3_bucket') return null;
  // Skip when versioning state could not be determined (transient API failure).
  if (triStateConfig(r, 'versioning_enabled') === 'unknown') {
    ctx?.warn('S3-003', r.id, r.type, RULE_WARN_REASONS.S3_VERSIONING_UNKNOWN);
    return null;
  }
  if (boolConfig(r, 'versioning_enabled')) return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'S3-003',
    resourceId: r.id,
    resourceType: r.type,
    title: `Enable versioning on S3 bucket ${r.name}`,
    description: `S3 bucket ${r.name} does not have versioning enabled, making objects vulnerable to accidental deletion.`,
    reasoning: 'Versioning protects against unintended overwrites and deletions. It is a prerequisite for cross-region replication and MFA Delete.',
    impact: 'medium',
    risk: 'low',
    estimatedSavings: 0,
    suggestedAction: 'enable_versioning',
    confidence: clampConfidence(0.8),
    filePath,
    currentConfig: { versioning_enabled: false },
    suggestedConfig: { versioning_enabled: true },
    patchContent: '  # Add aws_s3_bucket_versioning resource with status = "Enabled"',
    implementationSteps: [
      'Enable versioning: aws s3api put-bucket-versioning --bucket <name> --versioning-configuration Status=Enabled',
      filePath ? `Add aws_s3_bucket_versioning resource in ${filePath}` : 'Add aws_s3_bucket_versioning resource',
      'Add a lifecycle rule to expire old versions after 30-90 days to control costs',
      'Run terraform plan to verify, then terraform apply',
    ],
  };
}

/** S3-004: Bucket without server-side encryption. */
export function checkS3004(r: Resource, cfg: Cfg, ctx?: RuleContext): Recommendation | null {
  void cfg;
  if (r.type !== 's3_bucket') return null;
  if (!('encryption_enabled' in r.configuration)) return null;
  // Skip when encryption state could not be determined (transient API failure)
  // — emitting a "no encryption" recommendation would be a false positive.
  if (triStateConfig(r, 'encryption_enabled') === 'unknown') {
    ctx?.warn('S3-004', r.id, r.type, RULE_WARN_REASONS.S3_ENCRYPTION_UNKNOWN);
    return null;
  }
  if (boolConfig(r, 'encryption_enabled')) return null;
  const filePath = strConfig(r, 'file_path');
  return {
    ruleId: 'S3-004',
    resourceId: r.id,
    resourceType: r.type,
    title: `S3 bucket ${r.name} does not have default server-side encryption enabled`,
    description: `S3 bucket ${r.name} has no default server-side encryption. SSE-S3 (AES-256) is free and should be enabled on all buckets.`,
    reasoning: 'AWS S3 SSE-S3 encryption is free and adds no performance overhead. Without default encryption, objects stored without explicit SSE are stored unencrypted. This is a compliance risk under most security frameworks (SOC2, PCI, HIPAA).',
    impact: 'high',
    risk: 'low',
    estimatedSavings: 0,
    suggestedAction: 'enable_default_encryption',
    confidence: clampConfidence(0.95),
    filePath,
    currentConfig: { encryption_enabled: false },
    suggestedConfig: { encryption_enabled: true, encryption_algorithm: 'AES256' },
    patchContent: '  # Add aws_s3_bucket_server_side_encryption_configuration with rule.apply_server_side_encryption_by_default.sse_algorithm = "AES256"',
    implementationSteps: [
      'Enable default SSE-S3 encryption: aws s3api put-bucket-encryption --bucket <name> --server-side-encryption-configuration ...',
      filePath ? `Add aws_s3_bucket_server_side_encryption_configuration resource to ${filePath}` : 'Add aws_s3_bucket_server_side_encryption_configuration resource',
      'Run terraform plan to verify, then terraform apply',
      'Existing objects are not automatically re-encrypted — run a copy operation if needed for compliance',
    ],
  };
}

export const s3Rules = [checkS3001, checkS3002, checkS3003, checkS3004];
