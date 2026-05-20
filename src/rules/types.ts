/**
 * Cost-gating classification (#44 Item 2).
 *
 * - `strict`: rule emits a recommendation only when `monthly_cost` is known.
 *   Uses `getMonthlyCostStrict()` and skips with a warning otherwise so it
 *   never surfaces an `estimatedSavings: $0` recommendation.
 * - `security`: rule's primary value is a security / compliance / reliability
 *   fix. An `estimatedSavings: $0` is legitimate (the user benefits from the
 *   fix even without a savings figure).
 * - `fixed-rate`: rule has a reliable fallback (fixed AWS rate or multi-tier
 *   pricing) so missing `monthly_cost` doesn't break the savings estimate.
 * - `cost-graduated`: rule's savings depend on `monthly_cost` but it currently
 *   uses non-strict `getMonthlyCost()` (returning $0 when missing). Candidates
 *   for future strict gating; out of scope for #44.
 */
export type CostGating = 'strict' | 'security' | 'fixed-rate' | 'cost-graduated';

/** Static metadata for a built-in cost optimization rule. */
export interface RuleInfo {
  id: string;
  category: string;
  title: string;
  description: string;
  impact: 'low' | 'medium' | 'high';
  risk: 'low' | 'medium' | 'high';
  /** See `CostGating` — informational, used by dashboards and the registry invariant test. */
  costGating?: CostGating;
}

/** Per-resource diagnostic emitted by a rule when it skips evaluation. */
export interface RuleWarning {
  ruleId: string;
  resourceId: string;
  resourceType: string;
  reason: string;
}

/** Context passed to rule functions for accumulating warnings. */
export interface RuleContext {
  warn(ruleId: string, resourceId: string, resourceType: string, reason: string): void;
}

/**
 * Canonical reason strings emitted by rule warnings. Centralised so the
 * `unknownCostCount` filter in `scan.ts` and downstream JSON consumers can
 * pivot on a stable vocabulary without scattering magic strings across files.
 */
export const RULE_WARN_REASONS = {
  MISSING_COST: 'monthly_cost missing or invalid',
  MISSING_COST_AND_SIZE: 'monthly_cost missing and size_gb unavailable',
  DDB_NON_FINITE: 'consumed capacity is non-finite',
  DDB_ZERO_CAPACITY: 'zero provisioned and zero consumed capacity (paused or new table)',
  S3_LIFECYCLE_UNKNOWN: 'lifecycle state could not be determined (transient API failure)',
  S3_LIFECYCLE_TIERING_UNKNOWN: 'lifecycle or intelligent-tiering state could not be determined',
  S3_LIFECYCLE_COUNT_UNKNOWN: 'lifecycle_rules_count could not be determined',
  S3_VERSIONING_UNKNOWN: 'versioning state could not be determined',
  S3_ENCRYPTION_UNKNOWN: 'encryption state could not be determined',
} as const;

export type { Recommendation } from '../classifier/types.js';
