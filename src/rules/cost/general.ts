/**
 * General cost optimization rules.
 * Ported from Go internal/ai/rules.go (GENERAL-001).
 */

import type { Resource } from '../../aws/types.js';
import type { Recommendation } from '../types.js';
import type { ThresholdsOverride } from '../config.js';
import type { THRESHOLDS } from '../config.js';
import { DEFAULT_REGIONAL_PREMIUMS } from '../../config/defaults.js';
import { getMonthlyCost } from './helpers.js';
import { clampConfidence, guardSavings } from '../../utils/numeric-guards.js';

type Cfg = typeof THRESHOLDS & ThresholdsOverride;

/** GENERAL-001: Resource in expensive region. */
export function checkGENERAL001(r: Resource, cfg: Cfg): Recommendation | null {
  const monthlyCost = getMonthlyCost(r);
  if (monthlyCost < cfg.regionCostThreshold) return null;
  if ((r.tags['DataResidency']?.length ?? 0) > 0 || (r.tags['Compliance']?.length ?? 0) > 0) return null;

  // Use static regional premium map (estimateEC2CostSync is region-agnostic and cannot
  // distinguish regional pricing differences — live pricing requires the async API client).
  const staticPremium = DEFAULT_REGIONAL_PREMIUMS[r.region];
  if (staticPremium === undefined) return null;
  const premium = staticPremium;
  // Confidence scales with premium magnitude — bigger price gap = stronger signal.
  // Capped at 0.75 because region migration carries hidden data-transfer / app-level costs.
  const confidence = Math.min(0.40 + premium * 1.5, 0.75);

  if (premium < 0.05) return null; // Less than 5% premium — not worth flagging

  const savings = monthlyCost * premium;
  return {
    ruleId: 'GENERAL-001',
    resourceId: r.id,
    resourceType: r.type,
    title: `Resource ${r.name} in ${r.region} costs ~${Math.round(premium * 100)}% more than us-east-1`,
    description: `Resource ${r.name} (${r.type}) is in ${r.region} which is approximately ${Math.round(premium * 100)}% more expensive than us-east-1 for equivalent compute. Note: region migration requires application-level changes and data transfer costs. Verify total migration cost before acting on this recommendation (confidence: low).`,
    reasoning: `AWS prices vary by region. ${r.region} is ${Math.round(premium * 100)}% more expensive than us-east-1 for this resource type. At $${monthlyCost.toFixed(2)}/mo, moving regions could save ~$${savings.toFixed(2)}/mo, but migration requires planning and has hidden costs.`,
    impact: 'medium',
    risk: 'high',
    estimatedSavings: guardSavings(savings),
    suggestedAction: 'migrate_to_us_east_1',
    confidence: clampConfidence(confidence),
    currentConfig: { region: r.region, monthly_cost: monthlyCost },
    suggestedConfig: { region: 'us-east-1' },
    patchContent: `  provider = aws.us_east_1  # was: ${r.region} (~${Math.round(premium * 100)}% premium)`,
    implementationSteps: [
      'Verify there are no data-residency, compliance, or latency requirements preventing migration',
      'Estimate data transfer costs for the migration (can be significant for large datasets)',
      'Plan a blue-green migration: provision in us-east-1, migrate data, then cut over',
      'Update Terraform provider alias to target us-east-1',
    ],
  };
}

export const generalRules = [checkGENERAL001];
