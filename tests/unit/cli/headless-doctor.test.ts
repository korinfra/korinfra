/**
 * Tests for the `korinfra doctor` command in headless text mode.
 *
 * Mocks runAllChecks and defaultStoragePath so no real filesystem or
 * AWS connectivity checks are performed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Mock doctor checks ───────────────────────────────────────────────────────

const mockRunAllChecks = vi.hoisted(() => vi.fn());

vi.mock('../../../src/cli/commands/doctor-checks.js', () => ({
  runAllChecks: mockRunAllChecks,
}));

// ─── Mock storage/paths ───────────────────────────────────────────────────────

vi.mock('../../../src/config/paths.js', () => ({
  defaultStoragePath: vi.fn().mockReturnValue('/tmp/.korinfra'),
}));

// Also mock loadConfig so headless.ts doesn't fail on startup
import type * as ConfigModule from '../../../src/config/index.js';
vi.mock('../../../src/config/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModule>();
  return {
    ...real,
    loadConfig: vi.fn().mockResolvedValue({
      version: 1,
      aws: { default_profile: 'default', default_region: 'us-east-1', profiles: {} },
      ai: { provider: 'none' },
      terraform: {},
      github: {},
      output: { currency: 'USD' },
      storage: {},
      scan: {},
      anomaly: {},
      quality: {},
      mcp: {},
    }),
  };
});

import { runHeadlessTextCommand } from '../../../src/cli/headless.js';
import { createStdioCapture } from '../../helpers/stdio-capture.js';

// ─── Stdio capture ────────────────────────────────────────────────────────────

const capture = createStdioCapture();
let origExitCode: number | string | undefined;

beforeEach(() => {
  origExitCode = process.exitCode;
  capture.install();
});

afterEach(() => {
  capture.uninstall();
  process.exitCode = origExitCode;
  vi.clearAllMocks();
});

// ─── Helper to build a results Map ───────────────────────────────────────────

type CheckStatus = 'pass' | 'fail' | 'warn';

function makeResults(checks: Array<{ id: string; label: string; status: CheckStatus; detail?: string }>): Map<string, { id: string; label: string; status: CheckStatus; detail?: string; optional: boolean }> {
  const map = new Map<string, { id: string; label: string; status: CheckStatus; detail?: string; optional: boolean }>();
  for (const c of checks) {
    map.set(c.id, { ...c, optional: false });
  }
  return map;
}

// ─── doctor ──────────────────────────────────────────────────────────────────

describe('doctor — text mode', () => {
  it('all checks pass — outputs "All checks passed."', async () => {
    mockRunAllChecks.mockResolvedValue(makeResults([
      { id: 'aws-creds', label: 'AWS credentials', status: 'pass', detail: 'OK' },
      { id: 'config', label: 'Config file', status: 'pass', detail: 'Found' },
      { id: 'sqlite', label: 'Database', status: 'pass', detail: 'Accessible' },
    ]));

    const result = await runHeadlessTextCommand('doctor', []);

    expect(result).toBe(true);
    expect(capture.stdout).toContain('Doctor');
    expect(capture.stdout).toContain('All checks passed.');
    expect(capture.stdout).toContain('AWS credentials');
    expect(capture.stdout).toContain('Config file');
    expect(capture.stdout).toContain('Database');
    expect(capture.stdout).toContain('✓');
    expect(process.exitCode).toBeUndefined();
  });

  it('failed checks are shown with ✗ and count', async () => {
    mockRunAllChecks.mockResolvedValue(makeResults([
      { id: 'aws-creds', label: 'AWS credentials', status: 'fail', detail: 'No credentials found' },
      { id: 'config', label: 'Config file', status: 'pass', detail: 'Found' },
    ]));

    const result = await runHeadlessTextCommand('doctor', []);

    expect(result).toBe(true);
    expect(capture.stdout).toContain('Doctor');
    expect(capture.stdout).toContain('1 check(s) failed.');
    expect(capture.stdout).toContain('✗');
    expect(capture.stdout).toContain('AWS credentials');
    expect(capture.stdout).not.toContain('All checks passed.');
    expect(process.exitCode).toBeUndefined();
  });

  it('warn checks show ! icon', async () => {
    mockRunAllChecks.mockResolvedValue(makeResults([
      { id: 'ai-key', label: 'AI provider key', status: 'warn', detail: 'Optional: not set' },
      { id: 'config', label: 'Config file', status: 'pass', detail: 'Found' },
    ]));

    const result = await runHeadlessTextCommand('doctor', []);

    expect(result).toBe(true);
    expect(capture.stdout).toContain('!');
    expect(capture.stdout).toContain('AI provider key');
    // Warn does not count as failure
    expect(capture.stdout).toContain('All checks passed.');
  });

  it('multiple failures count correctly', async () => {
    mockRunAllChecks.mockResolvedValue(makeResults([
      { id: 'aws-creds', label: 'AWS credentials', status: 'fail', detail: 'No creds' },
      { id: 'config', label: 'Config file', status: 'fail', detail: 'Not found' },
      { id: 'sqlite', label: 'Database', status: 'pass', detail: 'OK' },
    ]));

    const result = await runHeadlessTextCommand('doctor', []);

    expect(result).toBe(true);
    expect(capture.stdout).toContain('2 check(s) failed.');
  });
});
