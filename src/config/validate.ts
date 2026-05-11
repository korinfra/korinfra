import type { Config } from './types.js';

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`config validation failed:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Validates the loaded Config for invalid or inconsistent values.
 * ai.provider is already enforced by z.enum() in the Zod schema — no runtime
 * allowlist check needed here. Only storage.path requires a post-parse check
 * because its default is '' and the path is auto-filled after Zod parsing.
 * Cross-field validation for thresholds happens here.
 */
export function validate(cfg: Config): void {
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

  if (errs.length > 0) {
    throw new ConfigValidationError(errs);
  }
}
