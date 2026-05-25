/**
 * Tests --format csv|html|json wiring for the security and cost-impact headless
 * handlers (runHeadlessTextCommand + runJsonCommand).
 *
 * Uses the real CSV/HTML/JSON formatters; mocks only the pipeline steps and
 * AWS/DB layers so no external calls occur.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ─── Security pipeline mock ───────────────────────────────────────────────────

vi.mock('../../../src/cli/pipelines/security.js', () => ({
  buildSecurityPipelineSteps: vi.fn(() => [
    {
      name: 'mock security',
      completedName: 'Mock security',
      key: 'security',
      run: async () => ({ findings: [], resources_scanned: 0, total_findings: 0, dir: '.' }),
    },
  ]),
  extractSecurityFindings: vi.fn(() => ({
    findings: [
      {
        id: 'RULE001',
        title: 'S3 bucket not encrypted',
        severity: 'high' as const,
        resource: 'aws_s3_bucket.main',
        description: 'Encryption at rest is disabled',
        remediation: 'Enable default encryption',
        filePath: 'main.tf',
      },
    ],
    totalCount: 1,
    bySeverity: { high: 1 },
  })),
}));

// ─── Cost-impact pipeline mock ────────────────────────────────────────────────

vi.mock('../../../src/cli/pipelines/cost-impact.js', () => ({
  buildCostImpactPipelineSteps: vi.fn(() => [
    {
      name: 'mock cost-impact',
      completedName: 'Mock cost-impact',
      key: 'cost_impact',
      run: async () => ({
        summary: {
          netDeltaMonthlyUsd: 50,
          netDeltaAnnualUsd: 600,
          counts: { create: 1, update: 0, destroy: 0, replace: 0 },
          unpricedCount: 0,
          unknownCount: 0,
          variableCount: 0,
          skippedCount: 0,
        },
        changes: [
          {
            action: 'create',
            address: 'aws_instance.web',
            tfType: 'aws_instance',
            resourceType: 'aws_instance',
            beforeUsd: 0,
            afterUsd: 50,
            deltaUsd: 50,
            costStatus: 'known',
            triggeredRuleIds: [],
          },
        ],
        findings: [],
        warnings: [],
      }),
    },
  ]),
  extractCostImpact: vi.fn((ctx: { results: Map<string, unknown> }) => {
    type CIResult = {
      summary: {
        netDeltaMonthlyUsd: number;
        netDeltaAnnualUsd: number;
        counts: { create: number; update: number; destroy: number; replace: number };
        unpricedCount: number;
        unknownCount: number;
        variableCount: number;
        skippedCount: number;
      };
      changes: Array<{
        action: string;
        address: string;
        tfType: string;
        resourceType: string;
        beforeUsd: number;
        afterUsd: number;
        deltaUsd: number;
        costStatus: string;
        triggeredRuleIds: string[];
      }>;
      findings: Array<{
        ruleId: string;
        address: string;
        severity: 'critical' | 'high' | 'medium' | 'low';
        title: string;
        description: string;
      }>;
      warnings: string[];
    };
    return ctx.results.get('cost_impact') as CIResult;
  }),
}));

// ─── Config mock ──────────────────────────────────────────────────────────────

import type * as ConfigModule from '../../../src/config/index.js';

vi.mock('../../../src/config/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModule>();
  return {
    ...real,
    loadConfig: vi.fn().mockResolvedValue({
      version: 1,
      aws: { default_profile: '', default_region: 'us-east-1', profiles: {} },
      ai: { provider: 'none' },
      terraform: {},
      github: {},
      output: { default_format: 'json', currency: 'USD' },
      storage: {},
      scan: {},
      anomaly: {},
      quality: {},
      mcp: {},
    }),
  };
});

function makeConfig(format: 'json' | 'csv' | 'html' = 'json') {
  return {
    version: 1,
    aws: { default_profile: '', default_region: 'us-east-1', profiles: {} },
    ai: { provider: 'none' },
    terraform: {},
    github: {},
    output: { default_format: format, currency: 'USD' },
    storage: {},
    scan: {},
    anomaly: {},
    quality: {},
    mcp: {},
  };
}

import { loadConfig } from '../../../src/config/index.js';
import { runHeadlessTextCommand, runJsonCommand } from '../../../src/cli/headless.js';

// ─── Stdout / stderr capture + temp plan file ─────────────────────────────────

let stdoutBuf = '';
let stderrBuf = '';
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;
let origExitCode: number | string | undefined;

// Plan file must live within cwd to pass the path-traversal guard.
const PLAN_PATH = path.join(process.cwd(), 'headless-ci-test-plan.json');

beforeEach(() => {
  stdoutBuf = '';
  stderrBuf = '';
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origStderrWrite = process.stderr.write.bind(process.stderr);
  origExitCode = process.exitCode;
  process.stdout.write = ((chunk: unknown) => {
    stdoutBuf += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrBuf += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  vi.mocked(loadConfig).mockResolvedValue(makeConfig('json'));
  // Create a minimal plan file so fs.existsSync passes.
  fs.writeFileSync(PLAN_PATH, '{}');
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  process.exitCode = origExitCode;
  try { fs.unlinkSync(PLAN_PATH); } catch { /* already gone */ }
});

// ─── runHeadlessTextCommand — security ───────────────────────────────────────

describe('runHeadlessTextCommand("security", --format)', () => {
  it('--format csv emits CSV content to stdout', async () => {
    const result = await runHeadlessTextCommand('security', ['--format', 'csv']);
    expect(result).toBe(true);
    // Real CSV formatter header row includes the finding ID
    expect(stdoutBuf).toContain('RULE001');
    expect(stdoutBuf).not.toContain('Security scan:');
  });

  it('--format html emits HTML content to stdout', async () => {
    const result = await runHeadlessTextCommand('security', ['--format', 'html']);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('<!DOCTYPE html>');
    expect(stdoutBuf).not.toContain('Security scan:');
  });

  it('--format json falls through to human-readable text (json is not a text format)', async () => {
    const result = await runHeadlessTextCommand('security', ['--format', 'json']);
    expect(result).toBe(true);
    // --format json is a no-op in text mode: falls through to the native summary
    expect(stdoutBuf).toContain('Security scan:');
    expect(stdoutBuf).not.toContain('"recommendations"');
  });

  it('--format bogus sets exitCode 2 and writes error message to stderr', async () => {
    const result = await runHeadlessTextCommand('security', ['--format', 'bogus']);
    expect(result).toBe(true);
    expect(process.exitCode).toBe(2);
    expect(stderrBuf).toContain('Unknown format "bogus"');
    expect(stderrBuf).toContain('Use --format json|csv|html');
    expect(stdoutBuf).toBe('');
  });

  it('--format HTML (uppercase) is normalised and emits HTML', async () => {
    const result = await runHeadlessTextCommand('security', ['--format', 'HTML']);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('<!DOCTYPE html>');
    expect(stdoutBuf).not.toContain('Security scan:');
  });

  it('--format csv --output <within-cwd> writes CSV to file and confirms on stderr', async () => {
    const outPath = path.join(process.cwd(), 'sec-test-output.csv');
    try {
      const result = await runHeadlessTextCommand('security', ['--format', 'csv', '--output', outPath]);
      expect(result).toBe(true);
      expect(stdoutBuf).toBe('');
      expect(stderrBuf).toContain('CSV report written to');
      expect(fs.readFileSync(outPath, 'utf8')).toContain('RULE001');
    } finally {
      try { fs.unlinkSync(outPath); } catch { /* already gone */ }
    }
  });

  it('--output outside cwd sets exitCode 2 and writes error to stderr', async () => {
    const result = await runHeadlessTextCommand('security', ['--format', 'csv', '--output', '/tmp/out.csv']);
    expect(result).toBe(true);
    expect(process.exitCode).toBe(2);
    expect(stderrBuf).toContain('must stay within the current directory');
    expect(stdoutBuf).toBe('');
  });

  it('--fail-on partial emits a warning to stderr (not applicable to security)', async () => {
    const result = await runHeadlessTextCommand('security', ['--format', 'csv', '--fail-on', 'partial']);
    expect(result).toBe(true);
    expect(stderrBuf).toContain('--fail-on partial is not applicable to security');
    expect(process.exitCode).not.toBe(1);
  });

  it('broken config (non-ENOENT) emits warning to stderr and falls back gracefully', async () => {
    const yamlErr = Object.assign(new Error('bad YAML'), { code: 'YAML_PARSE_ERROR' });
    vi.mocked(loadConfig).mockRejectedValueOnce(yamlErr);
    const result = await runHeadlessTextCommand('security', []);
    expect(result).toBe(true);
    // Warning goes to stderr; output falls back to native text
    expect(stderrBuf).toContain('could not read config');
    expect(stdoutBuf).toContain('Security scan:');
  });

  it('no --format emits human-readable text summary (regression)', async () => {
    const result = await runHeadlessTextCommand('security', []);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('Security scan:');
  });

  it('default_format: csv in config emits CSV when no --format flag', async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce(makeConfig('csv'));
    const result = await runHeadlessTextCommand('security', []);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('RULE001');
    expect(stdoutBuf).not.toContain('Security scan:');
  });

  it('default_format: html in config emits HTML when no --format flag', async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce(makeConfig('html'));
    const result = await runHeadlessTextCommand('security', []);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('<!DOCTYPE html>');
  });
});

// ─── runHeadlessTextCommand — cost-impact ─────────────────────────────────────

describe('runHeadlessTextCommand("cost-impact", --format)', () => {
  it('--format csv emits CSV content to stdout', async () => {
    const result = await runHeadlessTextCommand('cost-impact', ['--plan-file', PLAN_PATH, '--format', 'csv']);
    expect(result).toBe(true);
    // Real CSV formatter includes the resource address in the output
    expect(stdoutBuf).toContain('aws_instance.web');
    expect(stdoutBuf).not.toContain('korinfra cost-impact');
  });

  it('--format html emits HTML content to stdout', async () => {
    const result = await runHeadlessTextCommand('cost-impact', ['--plan-file', PLAN_PATH, '--format', 'html']);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('<!DOCTYPE html>');
  });

  it('--format json falls through to human-readable text (json is not a text format)', async () => {
    const result = await runHeadlessTextCommand('cost-impact', ['--plan-file', PLAN_PATH, '--format', 'json']);
    expect(result).toBe(true);
    // --format json is a no-op in text mode: falls through to the native summary
    expect(stdoutBuf).toContain('korinfra cost-impact');
    expect(stdoutBuf).not.toContain('"scanId"');
  });

  it('--format bogus sets exitCode 2 and writes error message to stderr', async () => {
    const result = await runHeadlessTextCommand('cost-impact', ['--plan-file', PLAN_PATH, '--format', 'bogus']);
    expect(result).toBe(true);
    expect(process.exitCode).toBe(2);
    expect(stderrBuf).toContain('Unknown format "bogus"');
    expect(stderrBuf).toContain('Use --format json|csv|html');
    expect(stdoutBuf).toBe('');
  });

  it('--format HTML (uppercase) is normalised and emits HTML', async () => {
    const result = await runHeadlessTextCommand('cost-impact', ['--plan-file', PLAN_PATH, '--format', 'HTML']);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('<!DOCTYPE html>');
    expect(stdoutBuf).not.toContain('korinfra cost-impact');
  });

  it('--format csv --output <within-cwd> writes CSV to file and confirms on stderr', async () => {
    const outPath = path.join(process.cwd(), 'ci-test-output.csv');
    try {
      const result = await runHeadlessTextCommand('cost-impact', ['--plan-file', PLAN_PATH, '--format', 'csv', '--output', outPath]);
      expect(result).toBe(true);
      expect(stdoutBuf).toBe('');
      expect(stderrBuf).toContain('CSV report written to');
      expect(fs.readFileSync(outPath, 'utf8')).toContain('aws_instance.web');
    } finally {
      try { fs.unlinkSync(outPath); } catch { /* already gone */ }
    }
  });

  it('--output outside cwd sets exitCode 2 and writes error to stderr', async () => {
    const result = await runHeadlessTextCommand('cost-impact', ['--plan-file', PLAN_PATH, '--format', 'csv', '--output', '/tmp/out.csv']);
    expect(result).toBe(true);
    expect(process.exitCode).toBe(2);
    expect(stderrBuf).toContain('must stay within the current directory');
    expect(stdoutBuf).toBe('');
  });

  it('--fail-on partial emits warning to stderr (not applicable to cost-impact)', async () => {
    const result = await runHeadlessTextCommand('cost-impact', ['--plan-file', PLAN_PATH, '--format', 'csv', '--fail-on', 'partial']);
    expect(result).toBe(true);
    expect(stderrBuf).toContain('--fail-on partial is not applicable to cost-impact');
    expect(process.exitCode).not.toBe(1);
  });

  it('no --format emits human-readable text summary (regression)', async () => {
    const result = await runHeadlessTextCommand('cost-impact', ['--plan-file', PLAN_PATH]);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('korinfra cost-impact');
  });

  it('default_format: csv emits CSV when no --format flag', async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce(makeConfig('csv'));
    const result = await runHeadlessTextCommand('cost-impact', ['--plan-file', PLAN_PATH]);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('aws_instance.web');
  });
});

// ─── runJsonCommand — security ────────────────────────────────────────────────

describe('runJsonCommand("security", --format)', () => {
  it('--format csv emits CSV content and returns 0', async () => {
    const code = await runJsonCommand('security', ['--format', 'csv']);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('RULE001');
  });

  it('--format html emits HTML content and returns 0', async () => {
    const code = await runJsonCommand('security', ['--format', 'html']);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('<!DOCTYPE html>');
  });

  it('--format json falls through to JSON metadata (not formatter)', async () => {
    const code = await runJsonCommand('security', ['--format', 'json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as { command: string; status: string };
    expect(parsed.command).toBe('security');
    expect(parsed.status).toBe('completed');
  });

  it('no --format emits JSON metadata (regression)', async () => {
    const code = await runJsonCommand('security', []);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as { command: string; status: string };
    expect(parsed.command).toBe('security');
    expect(parsed.status).toBe('completed');
  });

  it('--format bogus returns 2 with JSON error payload', async () => {
    const code = await runJsonCommand('security', ['--format', 'bogus']);
    expect(code).toBe(2);
    const parsed = JSON.parse(stdoutBuf) as { command: string; status: string; error: string };
    expect(parsed.command).toBe('security');
    expect(parsed.status).toBe('error');
    expect(parsed.error).toContain('"bogus"');
  });

  it('default_format: csv emits CSV when no --format flag', async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce(makeConfig('csv'));
    const code = await runJsonCommand('security', []);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('RULE001');
  });

  it('--format csv --output <within-cwd> writes CSV to file and returns 0', async () => {
    const outPath = path.join(process.cwd(), 'json-sec-test-output.csv');
    try {
      const code = await runJsonCommand('security', ['--format', 'csv', '--output', outPath]);
      expect(code).toBe(0);
      expect(stdoutBuf).toBe('');
      expect(stderrBuf).toContain('CSV report written to');
      expect(fs.readFileSync(outPath, 'utf8')).toContain('RULE001');
    } finally {
      try { fs.unlinkSync(outPath); } catch { /* already gone */ }
    }
  });

  it('--output outside cwd returns 2 with JSON error', async () => {
    const code = await runJsonCommand('security', ['--format', 'csv', '--output', '/tmp/out.csv']);
    expect(code).toBe(2);
    const parsed = JSON.parse(stdoutBuf) as { command: string; status: string; error: string };
    expect(parsed.command).toBe('security');
    expect(parsed.status).toBe('error');
    expect(parsed.error).toContain('must stay within the current directory');
  });

  it('--fail-on partial emits warning to stderr in JSON mode', async () => {
    const code = await runJsonCommand('security', ['--format', 'csv', '--fail-on', 'partial']);
    expect(code).toBe(0);
    expect(stderrBuf).toContain('--fail-on partial is not applicable to security');
  });
});

// ─── runJsonCommand — cost-impact ─────────────────────────────────────────────

describe('runJsonCommand("cost-impact", --format)', () => {
  it('--format csv emits CSV content and returns 0', async () => {
    const code = await runJsonCommand('cost-impact', ['--plan-file', PLAN_PATH, '--format', 'csv']);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('aws_instance.web');
  });

  it('--format html emits HTML content and returns 0', async () => {
    const code = await runJsonCommand('cost-impact', ['--plan-file', PLAN_PATH, '--format', 'html']);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('<!DOCTYPE html>');
  });

  it('--format json falls through to JSON metadata', async () => {
    const code = await runJsonCommand('cost-impact', ['--plan-file', PLAN_PATH, '--format', 'json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as { command: string; status: string };
    expect(parsed.command).toBe('cost-impact');
    expect(parsed.status).toBe('completed');
  });

  it('no --format emits JSON metadata (regression)', async () => {
    const code = await runJsonCommand('cost-impact', ['--plan-file', PLAN_PATH]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as { command: string; status: string };
    expect(parsed.command).toBe('cost-impact');
    expect(parsed.status).toBe('completed');
  });

  it('--format bogus returns 2 with JSON error payload', async () => {
    const code = await runJsonCommand('cost-impact', ['--plan-file', PLAN_PATH, '--format', 'bogus']);
    expect(code).toBe(2);
    const parsed = JSON.parse(stdoutBuf) as { command: string; status: string; error: string };
    expect(parsed.command).toBe('cost-impact');
    expect(parsed.status).toBe('error');
    expect(parsed.error).toContain('"bogus"');
  });

  it('default_format: csv emits CSV when no --format flag', async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce(makeConfig('csv'));
    const code = await runJsonCommand('cost-impact', ['--plan-file', PLAN_PATH]);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('aws_instance.web');
  });

  it('--format csv --output <within-cwd> writes CSV to file and returns 0', async () => {
    const outPath = path.join(process.cwd(), 'json-ci-test-output.csv');
    try {
      const code = await runJsonCommand('cost-impact', ['--plan-file', PLAN_PATH, '--format', 'csv', '--output', outPath]);
      expect(code).toBe(0);
      expect(stdoutBuf).toBe('');
      expect(stderrBuf).toContain('CSV report written to');
      expect(fs.readFileSync(outPath, 'utf8')).toContain('aws_instance.web');
    } finally {
      try { fs.unlinkSync(outPath); } catch { /* already gone */ }
    }
  });

  it('--output outside cwd returns 2 with JSON error', async () => {
    const code = await runJsonCommand('cost-impact', ['--plan-file', PLAN_PATH, '--format', 'csv', '--output', '/tmp/out.csv']);
    expect(code).toBe(2);
    const parsed = JSON.parse(stdoutBuf) as { command: string; status: string; error: string };
    expect(parsed.command).toBe('cost-impact');
    expect(parsed.status).toBe('error');
    expect(parsed.error).toContain('must stay within the current directory');
  });

  it('--fail-on partial emits warning to stderr in JSON mode', async () => {
    const code = await runJsonCommand('cost-impact', ['--plan-file', PLAN_PATH, '--format', 'csv', '--fail-on', 'partial']);
    expect(code).toBe(0);
    expect(stderrBuf).toContain('--fail-on partial is not applicable to cost-impact');
  });
});
