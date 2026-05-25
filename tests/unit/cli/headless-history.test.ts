/**
 * Tests for the `korinfra history` command subcommand routing in headless mode.
 *
 * Exercises the dispatch logic (list/show/diff) and verifies that an invalid
 * subcommand causes the handler to return false without touching any pipeline.
 *
 * The history pipeline steps query SQLite directly, so we mock:
 *   - buildHistoryPipelineSteps / extractScanList / extractScanDetail / extractScanDiff
 *     from the pipelines module to avoid real DB access.
 *   - getDb from storage so the module resolves cleanly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Mock storage DB ──────────────────────────────────────────────────────────

vi.mock('../../../src/storage/index.js', () => ({
  getDb: vi.fn().mockReturnValue({}),
  defaultStoragePath: vi.fn().mockReturnValue('/tmp/.korinfra'),
}));

vi.mock('../../../src/storage/db.js', () => ({
  getDb: vi.fn().mockReturnValue({}),
}));

// ─── Mock history pipeline ────────────────────────────────────────────────────

// These hoisted stubs are used in the mock factory below.
const mockBuildHistoryPipelineSteps = vi.hoisted(() => vi.fn());
const mockExtractScanList = vi.hoisted(() => vi.fn());
const mockExtractScanDetail = vi.hoisted(() => vi.fn());
const mockExtractScanDiff = vi.hoisted(() => vi.fn());

vi.mock('../../../src/cli/pipelines/history.js', () => ({
  buildHistoryPipelineSteps: mockBuildHistoryPipelineSteps,
  extractScanList: mockExtractScanList,
  extractScanDetail: mockExtractScanDetail,
  extractScanDiff: mockExtractScanDiff,
}));

// ─── Mock loadConfig ──────────────────────────────────────────────────────────

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

  // Default: pipeline steps return an empty context (list with 0 scans)
  mockBuildHistoryPipelineSteps.mockImplementation(() => [
    {
      name: 'Loading scan history',
      completedName: 'Loaded scan history',
      key: 'scans',
      run: async () => ({ scans: [] }),
    },
  ]);
  mockExtractScanList.mockReturnValue([]);
  mockExtractScanDetail.mockReturnValue({ scan: { id: 'test-scan-id' }, resources: [], costs: [], recommendations: [] });
  mockExtractScanDiff.mockReturnValue({ scanA: { id: 'scan-a' }, scanB: { id: 'scan-b' }, resourceCountDelta: 0, costDelta: 0 });
});

afterEach(() => {
  capture.uninstall();
  process.exitCode = origExitCode;
  vi.clearAllMocks();
});

// ─── history subcommand routing ───────────────────────────────────────────────

describe('history — subcommand routing', () => {
  it('invalid subcommand returns false', async () => {
    const result = await runHeadlessTextCommand('history', ['invalidcmd']);
    expect(result).toBe(false);
  });

  it('no subcommand defaults to list and returns true', async () => {
    // history with no args uses 'list' by default (commandArgs[0] ?? 'list')
    mockExtractScanList.mockReturnValue([]);

    const result = await runHeadlessTextCommand('history', []);

    expect(result).toBe(true);
    expect(capture.stdout).toContain('korinfra history');
    expect(capture.stdout).toContain('Scans: 0');
  });

  it('list subcommand returns true and shows scan count', async () => {
    mockExtractScanList.mockReturnValue([
      { id: 'abc123', date: '2024-06-01T00:00:00Z', resourceCount: 10, totalCost: 99.5, recommendationCount: 3 },
    ]);

    const result = await runHeadlessTextCommand('history', ['list']);

    expect(result).toBe(true);
    expect(capture.stdout).toContain('korinfra history');
    expect(capture.stdout).toContain('Scans: 1');
    expect(capture.stdout).toContain('abc123');
    expect(capture.stdout).toContain('resources=10');
    expect(capture.stdout).toContain('recs=3');
  });

  it('show subcommand returns true and shows scan detail', async () => {
    // Override pipeline steps for show subcommand
    mockBuildHistoryPipelineSteps.mockImplementation(() => [
      {
        name: 'Loading scan',
        completedName: 'Loaded scan',
        key: 'scan_detail',
        run: async () => ({
          scan: { id: 'abc123' },
          resources: [{ id: 1 }, { id: 2 }],
          costs: [{ id: 1 }],
          recommendations: [],
        }),
      },
    ]);
    mockExtractScanDetail.mockReturnValue({
      scan: { id: 'abc123' },
      resources: [{ id: 1 }, { id: 2 }],
      costs: [{ id: 1 }],
      recommendations: [],
    });

    const result = await runHeadlessTextCommand('history', ['show', 'abc123']);

    expect(result).toBe(true);
    expect(capture.stdout).toContain('korinfra history show');
    expect(capture.stdout).toContain('Resources: 2');
    expect(capture.stdout).toContain('Cost entries:');
    expect(capture.stdout).toContain('Recommendations:');
  });

  it('diff subcommand returns true and shows scan diff', async () => {
    mockBuildHistoryPipelineSteps.mockImplementation(() => [
      {
        name: 'Loading diff',
        completedName: 'Loaded diff',
        key: 'scan_diff',
        run: async () => ({ scanA: { id: 'scan-a' }, scanB: { id: 'scan-b' }, resourceCountDelta: 3, costDelta: 5.0 }),
      },
    ]);
    mockExtractScanDiff.mockReturnValue({
      scanA: { id: 'scan-a' },
      scanB: { id: 'scan-b' },
      resourceCountDelta: 3,
      costDelta: 5.0,
    });

    const result = await runHeadlessTextCommand('history', ['diff', 'scan-a', 'scan-b']);

    expect(result).toBe(true);
    expect(capture.stdout).toContain('korinfra history diff');
    expect(capture.stdout).toContain('From: scan-a');
    expect(capture.stdout).toContain('To: scan-b');
    expect(capture.stdout).toContain('Resource delta: +3');
    expect(capture.stdout).toContain('Cost delta:');
  });
});
