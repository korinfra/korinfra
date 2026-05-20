import type { Config } from './types.js';

function assertOrdering(
  valA: number,
  nameA: string,
  op: '<=' | '<',
  valB: number,
  nameB: string,
  errs: string[],
): void {
  const passes = op === '<=' ? valA <= valB : valA < valB;
  if (!passes) {
    errs.push(
      `${nameA} (${valA}) must be ${op === '<=' ? 'less than or equal to' : 'less than'} ${nameB} (${valB})`,
    );
  }
}

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`config validation failed:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Validates the loaded Config for invalid or inconsistent values.
 * ai.provider is already enforced by z.enum() in the Zod schema — no runtime
 * allowlist check needed here. storage.path is set to defaultStoragePath() by
 * defaults(), but loadConfig() auto-fills it only when the parsed value is
 * falsy (e.g. the config file explicitly sets an empty path or no file exists),
 * so a post-parse emptiness check is still required here.
 * Cross-field validation for thresholds happens here.
 *
 * @returns Non-fatal warning strings (threshold combinations that are valid but
 *          potentially confusing). Callers should log these; they are not thrown.
 */
export function validate(cfg: Config): string[] {
  const errs: string[] = [];

  if (!cfg.storage.path || cfg.storage.path.trim() === '') {
    errs.push('storage.path: must not be empty');
  }

  // Cross-field validation: impact thresholds must be in ascending order
  if (cfg.scan.impact_medium_threshold >= cfg.scan.impact_high_threshold) {
    errs.push('scan.impact_medium_threshold must be less than scan.impact_high_threshold');
  }

  // Cross-field validation: anomaly z-score thresholds must be in ascending order
  if (
    cfg.anomaly.z_score_threshold > cfg.anomaly.medium_z_score ||
    cfg.anomaly.medium_z_score > cfg.anomaly.high_z_score ||
    cfg.anomaly.high_z_score > cfg.anomaly.critical_z_score
  ) {
    errs.push(
      'anomaly z-score thresholds must be in ascending order: z_score_threshold ≤ medium_z_score ≤ high_z_score ≤ critical_z_score'
    );
  }

  // ── Scan: CPU threshold ordering ───────────────────────────────────────────
  assertOrdering(cfg.scan.idle_cpu_threshold, 'scan.idle_cpu_threshold', '<', cfg.scan.rightsize_cpu_threshold, 'scan.rightsize_cpu_threshold', errs);
  assertOrdering(cfg.scan.rds_idle_cpu_threshold, 'scan.rds_idle_cpu_threshold', '<', cfg.scan.rds_rightsize_cpu_threshold, 'scan.rds_rightsize_cpu_threshold', errs);

  // ── Scan: scenario confidence bounds ───────────────────────────────────────
  assertOrdering(cfg.scan.scenario_confidence_base, 'scan.scenario_confidence_base', '<=', cfg.scan.scenario_confidence_max, 'scan.scenario_confidence_max', errs);
  assertOrdering(cfg.scan.scenario_confidence_state_base, 'scan.scenario_confidence_state_base', '<=', cfg.scan.scenario_confidence_max, 'scan.scenario_confidence_max', errs);

  // ── AI: api_key_env must not be empty ──────────────────────────────────────
  if (!cfg.ai.api_key_env || cfg.ai.api_key_env.trim() === '') {
    errs.push('ai.api_key_env must not be empty');
  }

  // ── Quality: score label thresholds must descend ───────────────────────────
  if (
    cfg.quality.excellent_threshold <= cfg.quality.good_threshold ||
    cfg.quality.good_threshold <= cfg.quality.fair_threshold
  ) {
    errs.push(
      'quality score thresholds must be in descending order: excellent_threshold > good_threshold > fair_threshold'
    );
  }

  // ── Quality: savings tier cutoffs must descend ─────────────────────────────
  if (
    cfg.quality.savings_tier_high <= cfg.quality.savings_tier_medium ||
    cfg.quality.savings_tier_medium <= cfg.quality.savings_tier_low
  ) {
    errs.push(
      'quality.savings_tier cutoffs must be in descending order: savings_tier_high > savings_tier_medium > savings_tier_low'
    );
  }

  // ── Quality: savings percentage tiers must be ordered ─────────────────────
  assertOrdering(cfg.quality.savings_pct_medium, 'quality.savings_pct_medium', '<', cfg.quality.savings_pct_high, 'quality.savings_pct_high', errs);

  // ── Quality: description and title length windows ──────────────────────────
  assertOrdering(cfg.quality.title_min_length, 'quality.title_min_length', '<', cfg.quality.title_max_length, 'quality.title_max_length', errs);
  assertOrdering(cfg.quality.description_partial_length, 'quality.description_partial_length', '<', cfg.quality.description_full_length, 'quality.description_full_length', errs);

  // ── Warnings (non-fatal) ───────────────────────────────────────────────────
  const warnings: string[] = [];
  if (!cfg.scan.include_idle) {
    warnings.push(
      'scan.idle_cpu_threshold is configured but may have no effect because scan.include_idle is false'
    );
  }

  if (errs.length > 0) {
    throw new ConfigValidationError(errs);
  }
  return warnings;
}
