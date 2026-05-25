/**
 * Tests --format csv|html|json wiring for the recommend headless handlers
 * (runHeadlessTextCommand + runJsonCommand) — default DB path only.
 *
 * Uses the real CSV/HTML/JSON formatters; mocks only the DB queries and
 * storage layer so no database is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// ─── DB query mock ────────────────────────────────────────────────────────────

vi.mock('../../../src/storage/queries/recommendations.js', () => ({
  listPendingRecommendations: vi.fn(() => [
    {
      id: 'rec-001',
      scan_id: 'scan-abc',
      resource_id: 'aws_instance.web',
      resource_type: 'aws_instance',
      type: 'rightsizing',
      title: 'Downsize underutilised instance',
      description: 'CPU utilisation is below 5% for 30 days',
      impact: 'high',
      risk: 'low',
      estimated_savings: 120,
      status: 'open',
      confidence: 0.9,
    },
  ]),
  getRecommendationById: vi.fn(),
  listRecommendations: vi.fn(() => []),
}));

// ─── DB / storage mock ────────────────────────────────────────────────────────

vi.mock('../../../src/storage/index.js', () => ({
  getDb: vi.fn(() => ({})),
  insertScan: vi.fn(),
  upsertRecommendations: vi.fn(),
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
  vi.mocked(loadConfig).mockResolvedValue(makeConfig('json'));
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  process.exitCode = origExitCode;
});

// ─── runHeadlessTextCommand — recommend (DB path) ────────────────────────────

describe('runHeadlessTextCommand("recommend", --format)', () => {
  it('--format csv emits CSV content to stdout', async () => {
    const result = await runHeadlessTextCommand('recommend', ['--format', 'csv']);
    expect(result).toBe(true);
    // Real CSV formatter includes the recommendation id
    expect(stdoutBuf).toContain('rec-001');
    expect(stdoutBuf).not.toContain('korinfra recommend');
  });

  it('--format html emits HTML content to stdout', async () => {
    const result = await runHeadlessTextCommand('recommend', ['--format', 'html']);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('<!DOCTYPE html>');
    expect(stdoutBuf).not.toContain('korinfra recommend');
  });

  it('--format json falls through to human-readable text (json is not a text format)', async () => {
    const result = await runHeadlessTextCommand('recommend', ['--format', 'json']);
    expect(result).toBe(true);
    // --format json is a no-op in text mode: falls through to the native summary
    expect(stdoutBuf).toContain('korinfra recommend');
    expect(stdoutBuf).not.toContain('"recommendations"');
  });

  it('--format bogus sets exitCode 2 and writes error message to stderr', async () => {
    const result = await runHeadlessTextCommand('recommend', ['--format', 'bogus']);
    expect(result).toBe(true);
    expect(process.exitCode).toBe(2);
    expect(stderrBuf).toContain('Unknown format "bogus"');
    expect(stderrBuf).toContain('Use --format json|csv|html');
    expect(stdoutBuf).toBe('');
  });

  it('--format CSV (uppercase) is normalised and emits CSV', async () => {
    const result = await runHeadlessTextCommand('recommend', ['--format', 'CSV']);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('rec-001');
    expect(stdoutBuf).not.toContain('korinfra recommend');
  });

  it('--format csv --output <within-cwd> writes CSV to file and confirms on stderr', async () => {
    const outPath = path.join(process.cwd(), 'rec-test-output.csv');
    try {
      const result = await runHeadlessTextCommand('recommend', ['--format', 'csv', '--output', outPath]);
      expect(result).toBe(true);
      expect(stdoutBuf).toBe('');
      expect(stderrBuf).toContain('CSV report written to');
      expect(fs.readFileSync(outPath, 'utf8')).toContain('rec-001');
    } finally {
      try { fs.unlinkSync(outPath); } catch { /* already gone */ }
    }
  });

  it('--output outside cwd sets exitCode 2 and writes error to stderr', async () => {
    const result = await runHeadlessTextCommand('recommend', ['--format', 'csv', '--output', '/tmp/out.csv']);
    expect(result).toBe(true);
    expect(process.exitCode).toBe(2);
    expect(stderrBuf).toContain('must stay within the current directory');
    expect(stdoutBuf).toBe('');
  });

  it('--fail-on partial emits warning to stderr (not applicable to recommend)', async () => {
    const result = await runHeadlessTextCommand('recommend', ['--format', 'csv', '--fail-on', 'partial']);
    expect(result).toBe(true);
    expect(stderrBuf).toContain('--fail-on partial is not applicable to recommend');
    expect(process.exitCode).not.toBe(1);
  });

  it('--refresh --format csv emits warning about unsupported combination', async () => {
    // createHeadlessProvider returns null for provider:'none' — early exit after warning
    const result = await runHeadlessTextCommand('recommend', ['--refresh', '--format', 'csv']);
    expect(result).toBe(true);
    expect(stderrBuf).toContain('--format is not supported with --refresh');
  });

  it('broken config (non-ENOENT) emits warning to stderr and falls back gracefully', async () => {
    const yamlErr = Object.assign(new Error('bad YAML'), { code: 'YAML_PARSE_ERROR' });
    vi.mocked(loadConfig).mockRejectedValueOnce(yamlErr);
    const result = await runHeadlessTextCommand('recommend', []);
    expect(result).toBe(true);
    expect(stderrBuf).toContain('could not read config');
    expect(stdoutBuf).toContain('korinfra recommend');
  });

  it('no --format emits human-readable text summary (regression)', async () => {
    const result = await runHeadlessTextCommand('recommend', []);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('korinfra recommend');
    expect(stdoutBuf).toContain('Recommendations: 1');
  });

  it('default_format: csv in config emits CSV when no --format flag', async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce(makeConfig('csv'));
    const result = await runHeadlessTextCommand('recommend', []);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('rec-001');
    expect(stdoutBuf).not.toContain('korinfra recommend');
  });

  it('default_format: html in config emits HTML when no --format flag', async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce(makeConfig('html'));
    const result = await runHeadlessTextCommand('recommend', []);
    expect(result).toBe(true);
    expect(stdoutBuf).toContain('<!DOCTYPE html>');
  });
});

// ─── runJsonCommand — recommend (DB path) ─────────────────────────────────────

describe('runJsonCommand("recommend", --format)', () => {
  it('--format csv emits CSV content and returns 0', async () => {
    const code = await runJsonCommand('recommend', ['--format', 'csv']);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('rec-001');
  });

  it('--format html emits HTML content and returns 0', async () => {
    const code = await runJsonCommand('recommend', ['--format', 'html']);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('<!DOCTYPE html>');
  });

  it('--format json falls through to JSON metadata (not formatter)', async () => {
    const code = await runJsonCommand('recommend', ['--format', 'json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as { command: string; status: string };
    expect(parsed.command).toBe('recommend');
    expect(parsed.status).toBe('completed');
  });

  it('no --format emits JSON metadata (regression)', async () => {
    const code = await runJsonCommand('recommend', []);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutBuf) as {
      command: string;
      status: string;
      summary: { total: number };
    };
    expect(parsed.command).toBe('recommend');
    expect(parsed.status).toBe('completed');
    expect(parsed.summary.total).toBe(1);
  });

  it('--format bogus returns 2 with JSON error payload', async () => {
    const code = await runJsonCommand('recommend', ['--format', 'bogus']);
    expect(code).toBe(2);
    const parsed = JSON.parse(stdoutBuf) as { command: string; status: string; error: string };
    expect(parsed.command).toBe('recommend');
    expect(parsed.status).toBe('error');
    expect(parsed.error).toContain('"bogus"');
  });

  it('default_format: csv emits CSV when no --format flag', async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce(makeConfig('csv'));
    const code = await runJsonCommand('recommend', []);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('rec-001');
  });

  it('default_format: html emits HTML when no --format flag', async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce(makeConfig('html'));
    const code = await runJsonCommand('recommend', []);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('<!DOCTYPE html>');
  });

  it('--format csv --output <within-cwd> writes CSV to file and returns 0', async () => {
    const outPath = path.join(process.cwd(), 'json-rec-test-output.csv');
    try {
      const code = await runJsonCommand('recommend', ['--format', 'csv', '--output', outPath]);
      expect(code).toBe(0);
      expect(stdoutBuf).toBe('');
      expect(stderrBuf).toContain('CSV report written to');
      expect(fs.readFileSync(outPath, 'utf8')).toContain('rec-001');
    } finally {
      try { fs.unlinkSync(outPath); } catch { /* already gone */ }
    }
  });

  it('--output outside cwd returns 2 with JSON error', async () => {
    const code = await runJsonCommand('recommend', ['--format', 'csv', '--output', '/tmp/out.csv']);
    expect(code).toBe(2);
    const parsed = JSON.parse(stdoutBuf) as { command: string; status: string; error: string };
    expect(parsed.command).toBe('recommend');
    expect(parsed.status).toBe('error');
    expect(parsed.error).toContain('must stay within the current directory');
  });

  it('--fail-on partial emits warning to stderr in JSON mode', async () => {
    const code = await runJsonCommand('recommend', ['--format', 'csv', '--fail-on', 'partial']);
    expect(code).toBe(0);
    expect(stderrBuf).toContain('--fail-on partial is not applicable to recommend');
  });
});
