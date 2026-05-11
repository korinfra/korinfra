/**
 * Scenario recommendations — ports Go internal/classifier/scenarios.go.
 *
 * Generates actionable recommendations for each classification scenario:
 * - Scenario A (terraformOnly): defined in .tf but not found in AWS
 * - Scenario B (matched): exists in both — check for config mismatches
 * - Scenario C (awsOnly): in AWS but not in Terraform
 */

import type { Classification, MatchedPair, Recommendation, ScenarioSummary } from './types.js';
import type { TerraformResource } from '../terraform/types.js';
import { normalizeType } from './matcher.js';
import { redact } from '../redaction/redactor.js';
import { evaluateSecurityRules } from '../rules/security/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export interface ScenarioConfidenceConfig {
  /** Baseline confidence with zero meaningful attributes (default 0.50). */
  base: number;
  /** Confidence increment per meaningful attribute (default 0.075). */
  step: number;
  /** Upper bound on confidence (default 0.95). */
  max: number;
  /** Higher baseline used when the resource came from .tfstate (authoritative — default 0.80). */
  stateBase: number;
}

const DEFAULT_SCENARIO_CONFIDENCE: ScenarioConfidenceConfig = {
  base: 0.50,
  step: 0.075,
  max: 0.95,
  stateBase: 0.80,
};

/**
 * Top-level configuration keys excluded when counting "meaningful" pricing attributes.
 * These either don't influence cost (tags, depends_on, lifecycle) or are book-keeping fields.
 */
const NON_PRICING_KEYS = new Set([
  'tags',
  'tags_all',
  'depends_on',
  'lifecycle',
  'provider',
  'count',
  'for_each',
  'provisioner',
  'connection',
  'timeouts',
]);

/** Counts non-empty top-level config attributes that influence pricing/sizing. */
export function countMeaningfulAttributes(tf: TerraformResource): number {
  let n = 0;
  for (const [k, v] of Object.entries(tf.configuration)) {
    if (NON_PRICING_KEYS.has(k)) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    n++;
  }
  return n;
}

/** Dynamic scenario confidence: base + step * attributeCount, clamped to [base, max]. */
export function attributeConfidence(
  tf: TerraformResource,
  cfg: ScenarioConfidenceConfig = DEFAULT_SCENARIO_CONFIDENCE,
  baseOverride?: number,
): number {
  const count = countMeaningfulAttributes(tf);
  const base = baseOverride ?? cfg.base;
  const raw = base + cfg.step * count;
  return Math.min(Math.max(raw, base), cfg.max);
}

/** Returns "high" | "medium" | "low" confidence label. */
export function confidenceLevel(confidence: number): string {
  if (confidence >= 0.9) return 'high';
  if (confidence >= 0.7) return 'medium';
  return 'low';
}

/** Derives impact from recommendation type and estimated savings. */
function deriveImpact(recType: string, savings: number, ruleImpact: string): string {
  if (recType === 'security' || recType === 'tag') return ruleImpact;
  if (recType === 'config_diff') {
    if (savings > 0) return categorizeImpact(savings);
    return ruleImpact;
  }
  return categorizeImpact(savings);
}

function categorizeImpact(savings: number): string {
  if (savings >= 100) return 'high';
  if (savings >= 25) return 'medium';
  return 'low';
}

// ---------------------------------------------------------------------------
// Aggregate summary
// ---------------------------------------------------------------------------

export function summarize(c: Classification): ScenarioSummary {
  let configDiffCount = 0;
  let highConfidence = 0;
  let lowConfidence = 0;

  for (const m of c.matched) {
    if (m.configDiffs.length > 0) configDiffCount++;
    if (m.confidence >= 0.9) highConfidence++;
    else if (m.confidence < 0.7) lowConfidence++;
  }

  return {
    totalResources: c.matched.length + c.terraformOnly.length + c.awsOnly.length,
    scenarioACount: c.terraformOnly.length,
    scenarioBCount: c.matched.length,
    scenarioCCount: c.awsOnly.length,
    configDiffCount,
    highConfidence,
    lowConfidence,
  };
}

// ---------------------------------------------------------------------------
// Scenario recommendations
// ---------------------------------------------------------------------------

/**
 * Generates recommendations for Scenario A (terraformOnly) and Scenario C
 * (awsOnly) resources. For Scenario B config-diff recommendations, use
 * generateConfigDiffRecommendations().
 */
export function generateScenarioRecommendations(
  classification: Classification,
  confidenceConfig: ScenarioConfidenceConfig = DEFAULT_SCENARIO_CONFIDENCE,
): Recommendation[] {
  const recs: Recommendation[] = [];

  // --- Scenario A: TF-only resources — suggest apply or remove -----------
  for (const tf of classification.terraformOnly) {
    // Skip non-resource HCL blocks and provider types that have no standalone AWS API counterpart.
    if (
      tf.type === 'variable' ||
      tf.type === 'locals' ||
      tf.type === 'output' ||
      tf.address.startsWith('var.') ||
      tf.address.startsWith('local.') ||
      tf.address.startsWith('data.') ||
      tf.address.startsWith('output.')
    ) continue;
    // Skip non-AWS providers (random, null, time, tls, local, etc.)
    if (!tf.type.startsWith('aws_')) continue;
    // Skip S3 sub-resource configuration types — these are bucket settings, not standalone resources.
    if (
      tf.type === 'aws_s3_bucket_versioning' ||
      tf.type === 'aws_s3_bucket_server_side_encryption_configuration' ||
      tf.type === 'aws_s3_bucket_lifecycle_configuration' ||
      tf.type === 'aws_s3_bucket_notification' ||
      tf.type === 'aws_s3_bucket_ownership_controls' ||
      tf.type === 'aws_s3_bucket_cors_configuration' ||
      tf.type === 'aws_s3_bucket_logging' ||
      tf.type === 'aws_s3_bucket_website' ||
      tf.type === 'aws_s3_bucket_request_payment_configuration'
    ) continue;
    // Scenario A: security recs come from generateTfSecurityRecommendations.
    // Only surface the destroyed-in-AWS edge case here (state cleanup needed).
    if (!tf.destroyedInAws) continue;

    recs.push({
      id: '',
      resourceId: tf.address,
      resourceType: normalizeType(tf.type),
      type: 'config_diff' as const,
      scenario: 'A' as const,
      title: `Resource ${tf.address} was destroyed outside Terraform`,
      description:
        'This resource exists in your Terraform state file (meaning it was previously applied) ' +
        'but the corresponding AWS resource no longer exists. ' +
        'It was likely deleted manually via the console or CLI. ' +
        'Run `terraform refresh` or remove it from state with `terraform state rm`.',
      estimatedSavings: 0,
      impact: 'low',
      risk: 'low',
      // State-only: state file is authoritative → high baseline, attribute-scaled
      confidence: attributeConfidence(tf, confidenceConfig, confidenceConfig.stateBase),
      filePath: tf.filePath,
      implementationSteps: [
        'Run `terraform refresh` to sync state with real AWS state',
        'Or remove from state: `terraform state rm ' + tf.address + '`',
      ],
    });
  }

  return recs;
}

// ---------------------------------------------------------------------------
// Scenario A + B security recommendations (TF static analysis)
// ---------------------------------------------------------------------------

function severityToImpact(severity: string): string {
  if (severity === 'critical' || severity === 'high') return 'high';
  if (severity === 'medium') return 'medium';
  return 'low';
}

/**
 * Runs security rules against Terraform resources for Scenario A (TF-only,
 * preventive) and Scenario B (matched, deployed). Returns one Recommendation
 * per finding. Scenario A findings are preventive (fix before deploying);
 * Scenario B findings are real (resource is live in AWS).
 */
export function generateTfSecurityRecommendations(
  classification: Classification,
  confidenceConfig: ScenarioConfidenceConfig = DEFAULT_SCENARIO_CONFIDENCE,
): Recommendation[] {
  const allTfResources = [
    ...classification.terraformOnly,
    ...classification.matched.map((p) => p.terraform),
  ];
  if (allTfResources.length === 0) return [];

  const findings = evaluateSecurityRules(allTfResources);
  if (findings.length === 0) return [];

  const scenarioMap = new Map<string, 'A' | 'B'>();
  const tfMap = new Map<string, TerraformResource>();
  for (const tf of classification.terraformOnly) {
    scenarioMap.set(tf.address, 'A');
    tfMap.set(tf.address, tf);
  }
  for (const pair of classification.matched) {
    scenarioMap.set(pair.terraform.address, 'B');
    tfMap.set(pair.terraform.address, pair.terraform);
  }

  const matchConfidence = new Map<string, number>();
  for (const pair of classification.matched) {
    matchConfidence.set(pair.terraform.address, pair.confidence);
  }

  return findings.map((finding) => {
    const scenario = scenarioMap.get(finding.resource) ?? 'A';
    const tf = tfMap.get(finding.resource);
    const tfType = tf?.type ?? '';
    const filePath = tf?.filePath ?? '';
    const impact = severityToImpact(finding.severity);
    const preventiveNote = scenario === 'A'
      ? '. Fix this before deploying.'
      : '. Resource is live in AWS — remediate promptly.';

    // Confidence: Scenario A → attribute-scaled. Scenario B → matcher confidence (already dynamic).
    const confidence = scenario === 'B' && matchConfidence.has(finding.resource)
      ? matchConfidence.get(finding.resource) ?? confidenceConfig.base
      : tf
        ? attributeConfidence(tf, confidenceConfig)
        : confidenceConfig.base;

    return {
      id: '',
      resourceId: finding.resource,
      resourceType: normalizeType(tfType),
      type: 'security' as const,
      scenario,
      ruleId: finding.ruleId,
      title: `[${finding.ruleId}] ${finding.title}`,
      description: finding.description + preventiveNote,
      estimatedSavings: 0,
      impact,
      risk: impact,
      confidence,
      filePath,
      implementationSteps: [finding.recommendation],
    };
  });
}

// ---------------------------------------------------------------------------
// Config diff recommendations (Scenario B)
// ---------------------------------------------------------------------------

/**
 * Generates recommendations for matched pairs that have high-severity config mismatches.
 */
export function generateConfigDiffRecommendations(pairs: MatchedPair[]): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const pair of pairs) {
    for (const d of pair.configDiffs) {
      if (d.severity !== 'high' && d.severity !== 'critical') continue;

      const safeTfValue = redact(JSON.stringify(d.tfValue), 'moderate');
      const safeAwsValue = redact(JSON.stringify(d.awsValue), 'moderate');

      recs.push({
        id: '',
        resourceId: pair.aws.id,
        resourceType: pair.aws.type,
        type: 'config_diff' as const,
        scenario: 'B' as const,
        title: `Config mismatch: ${d.field} differs for ${pair.terraform.address}`,
        description:
          `Terraform expects ${d.field}=${safeTfValue} but AWS has ${d.field}=${safeAwsValue}. ` +
          `This mismatch may cause unexpected behavior or cost differences.`,
        impact: deriveImpact('config_diff', 0, 'high'),
        risk: 'medium',
        confidence: pair.confidence,
        currentConfig: {
          [d.field]: d.tfValue,
          line_number: pair.terraform.lineNumber,
        },
        suggestedConfig: {
          [d.field]: d.awsValue,
        },
        filePath: pair.terraform.filePath,
        implementationSteps: [
          'Run `terraform plan` to see all pending changes',
          'Run `terraform apply` to align AWS with Terraform configuration',
          `Or update ${d.field} in your .tf file to match the AWS value: ${safeAwsValue}`,
        ],
      });
    }
  }

  return recs;
}
