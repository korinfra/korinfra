import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { defaults, validate, normalizeStringSlice, loadConfig } from '../../../src/config/index.js';
import { ConfigValidationError } from '../../../src/config/index.js';

// ── validate() ───────────────────────────────────────────────────────────────

describe('validate()', () => {
  it('accepts valid defaults config', () => {
    expect(() => validate(defaults())).not.toThrow();
  });

  it('accepts all valid provider values', () => {
    for (const provider of ['none', 'claude', 'anthropic', '']) {
      const cfg = { ...defaults(), ai: { ...defaults().ai, provider } };
      expect(() => validate(cfg), `provider: ${provider}`).not.toThrow();
    }
  });

  it('throws when storage.path is empty or whitespace-only, with issues array', () => {
    for (const path of ['', '   ']) {
      const cfg = { ...defaults(), storage: { ...defaults().storage, path } };
      let caught: ConfigValidationError | undefined;
      try { validate(cfg); } catch (e) { caught = e as ConfigValidationError; }
      expect(caught, `path="${path}"`).toBeInstanceOf(ConfigValidationError);
      expect(caught!.issues).toContain('storage.path: must not be empty');
    }
  });

  it('throws when impact_medium_threshold >= impact_high_threshold', () => {
    const cfg = {
      ...defaults(),
      scan: { ...defaults().scan, impact_high_threshold: 100, impact_medium_threshold: 150 },
    };
    let caught: ConfigValidationError | undefined;
    try { validate(cfg); } catch (e) { caught = e as ConfigValidationError; }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught!.issues[0]).toContain('scan.impact_medium_threshold must be less than scan.impact_high_threshold');
  });

  it('throws when impact_medium_threshold equals impact_high_threshold', () => {
    const cfg = {
      ...defaults(),
      scan: { ...defaults().scan, impact_high_threshold: 100, impact_medium_threshold: 100 },
    };
    let caught: ConfigValidationError | undefined;
    try { validate(cfg); } catch (e) { caught = e as ConfigValidationError; }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught!.issues[0]).toContain('scan.impact_medium_threshold must be less than scan.impact_high_threshold');
  });

  it('accepts when impact_medium_threshold < impact_high_threshold', () => {
    const cfg = {
      ...defaults(),
      scan: { ...defaults().scan, impact_high_threshold: 100, impact_medium_threshold: 25 },
    };
    expect(() => validate(cfg)).not.toThrow();
  });

  it('throws when anomaly z-score thresholds are not in ascending order', () => {
    const cfg = {
      ...defaults(),
      anomaly: {
        ...defaults().anomaly,
        z_score_threshold: 2.0,
        medium_z_score: 2.5,
        high_z_score: 2.0, // invalid: high < medium
        critical_z_score: 4.0,
      },
    };
    let caught: ConfigValidationError | undefined;
    try { validate(cfg); } catch (e) { caught = e as ConfigValidationError; }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught!.issues[0]).toContain('anomaly z-score thresholds must be in ascending order');
  });

  it('accepts when anomaly z-score thresholds are in ascending order', () => {
    const cfg = {
      ...defaults(),
      anomaly: {
        ...defaults().anomaly,
        z_score_threshold: 2.0,
        medium_z_score: 2.5,
        high_z_score: 3.0,
        critical_z_score: 4.0,
      },
    };
    expect(() => validate(cfg)).not.toThrow();
  });

  it('accepts when anomaly z-score thresholds are equal (edge case)', () => {
    const cfg = {
      ...defaults(),
      anomaly: {
        ...defaults().anomaly,
        z_score_threshold: 2.0,
        medium_z_score: 2.0,
        high_z_score: 2.0,
        critical_z_score: 2.0,
      },
    };
    expect(() => validate(cfg)).not.toThrow();
  });

  // ── EC2 CPU thresholds ──────────────────────────────────────────────────────

  it('throws when rightsize_cpu_threshold < idle_cpu_threshold with both values in message', () => {
    const cfg = {
      ...defaults(),
      scan: { ...defaults().scan, idle_cpu_threshold: 20.0, rightsize_cpu_threshold: 10.0 },
    };
    let caught: ConfigValidationError | undefined;
    try { validate(cfg); } catch (e) { caught = e as ConfigValidationError; }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught!.issues[0]).toContain('scan.rightsize_cpu_threshold (10)');
    expect(caught!.issues[0]).toContain('scan.idle_cpu_threshold (20)');
  });

  it('throws when rightsize_cpu_threshold equals idle_cpu_threshold', () => {
    const cfg = {
      ...defaults(),
      scan: { ...defaults().scan, idle_cpu_threshold: 10.0, rightsize_cpu_threshold: 10.0 },
    };
    let caught: ConfigValidationError | undefined;
    try { validate(cfg); } catch (e) { caught = e as ConfigValidationError; }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught!.issues[0]).toContain('scan.rightsize_cpu_threshold');
  });

  it('accepts when rightsize_cpu_threshold > idle_cpu_threshold', () => {
    const cfg = {
      ...defaults(),
      scan: { ...defaults().scan, idle_cpu_threshold: 5.0, rightsize_cpu_threshold: 30.0 },
    };
    expect(() => validate(cfg)).not.toThrow();
  });

  // ── RDS CPU thresholds ──────────────────────────────────────────────────────

  it('throws when rds_rightsize_cpu_threshold <= rds_idle_cpu_threshold', () => {
    const cfg = {
      ...defaults(),
      scan: { ...defaults().scan, rds_idle_cpu_threshold: 5.0, rds_rightsize_cpu_threshold: 5.0 },
    };
    let caught: ConfigValidationError | undefined;
    try { validate(cfg); } catch (e) { caught = e as ConfigValidationError; }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught!.issues[0]).toContain('scan.rds_rightsize_cpu_threshold');
  });

  it('accepts when rds_rightsize_cpu_threshold > rds_idle_cpu_threshold', () => {
    const cfg = {
      ...defaults(),
      scan: { ...defaults().scan, rds_idle_cpu_threshold: 1.0, rds_rightsize_cpu_threshold: 15.0 },
    };
    expect(() => validate(cfg)).not.toThrow();
  });

  // ── Scenario confidence bounds ──────────────────────────────────────────────

  it('throws when scenario_confidence_base > scenario_confidence_max', () => {
    const cfg = {
      ...defaults(),
      scan: { ...defaults().scan, scenario_confidence_base: 0.96, scenario_confidence_max: 0.95 },
    };
    let caught: ConfigValidationError | undefined;
    try { validate(cfg); } catch (e) { caught = e as ConfigValidationError; }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught!.issues[0]).toContain('scan.scenario_confidence_base');
  });

  it('throws when scenario_confidence_state_base > scenario_confidence_max', () => {
    const cfg = {
      ...defaults(),
      scan: { ...defaults().scan, scenario_confidence_state_base: 0.99, scenario_confidence_max: 0.95 },
    };
    let caught: ConfigValidationError | undefined;
    try { validate(cfg); } catch (e) { caught = e as ConfigValidationError; }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught!.issues[0]).toContain('scan.scenario_confidence_state_base');
  });

  // ── ai.api_key_env ──────────────────────────────────────────────────────────

  it('throws when ai.api_key_env is an empty string', () => {
    const cfg = { ...defaults(), ai: { ...defaults().ai, api_key_env: '' } };
    let caught: ConfigValidationError | undefined;
    try { validate(cfg); } catch (e) { caught = e as ConfigValidationError; }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught!.issues).toContain('ai.api_key_env must not be empty');
  });

  // ── Quality score label thresholds ─────────────────────────────────────────

  it('throws when quality.excellent_threshold <= good_threshold', () => {
    const cfg = {
      ...defaults(),
      quality: { ...defaults().quality, excellent_threshold: 70, good_threshold: 70, fair_threshold: 50 },
    };
    let caught: ConfigValidationError | undefined;
    try { validate(cfg); } catch (e) { caught = e as ConfigValidationError; }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught!.issues[0]).toContain('quality score thresholds');
  });

  it('throws when quality.good_threshold <= fair_threshold', () => {
    const cfg = {
      ...defaults(),
      quality: { ...defaults().quality, excellent_threshold: 85, good_threshold: 50, fair_threshold: 50 },
    };
    let caught: ConfigValidationError | undefined;
    try { validate(cfg); } catch (e) { caught = e as ConfigValidationError; }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught!.issues[0]).toContain('quality score thresholds');
  });

  // ── Quality savings tier cutoffs ────────────────────────────────────────────

  it('throws when quality.savings_tier_high <= savings_tier_medium', () => {
    const cfg = {
      ...defaults(),
      quality: { ...defaults().quality, savings_tier_high: 100, savings_tier_medium: 100, savings_tier_low: 20 },
    };
    let caught: ConfigValidationError | undefined;
    try { validate(cfg); } catch (e) { caught = e as ConfigValidationError; }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught!.issues[0]).toContain('quality.savings_tier cutoffs');
  });

  // ── Quality savings percentage tiers ───────────────────────────────────────

  it('throws when quality.savings_pct_high <= savings_pct_medium', () => {
    const cfg = {
      ...defaults(),
      quality: { ...defaults().quality, savings_pct_high: 0.05, savings_pct_medium: 0.05 },
    };
    let caught: ConfigValidationError | undefined;
    try { validate(cfg); } catch (e) { caught = e as ConfigValidationError; }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught!.issues[0]).toContain('quality.savings_pct_high');
  });

  // ── Quality length windows ──────────────────────────────────────────────────

  it('throws when quality.title_min_length >= title_max_length', () => {
    const cfg = {
      ...defaults(),
      quality: { ...defaults().quality, title_min_length: 80, title_max_length: 80 },
    };
    let caught: ConfigValidationError | undefined;
    try { validate(cfg); } catch (e) { caught = e as ConfigValidationError; }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught!.issues[0]).toContain('quality.title_min_length');
  });

  it('throws when quality.description_partial_length >= description_full_length', () => {
    const cfg = {
      ...defaults(),
      quality: { ...defaults().quality, description_partial_length: 80, description_full_length: 80 },
    };
    let caught: ConfigValidationError | undefined;
    try { validate(cfg); } catch (e) { caught = e as ConfigValidationError; }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught!.issues[0]).toContain('quality.description_partial_length');
  });

  // ── include_idle warning ────────────────────────────────────────────────────

  it('returns warning when include_idle is false', () => {
    const cfg = { ...defaults(), scan: { ...defaults().scan, include_idle: false } };
    const warnings = validate(cfg);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('scan.include_idle is false');
  });

  it('returns empty warnings array when include_idle is true', () => {
    const cfg = { ...defaults(), scan: { ...defaults().scan, include_idle: true } };
    const warnings = validate(cfg);
    expect(warnings).toEqual([]);
  });

  // ── Multiple errors collected before throw ─────────────────────────────────

  it('collects multiple errors before throwing — does not short-circuit', () => {
    const cfg = {
      ...defaults(),
      scan: {
        ...defaults().scan,
        // EC2 thresholds inverted
        idle_cpu_threshold: 30.0,
        rightsize_cpu_threshold: 5.0,
      },
      quality: {
        ...defaults().quality,
        // Quality score thresholds inverted
        excellent_threshold: 50,
        good_threshold: 70,
        fair_threshold: 85,
      },
    };
    let caught: ConfigValidationError | undefined;
    try { validate(cfg); } catch (e) { caught = e as ConfigValidationError; }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    expect(caught!.issues.length).toBeGreaterThanOrEqual(2);
  });
});

// ── normalizeStringSlice() ────────────────────────────────────────────────────

describe('normalizeStringSlice()', () => {
  it('returns empty array for null, undefined, and empty string', () => {
    expect(normalizeStringSlice(null)).toEqual([]);
    expect(normalizeStringSlice(undefined)).toEqual([]);
    expect(normalizeStringSlice('')).toEqual([]);
  });

  it('splits comma, semicolon, and newline delimiters and trims whitespace', () => {
    expect(normalizeStringSlice('tag1,tag2,tag3')).toEqual(['tag1', 'tag2', 'tag3']);
    expect(normalizeStringSlice('tag1, tag2 ,  tag3  ')).toEqual(['tag1', 'tag2', 'tag3']);
    expect(normalizeStringSlice('tag1;tag2;tag3')).toEqual(['tag1', 'tag2', 'tag3']);
    expect(normalizeStringSlice('tag1\ntag2\ntag3')).toEqual(['tag1', 'tag2', 'tag3']);
    expect(normalizeStringSlice('a,b;c\nd')).toEqual(['a', 'b', 'c', 'd']);
    expect(normalizeStringSlice('a,,b')).toEqual(['a', 'b']);
  });

  it('handles array inputs: preserves, trims, filters empties, coerces non-strings', () => {
    expect(normalizeStringSlice(['tag1', 'tag2', 'tag3'])).toEqual(['tag1', 'tag2', 'tag3']);
    expect(normalizeStringSlice(['  a  ', 'b', '  c'])).toEqual(['a', 'b', 'c']);
    expect(normalizeStringSlice(['a', '', 'b'])).toEqual(['a', 'b']);
    expect(normalizeStringSlice([1, 2, 3] as unknown as string[])).toEqual(['1', '2', '3']);
  });

});

// ── loadConfig() env var overrides ───────────────────────────────────────────

describe('loadConfig() — env var overrides and provider normalization', () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;
  let originalCwd: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'korinfra-test-'));
    fs.mkdirSync(path.join(tmpDir, '.korinfra'));
    fs.writeFileSync(
      path.join(tmpDir, '.korinfra', 'config.yaml'),
      'ai:\n  provider: none\n',
      'utf8',
    );
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('KORINFRA_')) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('normalizes the anthropic alias to claude', async () => {
    process.env['KORINFRA_AI__PROVIDER'] = 'anthropic';
    const cfg = await loadConfig();
    expect(cfg.ai.provider).toBe('claude');
  });

  it('rejects unsupported providers with a clear error message', async () => {
    for (const provider of ['openai', 'ollama', 'local'] as const) {
      process.env['KORINFRA_AI__PROVIDER'] = provider;
      await expect(loadConfig()).rejects.toThrow(/is not yet implemented|is not supported/);
      delete process.env['KORINFRA_AI__PROVIDER'];
    }
  });

  it('applies numeric and boolean coercions from env vars', async () => {
    process.env['KORINFRA_OUTPUT__VERBOSE'] = 'true';
    process.env['KORINFRA_SCAN__LOOKBACK_DAYS'] = '60';
    const cfg = await loadConfig();
    expect(cfg.output.verbose).toBe(true);
    expect(cfg.scan.lookback_days).toBe(60);
  });

  it('normalizes comma-separated required_tags string to array', async () => {
    process.env['KORINFRA_SCAN__REQUIRED_TAGS'] = 'CostCenter,Owner,Project';
    const cfg = await loadConfig();
    expect(cfg.scan.required_tags).toEqual(['CostCenter', 'Owner', 'Project']);
  });

  it('ignores unrecognized KORINFRA_ env keys without throwing', async () => {
    process.env['KORINFRA_UNKNOWN__KEY'] = 'value';
    await expect(loadConfig()).resolves.toBeTruthy();
  });
});
