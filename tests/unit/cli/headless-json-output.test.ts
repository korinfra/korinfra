/**
 * JSON output format validation tests for CLI commands that have pure
 * argument-validation paths (no AWS / DB access required).
 *
 * Covers:
 *   - report --format xml  → exit 2 + JSON error (validation branch)
 *   - pricing status       → valid JSON with stats keys (DB mocked)
 *   - history invalidcmd   → returns false (unknown subcommand)
 *   - init (no flags)      → exit 2 + JSON error (missing --non-interactive)
 *   - init --ai-provider unknown → exit 2 + JSON error
 *   - recommend --source bad → exit 1 + JSON error
 *   - mcp token bad-action → exit 2 + JSON error
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const mockCacheStats = vi.hoisted(() => ({
  count: 3,
  total_size_bytes: 1024,
  oldest_entry: '2024-01-01T00:00:00Z',
  newest_entry: '2024-06-01T00:00:00Z',
}));

// Mock getDb so pricing tests never touch the filesystem
vi.mock('../../../src/storage/index.js', () => ({
  getDb: vi.fn().mockReturnValue({}),
  defaultStoragePath: vi.fn().mockReturnValue('/tmp/test'),
}));

// Mock PricingCache so it returns controlled stats.
// Must use a regular function (not arrow) so `new PricingCache()` works.
vi.mock('../../../src/pricing/index.js', () => ({
  PricingCache: vi.fn(function () {
    return {
      getCacheStats: vi.fn().mockReturnValue(mockCacheStats),
      getExpiredCount: vi.fn().mockReturnValue(0),
    };
  }),
}));

// Mock loadConfig so tests don't need a real config file
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
      output: { currency: 'USD' },
      storage: {},
      scan: {},
      anomaly: {},
      quality: {},
      mcp: {},
    }),
    findConfigPath: vi.fn().mockResolvedValue(null),
  };
});

import { runJsonCommand } from '../../../src/cli/headless.js';
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

// ─── report — format validation ───────────────────────────────────────────────

describe('report — JSON format validation', () => {
  it('returns exit 2 for invalid --format flag', async () => {
    const code = await runJsonCommand('report', ['--format', 'xml']);
    expect(code).toBe(2);
  });

  it('emits valid JSON for invalid format', async () => {
    await runJsonCommand('report', ['--format', 'xml']);
    const json = JSON.parse(capture.stdout) as { command: string; status: string; error: string };
    expect(json.command).toBe('report');
    expect(json.status).toBe('error');
  });

  it('JSON error includes the bad format value in the error message', async () => {
    await runJsonCommand('report', ['--format', 'xml']);
    const json = JSON.parse(capture.stdout) as { error: string };
    expect(json.error).toContain('xml');
  });

  it('JSON error for invalid format includes a hint field', async () => {
    await runJsonCommand('report', ['--format', 'pdf']);
    const json = JSON.parse(capture.stdout) as { hint?: string };
    expect(json.hint).toBeDefined();
    expect(typeof json.hint).toBe('string');
  });

  it('accepts valid formats without a validation error', async () => {
    // 'json' is valid — should not hit the validation branch (may fail later in the
    // pipeline, but that is beyond our scope here)
    const validFormats = ['json', 'csv', 'html'];
    for (const fmt of validFormats) {
      capture.reset();
      // We only need to confirm that the validation branch is NOT triggered
      // (i.e. no "Unknown format" error written synchronously before pipeline starts).
      // Ignore any subsequent pipeline errors.
      await runJsonCommand('report', ['--format', fmt]).catch(() => undefined);
      if (capture.stdout.trim()) {
        const json = JSON.parse(capture.stdout) as { status?: string; error?: string };
        // If something was written it must NOT be the format-validation error
        expect(json.error ?? '').not.toContain('Unknown format');
      }
    }
  });
});

// ─── pricing — status JSON shape ─────────────────────────────────────────────

describe('pricing status — JSON output shape', () => {
  it('returns exit 0', async () => {
    const code = await runJsonCommand('pricing', ['status']);
    expect(code).toBe(0);
  });

  it('emits valid JSON', async () => {
    await runJsonCommand('pricing', ['status']);
    expect(() => JSON.parse(capture.stdout)).not.toThrow();
  });

  it('JSON has command = "pricing status"', async () => {
    await runJsonCommand('pricing', ['status']);
    const json = JSON.parse(capture.stdout) as { command: string };
    expect(json.command).toBe('pricing status');
  });

  it('JSON has status = "completed"', async () => {
    await runJsonCommand('pricing', ['status']);
    const json = JSON.parse(capture.stdout) as { status: string };
    expect(json.status).toBe('completed');
  });

  it('JSON summary has cachedEntries key', async () => {
    await runJsonCommand('pricing', ['status']);
    const json = JSON.parse(capture.stdout) as { summary: { cachedEntries: number } };
    expect(json.summary).toHaveProperty('cachedEntries');
    expect(typeof json.summary.cachedEntries).toBe('number');
  });

  it('JSON summary has cacheSizeBytes key', async () => {
    await runJsonCommand('pricing', ['status']);
    const json = JSON.parse(capture.stdout) as { summary: { cacheSizeBytes: number } };
    expect(json.summary).toHaveProperty('cacheSizeBytes');
    expect(typeof json.summary.cacheSizeBytes).toBe('number');
  });

  it('JSON summary has expiredEntries key', async () => {
    await runJsonCommand('pricing', ['status']);
    const json = JSON.parse(capture.stdout) as { summary: { expiredEntries: number } };
    expect(json.summary).toHaveProperty('expiredEntries');
    expect(typeof json.summary.expiredEntries).toBe('number');
  });

  it('JSON has a next array', async () => {
    await runJsonCommand('pricing', ['status']);
    const json = JSON.parse(capture.stdout) as { next: unknown[] };
    expect(Array.isArray(json.next)).toBe(true);
  });

  it('defaults to status subcommand when no args given', async () => {
    const code = await runJsonCommand('pricing', []);
    expect(code).toBe(0);
    const json = JSON.parse(capture.stdout) as { command: string };
    expect(json.command).toBe('pricing status');
  });

  it('returns false for unknown subcommand', async () => {
    const code = await runJsonCommand('pricing', ['download']);
    expect(code).toBe(false);
    // Nothing should be written to stdout for an unhandled subcommand
    expect(capture.stdout.trim()).toBe('');
  });
});

// ─── history — unknown subcommand returns false ───────────────────────────────

describe('history — unknown subcommand', () => {
  it('returns false for an unrecognized subcommand', async () => {
    const code = await runJsonCommand('history', ['invalidcmd']);
    expect(code).toBe(false);
  });

  it('does not write to stdout when subcommand is invalid', async () => {
    await runJsonCommand('history', ['invalidcmd']);
    expect(capture.stdout.trim()).toBe('');
  });

  it('returns false for an arbitrary unknown subcommand', async () => {
    const code = await runJsonCommand('history', ['purge']);
    expect(code).toBe(false);
  });

  it('does not return false for the valid "list" subcommand (it runs the pipeline)', async () => {
    // We cannot easily run the full pipeline here, so just verify `false` is not
    // the return value — it will be a number (exit code) or a thrown error
    // indicating the pipeline was at least attempted.
    let result: number | boolean | undefined;
    try {
      result = await runJsonCommand('history', ['list']);
    } catch {
      // Pipeline failure is fine — the point is it was not rejected at arg-validation
      result = -1;
    }
    expect(result).not.toBe(false);
  });
});

// ─── init — argument validation ───────────────────────────────────────────────

describe('init — JSON argument validation', () => {
  it('returns exit 2 when neither --non-interactive nor --config is supplied', async () => {
    const code = await runJsonCommand('init', []);
    expect(code).toBe(2);
  });

  it('emits valid JSON for missing flags error', async () => {
    await runJsonCommand('init', []);
    expect(() => JSON.parse(capture.stdout)).not.toThrow();
    const json = JSON.parse(capture.stdout) as { command: string; status: string };
    expect(json.command).toBe('init');
    expect(json.status).toBe('error');
  });

  it('error message mentions --non-interactive or --config', async () => {
    await runJsonCommand('init', []);
    const json = JSON.parse(capture.stdout) as { error: string };
    expect(json.error.toLowerCase()).toMatch(/non-interactive|--config/);
  });

  it('returns exit 2 for unknown --ai-provider', async () => {
    const code = await runJsonCommand('init', ['--non-interactive', '--ai-provider', 'openai']);
    expect(code).toBe(2);
    const json = JSON.parse(capture.stdout) as { status: string; error: string };
    expect(json.status).toBe('error');
    expect(json.error).toContain('openai');
  });

  it('returns exit 2 when --ai-provider anthropic is given without --ai-key', async () => {
    // Ensure no ambient ANTHROPIC_API_KEY leaks into this test
    const savedKey = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const code = await runJsonCommand('init', ['--non-interactive', '--ai-provider', 'anthropic']);
      expect(code).toBe(2);
      const json = JSON.parse(capture.stdout) as { status: string; error: string };
      expect(json.status).toBe('error');
      expect(json.error.toLowerCase()).toContain('ai-key');
    } finally {
      if (savedKey !== undefined) process.env['ANTHROPIC_API_KEY'] = savedKey;
    }
  });

  it('returns exit 2 for a malformed API key', async () => {
    const code = await runJsonCommand('init', [
      '--non-interactive',
      '--ai-provider', 'anthropic',
      '--ai-key', 'not-a-valid-key',
    ]);
    expect(code).toBe(2);
    const json = JSON.parse(capture.stdout) as { status: string; error: string };
    expect(json.status).toBe('error');
    expect(json.error).toContain('Invalid API key');
  });

  it('JSON error always has command and status fields', async () => {
    await runJsonCommand('init', []);
    const json = JSON.parse(capture.stdout) as Record<string, unknown>;
    expect(json).toHaveProperty('command');
    expect(json).toHaveProperty('status');
    expect(json).toHaveProperty('error');
  });
});

// ─── recommend — --source validation ─────────────────────────────────────────

describe('recommend — --source validation', () => {
  it('returns exit 1 for an unknown --source value', async () => {
    const code = await runJsonCommand('recommend', ['--source', 'datadog']);
    expect(code).toBe(1);
  });

  it('emits valid JSON for unknown --source', async () => {
    await runJsonCommand('recommend', ['--source', 'datadog']);
    expect(() => JSON.parse(capture.stdout)).not.toThrow();
    const json = JSON.parse(capture.stdout) as { command: string; status: string; error: string };
    expect(json.command).toBe('recommend');
    expect(json.status).toBe('error');
  });

  it('JSON error message includes the bad source value', async () => {
    await runJsonCommand('recommend', ['--source', 'newrelic']);
    const json = JSON.parse(capture.stdout) as { error: string };
    expect(json.error).toContain('newrelic');
  });
});

// ─── mcp token — bad action validation ───────────────────────────────────────

describe('mcp token — bad action validation', () => {
  it('returns exit 2 for an unknown token action', async () => {
    const code = await runJsonCommand('mcp', ['token', 'badaction']);
    expect(code).toBe(2);
  });

  it('emits valid JSON for unknown token action', async () => {
    await runJsonCommand('mcp', ['token', 'badaction']);
    expect(() => JSON.parse(capture.stdout)).not.toThrow();
    const json = JSON.parse(capture.stdout) as { command: string; status: string };
    expect(json.command).toBe('mcp token');
    expect(json.status).toBe('error');
  });
});
