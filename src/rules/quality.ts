/**
 * Quality scoring for recommendations.
 *
 * All thresholds are configurable via `quality.*` in `.korinfra/config.yaml`.
 * Defaults are defined in `src/config/defaults.ts`.
 */

import type { Recommendation } from './types.js';
import type { QualityConfig } from '../config/types.js';

export function qualityLabel(score: number, cfg: QualityConfig): string {
  if (score >= cfg.excellent_threshold) return 'excellent';
  if (score >= cfg.good_threshold) return 'good';
  if (score >= cfg.fair_threshold) return 'fair';
  return 'poor';
}

/**
 * Computes a 0-100 quality score for a recommendation.
 *
 * Scoring dimensions (sum can exceed 100 — final score is clamped to [0, 100]):
 *   Clarity         0-20: title length within [title_min_length, title_max_length] (+10) + description tiers (+10/+6/+2)
 *   Impact          0-25: max(absolute, relative) tier (+15/+12/+8/+4) + impact label (+10/+6/+2)
 *                          - absolute: savings ≥savings_tier_high/medium/low/>0 USD
 *                          - relative: savings/currentCost ≥savings_pct_high/medium/>0 %
 *   Evidence        0-20: reasoning ≥reasoning_full_length (+10) + has resourceId (+5) + has currentConfig/suggestedConfig (+5) + has utilization metric fields (+5)
 *   Remediation     0-15: has implementationSteps (+10) + has patchContent (+5)
 *   Confidence      0-10: round(confidence * 10)
 *   Reversibility   0-10: action-aware — irreversible actions (delete/terminate) → 0; reversible actions (stop/scale_down) → +6; risk fallback otherwise; +4 if patchContent (git-revertible)
 *   Actionability   bonus: filePath + suggestedConfig (+5), smooth confidence ramp 0→actionability_max_bonus over [threshold, 1.0], deletion (-3)
 *
 * Theoretical max before clamp: 20+25+20+15+10+10+5+5 = 110. Clamping at 100
 * is intentional — recommendations excelling on every dimension all top out
 * together (no fine-grained ranking above 100 needed; sort uses qualityScore desc).
 *
 * Metric field detection: any currentConfig key matching utilization patterns
 * (_pct, _p95, _p99, _avg, _average, _per_, connections, invocations, iops, throughput).
 */
export function scoreRecommendation(rec: Recommendation, cfg: QualityConfig): number {
  const score =
    scoreClarity(rec, cfg) +
    scoreImpact(rec, cfg) +
    scoreEvidence(rec, cfg) +
    scoreRemediation(rec) +
    scoreConfidence(rec) +
    scoreReversibility(rec) +
    scoreActionabilityBonus(rec, cfg);
  return Math.max(0, Math.min(100, score));
}

function scoreActionabilityBonus(rec: Recommendation, cfg: QualityConfig): number {
  let bonus = 0;
  if (rec.filePath && rec.suggestedConfig && Object.keys(rec.suggestedConfig).length > 0) {
    bonus += 5;
  }
  // Smooth confidence bonus: linear ramp from 0 → max_bonus over [threshold, 1.0].
  // Replaces previous binary cliff at confidence > threshold.
  const conf = rec.confidence ?? 0;
  const start = cfg.actionability_confidence_threshold;
  if (conf > start) {
    const span = Math.max(1 - start, 1e-6);
    const ramp = Math.min((conf - start) / span, 1);
    bonus += ramp * cfg.actionability_max_bonus;
  }
  const action = rec.suggestedConfig?.['action'];
  if (action === 'delete' || action === 'terminate_and_delete_volumes') {
    bonus -= 3;
  }
  return bonus;
}

function scoreClarity(rec: Recommendation, cfg: QualityConfig): number {
  let score = 0;
  const tl = rec.title.length;
  if (tl >= cfg.title_min_length && tl <= cfg.title_max_length) score += 10;
  else if (tl > Math.floor(cfg.title_min_length / 2)) score += 5;

  const dl = rec.description.length;
  if (dl >= cfg.description_full_length) score += 10;
  else if (dl >= cfg.description_partial_length) score += 6;
  else if (dl > 0) score += 2;
  return score;
}

function scoreImpact(rec: Recommendation, cfg: QualityConfig): number {
  let score = 0;
  const savings = rec.estimatedSavings ?? 0;

  // Absolute tier
  let absoluteTierScore = 0;
  if (savings >= cfg.savings_tier_high) absoluteTierScore = 15;
  else if (savings >= cfg.savings_tier_medium) absoluteTierScore = 12;
  else if (savings >= cfg.savings_tier_low) absoluteTierScore = 8;
  else if (savings > 0) absoluteTierScore = 4;

  // Relative tier — what fraction of the resource's monthly cost is saved?
  // Lifts small-account recommendations that would otherwise score "low" purely
  // because of low absolute USD. Takes max(absolute, relative) to avoid penalties.
  let relativeTierScore = 0;
  const baseline = rec.currentCost ?? 0;
  if (baseline > 0 && savings > 0) {
    const pct = savings / baseline;
    if (pct >= cfg.savings_pct_high) relativeTierScore = 15;
    else if (pct >= cfg.savings_pct_medium) relativeTierScore = 10;
    else if (pct > 0) relativeTierScore = 5;
  }
  score += Math.max(absoluteTierScore, relativeTierScore);

  if (rec.impact === 'high') score += 10;
  else if (rec.impact === 'medium') score += 6;
  else if (rec.impact === 'low') score += 2;
  return score;
}

/**
 * Pattern matching utilization/metric field names emitted by cost rules.
 * Covers: cpu_avg_pct, cpu_p95_pct, memory_avg_pct, actual_iops_avg, actual_iops_p95,
 * connections_average, invocations_per_month, network_out_gb_mo_estimated, error_rate_pct, etc.
 */
const METRIC_FIELD_PATTERN = /(_pct|_p95|_p99|_avg|_average|_per_|connections|invocations|iops|throughput)/i;

function scoreEvidence(rec: Recommendation, cfg: QualityConfig): number {
  let score = 0;
  const reasoning = rec.reasoning ?? '';
  if (reasoning.length >= cfg.reasoning_full_length) score += 10;
  else if (reasoning.length > 0) score += 5;

  if (rec.resourceId) score += 5;
  if (
    (rec.currentConfig && Object.keys(rec.currentConfig).length > 0) ||
    (rec.suggestedConfig && Object.keys(rec.suggestedConfig).length > 0)
  ) {
    score += 5;
  }

  const cc = rec.currentConfig;
  const hasMetrics = cc !== undefined && cc !== null && Object.keys(cc).some(k => METRIC_FIELD_PATTERN.test(k));
  if (hasMetrics) score += 5;

  return score;
}

function scoreRemediation(rec: Recommendation): number {
  let score = 0;
  if (rec.implementationSteps && rec.implementationSteps.length > 0) score += 10;
  if (rec.patchContent) score += 5;
  return score;
}

function scoreConfidence(rec: Recommendation): number {
  return Math.round((rec.confidence ?? 0) * 10);
}

/**
 * Reversibility scores the *recoverability* of the suggested change, distinct
 * from `risk` (which feeds into impact via `deriveImpact`).
 *
 * Rationale: a recommendation can be high-risk (data loss possible) but easily
 * reversible (Terraform patch can be reverted via git). Conversely, deleting a
 * production resource is low-risk for the cluster but irreversible.
 *
 * Signals (in priority order):
 *   - `suggestedAction` / `suggestedConfig.action` — destructive actions get 0
 *   - `patchContent` present → +4 (Terraform diff = git-revertible)
 *   - `risk` — fallback when no action info is available
 */
const IRREVERSIBLE_ACTIONS = new Set([
  'delete',
  'terminate',
  'terminate_and_delete_volumes',
  'release',
  'destroy',
]);
const REVERSIBLE_ACTIONS = new Set([
  'stop',
  'scale_down',
  'rightsize',
  'modify',
  'resize',
  'tag',
]);

function scoreReversibility(rec: Recommendation): number {
  const action = String(
    (rec.suggestedConfig?.['action'] as string | null | undefined) ?? (rec.suggestedAction as string | null | undefined) ?? '',
  ).toLowerCase();

  if (action && IRREVERSIBLE_ACTIONS.has(action)) return 0;

  let score = 0;
  if (action && REVERSIBLE_ACTIONS.has(action)) score += 6;
  else if (rec.risk === 'low') score += 6;
  else if (rec.risk === 'medium') score += 4;
  else if (rec.risk === 'high') score += 2;

  // Terraform patch = git-revertible
  if (rec.patchContent) score += 4;

  return Math.min(score, 10);
}
