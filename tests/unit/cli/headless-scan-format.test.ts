/**
 * Tests --format csv|html|json and output.default_format wiring in the
 * headless scan handlers (runHeadlessTextCommand + runJsonCommand).
 *
 * Mocks the scan and report pipelines so no AWS calls or DB writes occur.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Scan pipeline mock ───────────────────────────────────────────────────────

vi.mock('../../../src/cli/pipelines/scan.js', () => ({
  buildScanPipelineSteps: vi.fn(() => [
    {
      name: 'mock scan',
      completedName: 'Mock scan',
      key: 'save',
      run: async () => ({ scan_id: 'test-scan-abc', total_cost: 42.5 }),
    },
  ]),
  extractScanSummary: vi.fn(() => ({
    resourceCount: 3,
    totalMonthlyCostUsd: 42.5,
    recommendationCount: 2,
    anomalyCount: 0,
    durationMs: 100,
    scanId: 'test-scan-abc',
    partial: false,
    errorCount: 0,
    failedRegions: [],
    unknownCostCount: 0,
    warnings: [],
  })),
  extractRecommendations: vi.fn(() => []),
}));

// ─── Report pipeline mock ─────────────────────────────────────────────────────

vi.mock('../../../src/cli/pipelines/report.js', () => ({
  buildReportPipelineSteps: vi.fn((opts: { format?: string }) => [
    {
      name: 'mock report',
      completedName: 'Mock report',
      key: 'report',
      run: async () => {
        const fmt = opts.format ?? 'json';
        let content: string;
        if (fmt === 'csv') {
          content = 'section,field,value\nsummary,scan_id,test-scan-abc\n';
        } else if (fmt === 'html') {
          content = '<!DOCTYPE html><html><body>Mock HTML Report</body></html>';
        } else {
          content = '{"scanId":"test-scan-abc","summary":{"totalResources":3}}';
        }
        return { format: fmt, content, written: false, size: content.length };
      },
    },
  ]),
  extractReportResult: vi.fn((ctx: { results: Map<string, unknown> }) => {
    const report = ctx.results.get('report') as {
      format: string; content: string; written: boolean; size: number;
    } | undefined;
    return {
      format: report?.format ?? 'json',
      content: report?.content,
      written: false,
      size: report?.size ?? 0,
      resourceCount: 3,
      totalCost: 42.5,
      recommendationCount: 2,
    };
  }),
}));

// ─── Config mock ──────────────────────────────────────────────────────────────
// NOTE: vi.mock factories are hoisted before variable declarations, so all
// values used inside the factory must be inlined — no outer-scope constants.

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
      output: { default_format: 'json' },
      storage: {},
      scan: {},
      anomaly: {},
      quality: {},
      mcp: {},
    }),
  };
});

// Function declaration (fully hoisted) — safe to use in beforeEach resets.
function makeConfig(format: 'json' | 'csv' | 'html' = 'json') {
  return {
    version: 1,
    aws: { default_profile: '', default_region: 'us-east-1', profiles: {} },
    ai: { provider: 'none' },
    terraform: {},
    github: {},
    output: { default_format: format },
    storage: {},
    scan: {},
    anomaly: {},
    quality: {},
    mcp: {},
  };
}

import { loadConfig } from '../../../src/config/index.js';
import { extractRecommendations } from '../../../src/cli/pipelines/scan.js';
import { buildReportPipelineSteps } from '../../../src/cli/pipelines/report.js';
import { runHeadlessTextCommand, runJsonCommand } from '../../../src/cli/headless.js';

// ─── Stdout / stderr capture ─────────────────────────────────────────────────

let stdoutBuf = '';
let stderrBuf = '';
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;
let origExitCode: number | string | undefined;

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
  // Reset loadConfig to default (json) between tests
  vi.mocked(loadConfig).mockResolvedValue(makeConfig('json'));
  // Reset recs to empty (no criticals) between tests
  vi.mocked(extractRecommendations).mockReturnValue([]);
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  process.exitCode = origExitCode;
});

// ─── runHeadlessTextCommand ───────────────────────────────────────────────────

describe('runHeadlessTextCommand("scan", --format)', () => {
  it('--format csv emits CSV content to stdout', async () => {
    const result = await runHeadlessTextCommand('scan', ['--format', 'csv']);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('section,field,value');
    expect(stdoutBuf).toContain('test-scan-abc');
    // Must not include the text-summary header
    expect(stdoutBuf).not.toContain('korinfra scan');
  });

  it('--format html emits HTML content to stdout', async () => {
    const result = await runHeadlessTextCommand('scan', ['--format', 'html']);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('<!DOCTYPE html>');
    expect(stdoutBuf).not.toContain('korinfra scan');
  });

  it('--format json falls through to human-readable text (json is not a text format)', async () => {
    const result = await runHeadlessTextCommand('scan', ['--format', 'json']);
    expect(result).toBe(true);
    // --format json is a no-op in text mode: falls through to the native summary
    expect(stdoutBuf).toContain('korinfra scan');
    expect(stdoutBuf).not.toContain('"scanId"');
  });

  it('--format bogus sets exitCode 2 and writes an error message to stderr', async () => {
    const result = await runHeadlessTextCommand('scan', ['--format', 'bogus']);
    expect(result).toBe(true);
    expect(process.exitCode).toBe(2);
    expect(stderrBuf).toContain('Unknown format "bogus"');
    expect(stderrBuf).toContain('Use --format json|csv|html');
    expect(stdoutBuf).toBe('');
  });

  it('--format CSV (uppercase) is normalised and emits CSV', async () => {
    const result = await runHeadlessTextCommand('scan', ['--format', 'CSV']);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('section,field,value');
    expect(stdoutBuf).not.toContain('korinfra scan');
  });

  it('report pipeline failure emits clean error to stderr and sets exitCode 1', async () => {
    vi.mocked(buildReportPipelineSteps).mockImplementationOnce(() => [
      {
        name: 'fail',
        completedName: 'Fail',
        key: 'report',
        run: async () => { throw new Error('DB connection lost'); },
      },
    ]);
    const result = await runHeadlessTextCommand('scan', ['--format', 'csv']);
    expect(result).toBe(true);
    expect(stderrBuf).toContain('Report generation failed');
    expect(stderrBuf).toContain('DB connection lost');
    expect(process.exitCode).toBe(1);
  });

  it('broken config (non-ENOENT) emits warning to stderr and falls back gracefully', async () => {
    const yamlErr = Object.assign(new Error('bad YAML'), { code: 'YAML_PARSE_ERROR' });
    vi.mocked(loadConfig).mockRejectedValueOnce(yamlErr);
    const result = await runHeadlessTextCommand('scan', []);
    expect(result).toBe(true);
    expect(stderrBuf).toContain('could not read config');
    expect(stdoutBuf).toContain('korinfra scan');
  });

  it('no --format emits the human-readable text summary (regression)', async () => {
    const result = await runHeadlessTextCommand('scan', []);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('korinfra scan');
    expect(stdoutBuf).toContain('Status: completed');
    expect(stdoutBuf).toContain('Resources: 3');
  });

  it('default_format: csv in config emits CSV when no --format flag', async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce(makeConfig('csv'));
    const result = await runHeadlessTextCommand('scan', []);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('section,field,value');
    expect(stdoutBuf).not.toContain('korinfra scan');
  });

  it('default_format: html in config emits HTML when no --format flag', async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce(makeConfig('html'));
    const result = await runHeadlessTextCommand('scan', []);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('<!DOCTYPE html>');
  });

  it('--format csv --fail-on critical sets exitCode 1 when criticals present', async () => {
    vi.mocked(extractRecommendations).mockReturnValueOnce([
      {
        id: 'r1', title: 'Stop idle instance', description: '',
        impact: 'critical', risk: 'low',
        estimatedSavingsUsd: 200, confidence: 0.9,
      },
    ]);
    const result = await runHeadlessTextCommand('scan', ['--format', 'csv', '--fail-on', 'critical']);
    expect(result).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(stdoutBuf).toContain('section,field,value');
  });

  it('--format csv --fail-on critical keeps default exitCode when no criticals', async () => {
    // extractRecommendations returns [] (no criticals) — reset in beforeEach
    const result = await runHeadlessTextCommand('scan', ['--format', 'csv', '--fail-on', 'critical']);
    expect(result).toBe(true);
    expect(process.exitCode).not.toBe(1);
    expect(stdoutBuf).toContain('section,field,value');
  });
});

// ─── runJsonCommand ───────────────────────────────────────────────────────────

describe('runJsonCommand("scan", --format)', () => {
  it('--format csv emits CSV content to stdout and returns 0', async () => {
    const code = await runJsonCommand('scan', ['--format', 'csv']);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('section,field,value');
    expect(stdoutBuf).toContain('test-scan-abc');
  });

  it('--format html emits HTML content to stdout and returns 0', async () => {
    const code = await runJsonCommand('scan', ['--format', 'html']);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('<!DOCTYPE html>');
  });

  it('--format json falls through to JSON metadata output (not formatter)', async () => {
    const code = await runJsonCommand('scan', ['--format', 'json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as { command: string; status: string };
    expect(parsed.command).toBe('scan');
    expect(parsed.status).toBe('completed');
  });

  it('no --format emits JSON metadata (regression)', async () => {
    const code = await runJsonCommand('scan', []);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      command: string; status: string;
      summary: { resources: number };
    };
    expect(parsed.command).toBe('scan');
    expect(parsed.status).toBe('completed');
    expect(parsed.summary.resources).toBe(3);
  });

  it('--format CSV (uppercase) in JSON mode is normalised and emits CSV', async () => {
    const code = await runJsonCommand('scan', ['--format', 'CSV']);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('section,field,value');
  });

  it('--format bogus returns 2 with a JSON error payload', async () => {
    const code = await runJsonCommand('scan', ['--format', 'bogus']);
    expect(code).toBe(2);
    const parsed = JSON.parse(stdoutBuf) as { command: string; status: string; error: string };
    expect(parsed.command).toBe('scan');
    expect(parsed.status).toBe('error');
    expect(parsed.error).toContain('"bogus"');
  });

  it('report pipeline failure emits error to stderr and returns 1', async () => {
    vi.mocked(buildReportPipelineSteps).mockImplementationOnce(() => [
      {
        name: 'fail',
        completedName: 'Fail',
        key: 'report',
        run: async () => { throw new Error('storage unavailable'); },
      },
    ]);
    const code = await runJsonCommand('scan', ['--format', 'csv']);
    expect(code).toBe(1);
    expect(stderrBuf).toContain('Report generation failed');
    expect(stderrBuf).toContain('storage unavailable');
  });

  it('--format csv --fail-on critical returns 1 when criticals present', async () => {
    vi.mocked(extractRecommendations).mockReturnValueOnce([
      {
        id: 'r1', title: 'Stop idle instance', description: '',
        impact: 'critical', risk: 'low',
        estimatedSavingsUsd: 200, confidence: 0.9,
      },
    ]);
    const code = await runJsonCommand('scan', ['--format', 'csv', '--fail-on', 'critical']);
    expect(code).toBe(1);
    expect(stdoutBuf).toContain('section,field,value');
  });

  it('--format csv --fail-on critical returns 0 when no criticals', async () => {
    const code = await runJsonCommand('scan', ['--format', 'csv', '--fail-on', 'critical']);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('section,field,value');
  });

  it('default_format: csv in config emits CSV when no --format flag', async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce(makeConfig('csv'));
    const code = await runJsonCommand('scan', []);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('section,field,value');
  });
});
