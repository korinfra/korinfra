/**
 * Tests for the `korinfra pricing status` command in headless text mode.
 *
 * Mocks getDb and PricingCache so no real database or filesystem is needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Mock DB ──────────────────────────────────────────────────────────────────

vi.mock('../../../src/storage/index.js', () => ({
  getDb: vi.fn().mockReturnValue({}),
  defaultStoragePath: vi.fn().mockReturnValue('/tmp/.korinfra'),
}));

// ─── Mock PricingCache ────────────────────────────────────────────────────────

const mockGetCacheStats = vi.hoisted(() => vi.fn());
const mockGetExpiredCount = vi.hoisted(() => vi.fn());

vi.mock('../../../src/pricing/index.js', () => {
  return {
    PricingCache: class {
      getCacheStats() { return mockGetCacheStats(); }
      getExpiredCount() { return mockGetExpiredCount(); }
    },
  };
});

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

// ─── pricing status ───────────────────────────────────────────────────────────

describe('pricing status — text mode', () => {
  it('shows pricing cache stats', async () => {
    mockGetCacheStats.mockReturnValue({
      count: 5,
      total_size_bytes: 2048,
      oldest_entry: '2024-01-01',
      newest_entry: '2024-06-01',
    });
    mockGetExpiredCount.mockReturnValue(2);

    const result = await runHeadlessTextCommand('pricing', ['status']);

    expect(result).toBe(true);
    expect(capture.stdout).toContain('korinfra pricing status');
    expect(capture.stdout).toContain('Cached entries: 5');
    expect(capture.stdout).toContain('Cache size: 2.0 KB');
    expect(capture.stdout).toContain('Expired entries: 2');
    expect(capture.stdout).toContain('2024-01-01');
    expect(capture.stdout).toContain('2024-06-01');
    expect(capture.stdout).toContain('korinfra pricing download');
  });

  it('shows 0 entries when cache is empty', async () => {
    mockGetCacheStats.mockReturnValue({
      count: 0,
      total_size_bytes: 0,
      oldest_entry: null,
      newest_entry: null,
    });
    mockGetExpiredCount.mockReturnValue(0);

    const result = await runHeadlessTextCommand('pricing', ['status']);

    expect(result).toBe(true);
    expect(capture.stdout).toContain('Cached entries: 0');
    expect(capture.stdout).toContain('Oldest entry: N/A');
    expect(capture.stdout).toContain('Newest entry: N/A');
    // When count is 0 (empty), a download hint should appear
    expect(capture.stdout).toContain('korinfra pricing download');
  });

  it('defaults to status when no subcommand given', async () => {
    mockGetCacheStats.mockReturnValue({
      count: 3,
      total_size_bytes: 1024,
      oldest_entry: '2024-03-01',
      newest_entry: '2024-03-15',
    });
    mockGetExpiredCount.mockReturnValue(0);

    const result = await runHeadlessTextCommand('pricing', []);

    expect(result).toBe(true);
    expect(capture.stdout).toContain('Cached entries: 3');
    expect(capture.stdout).not.toContain('korinfra pricing download');
  });

  it('unknown subcommand returns false', async () => {
    const result = await runHeadlessTextCommand('pricing', ['unknown']);
    expect(result).toBe(false);
  });
});
