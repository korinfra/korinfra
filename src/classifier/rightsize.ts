/**
 * Rightsizing logic — ports Go internal/classifier/rightsize.go.
 *
 * Suggests smaller instance types for underutilized EC2 and RDS resources.
 * Works by decomposing instance type strings into family + size, then stepping
 * down within the same family.
 */

import type { Resource } from '../aws/types.js';
import type { Recommendation } from './types.js';
import {
  getMonthlyCost,
  instanceSizeOrder,
  splitInstanceType,
  sizeIndex,
  gravitonFamilies,
} from '../rules/cost/helpers.js';
import { THRESHOLDS } from '../rules/config.js';

// Re-export for consumers that import instanceSizeOrder from this module.
export { instanceSizeOrder } from '../rules/cost/helpers.js';

/**
 * Returns a smaller EC2 instance type within the same family.
 * steps = how many sizes to drop (default 1).
 * Returns null when the current type is already the smallest or not parseable.
 */
export function suggestSmallerInstance(instanceType: string, steps = 1): string | null {
  const parts = splitInstanceType(instanceType);
  if (!parts) return null;
  const [family, size] = parts;

  const currentIdx = sizeIndex(size);
  if (currentIdx < 0) return null;
  if (currentIdx === 0) return null; // already at smallest

  if (steps <= 0) return null;
  const targetIdx = Math.max(0, currentIdx - steps);
  if (targetIdx === currentIdx) return null;

  return `${family}.${instanceSizeOrder[targetIdx]}`;
}

/**
 * Returns a smaller RDS instance class within the same family.
 * RDS classes look like "db.m5.large" — strips the "db." prefix, applies the
 * same logic as suggestSmallerInstance, then re-adds the prefix.
 */
export function suggestSmallerRDS(instanceClass: string, steps = 1): string | null {
  if (!instanceClass.startsWith('db.')) return null;
  const inner = instanceClass.slice(3); // strip "db."
  const parts = splitInstanceType(inner);
  if (!parts) return null;
  const [family, size] = parts;

  const currentIdx = sizeIndex(size);
  if (currentIdx < 0) return null;

  if (steps <= 0) return null;
  const targetIdx = currentIdx - steps;
  if (targetIdx < 0) return null;
  if (targetIdx === currentIdx) return null;

  return `db.${family}.${instanceSizeOrder[targetIdx]}`;
}

/**
 * Suggests a Graviton-equivalent instance type.
 * Maps x86 families to their ARM equivalents using the current-gen mapping
 * from helpers.ts (e.g. m5 → m6g, m7i → m8g, etc.).
 * Returns null if no mapping exists or the type is already Graviton.
 */
export function suggestGravitonEquivalent(instanceType: string): string | null {
  // Handle RDS "db.m5.large" form.
  const isRDS = instanceType.startsWith('db.');
  const typeToCheck = isRDS ? instanceType.slice(3) : instanceType;

  const parts = splitInstanceType(typeToCheck);
  if (!parts) return null;
  const [family, size] = parts;

  const gravitonFamily = gravitonFamilies[family];
  if (!gravitonFamily) return null;

  const result = `${gravitonFamily}.${size}`;
  return isRDS ? `db.${result}` : result;
}

// ---------------------------------------------------------------------------
// Rightsizing thresholds
// ---------------------------------------------------------------------------

export interface RightsizeThresholds {
  /** Avg CPU below this = idle (default: 5%) */
  cpuIdleAvg: number;
  /** Avg CPU below this = underutilized (default: 20%) */
  cpuLowAvg: number;
  /** P95 CPU above this = potentially overloaded (default: 80%) */
  cpuHighP95: number;
  /** Minimum data points for reliable analysis (default: 168 = 7 days hourly) */
  minDataPoints: number;
}

export function defaultThresholds(): RightsizeThresholds {
  return {
    cpuIdleAvg: 5.0,
    cpuLowAvg: 20.0,
    cpuHighP95: 80.0,
    minDataPoints: 168,
  };
}

// ---------------------------------------------------------------------------
// Per-type rightsizing analysis
// ---------------------------------------------------------------------------

interface RightsizeResult {
  resourceId: string;
  resourceType: string;
  currentType: string;
  recommendedType: string;
  reason: string;
  estimatedSaving: number;
  confidence: number;
}

function rightsizeEC2(r: Resource, t: RightsizeThresholds): RightsizeResult | null {
  if (!r.instanceType) return null;
  const u = r.utilization;
  if (!u || u.dataPoints < t.minDataPoints) return null;

  const monthlyCost = getMonthlyCost(r);

  if (u.cpuAverage < t.cpuIdleAvg) {
    const recommended = suggestSmallerInstance(r.instanceType, 2);
    if (!recommended || recommended === r.instanceType) return null;
    // 2 size drops ≈ ec2RightsizeMultiplier savings heuristic
    const estimatedSaving = monthlyCost * THRESHOLDS.ec2RightsizeMultiplier;
    return {
      resourceId: r.id,
      resourceType: r.type,
      currentType: r.instanceType,
      recommendedType: recommended,
      reason: `Instance is idle: CPU avg ${u.cpuAverage.toFixed(1)}% over ${u.period} (${u.dataPoints} data points)`,
      estimatedSaving,
      confidence: 0.9,
    };
  }

  if (u.cpuAverage < t.cpuLowAvg && u.cpuP95 < t.cpuHighP95) {
    const recommended = suggestSmallerInstance(r.instanceType, 1);
    if (!recommended || recommended === r.instanceType) return null;
    // 1 size drop ≈ rdsRightsizeMultiplier savings heuristic
    const estimatedSaving = monthlyCost * THRESHOLDS.rdsRightsizeMultiplier;
    return {
      resourceId: r.id,
      resourceType: r.type,
      currentType: r.instanceType,
      recommendedType: recommended,
      reason: `Instance is underutilized: CPU avg ${u.cpuAverage.toFixed(1)}%, P95 ${u.cpuP95.toFixed(1)}% over ${u.period}`,
      estimatedSaving,
      confidence: 0.8,
    };
  }

  return null;
}

function rightsizeRDS(r: Resource, t: RightsizeThresholds): RightsizeResult | null {
  if (!r.instanceType) return null;
  const u = r.utilization;
  if (!u || u.dataPoints < t.minDataPoints) return null;

  const monthlyCost = getMonthlyCost(r);

  if (u.cpuAverage < t.cpuIdleAvg) {
    const recommended = suggestSmallerRDS(r.instanceType, 2);
    if (!recommended || recommended === r.instanceType) return null;
    // 2 size drops ≈ ec2RightsizeMultiplier savings heuristic
    const estimatedSaving = monthlyCost * THRESHOLDS.ec2RightsizeMultiplier;
    return {
      resourceId: r.id,
      resourceType: r.type,
      currentType: r.instanceType,
      recommendedType: recommended,
      reason: `RDS instance is idle: CPU avg ${u.cpuAverage.toFixed(1)}% over ${u.period}`,
      estimatedSaving,
      confidence: 0.85,
    };
  }

  if (u.cpuAverage < t.cpuLowAvg && u.cpuP95 < t.cpuHighP95) {
    const recommended = suggestSmallerRDS(r.instanceType, 1);
    if (!recommended || recommended === r.instanceType) return null;
    // 1 size drop ≈ rdsRightsizeMultiplier savings heuristic
    const estimatedSaving = monthlyCost * THRESHOLDS.rdsRightsizeMultiplier;
    return {
      resourceId: r.id,
      resourceType: r.type,
      currentType: r.instanceType,
      recommendedType: recommended,
      reason: `RDS instance underutilized: CPU avg ${u.cpuAverage.toFixed(1)}%, P95 ${u.cpuP95.toFixed(1)}%`,
      estimatedSaving,
      confidence: 0.75,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Examines utilization data for resources and returns rightsizing suggestions.
 * Only EC2 and RDS instances are analyzed. Resources without utilization data
 * are skipped.
 */
export function analyzeRightsizing(
  resources: Resource[],
  thresholds: RightsizeThresholds = defaultThresholds(),
): Recommendation[] {
  const recs: Recommendation[] = [];

  for (const r of resources) {
    let result: RightsizeResult | null = null;

    if (r.type === 'ec2_instance') result = rightsizeEC2(r, thresholds);
    else if (r.type === 'rds_instance') result = rightsizeRDS(r, thresholds);

    if (!result) continue;

    recs.push({
      id: '',
      resourceId: result.resourceId,
      resourceType: result.resourceType,
      type: 'rightsize' as const,
      scenario: 'B' as const,
      title: `Rightsize ${result.resourceId} from ${result.currentType} to ${result.recommendedType}`,
      description: result.reason,
      estimatedSavings: result.estimatedSaving,
      confidence: result.confidence,
      impact: 'low',
      risk: 'low',
      currentConfig: { instance_type: result.currentType },
      suggestedConfig: { instance_type: result.recommendedType },
      implementationSteps: [
        `Update instance type from ${result.currentType} to ${result.recommendedType} in Terraform`,
        'Run `terraform plan` to verify changes',
        'Run `terraform apply` during a maintenance window',
      ],
    });
  }

  return recs;
}
