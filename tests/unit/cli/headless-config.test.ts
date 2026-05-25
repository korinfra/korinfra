/**
 * Integration tests for the `korinfra config` command (text + JSON modes).
 *
 * Covers:
 *   - config show: displays loaded config sections
 *   - config set: validates key/value arguments, rejects unknown keys
 *   - config (no subcommand): defaults to show
 *   - Error cases: missing key/value, unknown key → exit 2
 *   - JSON mode: schema validation for show and set
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type * as ConfigModule from '../../../src/config/index.js';

// vi.hoisted ensures this value is available when the vi.mock factory runs,
// which is hoisted to the top of the file by Vitest's transformer.
const mockConfig = vi.hoisted(() => ({
  version: 1,
  aws: { default_profile: 'myprofile', default_region: 'eu-west-1', profiles: {} },
  ai: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  terraform: {},
  github: {},
  output: { currency: 'EUR' },
  storage: {},
  scan: {},
  anomaly: {},
  quality: {},
  mcp: {},
}));

vi.mock('../../../src/config/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModule>();
  return {
    ...real,
    loadConfig: vi.fn().mockResolvedValue(mockConfig),
    findConfigPath: vi.fn().mockResolvedValue('/project/.korinfra/config.yaml'),
    setConfigValue: vi.fn().mockResolvedValue(undefined),
  };
});

import { runHeadlessTextCommand, runJsonCommand } from '../../../src/cli/headless.js';
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

// ─── config show ─────────────────────────────────────────────────────────────

describe('config show — text mode', () => {
  it('defaults to show when no subcommand given', async () => {
    const result = await runHeadlessTextCommand('config', []);
    expect(result).toBe(true);
    expect(capture.stdout).toContain('Config:');
    expect(process.exitCode).toBeUndefined();
  });

  it('shows config path', async () => {
    await runHeadlessTextCommand('config', ['show']);
    expect(capture.stdout).toContain('/project/.korinfra/config.yaml');
  });

  it('shows AWS section with region and profile', async () => {
    await runHeadlessTextCommand('config', ['show']);
    expect(capture.stdout).toContain('aws:');
    expect(capture.stdout).toContain('eu-west-1');
    expect(capture.stdout).toContain('myprofile');
  });

  it('shows output currency', async () => {
    await runHeadlessTextCommand('config', ['show']);
    expect(capture.stdout).toContain('EUR');
  });
});

// ─── config set ──────────────────────────────────────────────────────────────

describe('config set — text mode', () => {
  it('exits 2 when key is missing', async () => {
    await runHeadlessTextCommand('config', ['set']);
    expect(process.exitCode).toBe(2);
    expect(capture.stdout).toContain('Usage');
  });

  it('exits 2 when value is missing', async () => {
    await runHeadlessTextCommand('config', ['set', 'aws.default_region']);
    expect(process.exitCode).toBe(2);
  });

  it('exits 2 for unknown config key', async () => {
    await runHeadlessTextCommand('config', ['set', 'nonexistent.key', 'value']);
    expect(process.exitCode).toBe(2);
    expect(capture.stdout).toContain('nonexistent.key');
  });
});

// ─── JSON mode ────────────────────────────────────────────────────────────────

describe('config show — JSON mode', () => {
  it('returns 0 and emits valid JSON with command and status fields', async () => {
    const code = await runJsonCommand('config', ['show']);
    expect(code).toBe(0);
    const json = JSON.parse(capture.stdout);
    expect(json.command).toMatch(/^config/);
    expect(json.status).toMatch(/^ok$|^completed$/);
  });

  it('JSON show includes the config path', async () => {
    await runJsonCommand('config', ['show']);
    const json = JSON.parse(capture.stdout);
    expect(json.configPath).toContain('.korinfra');
  });
});

describe('config set — JSON mode', () => {
  it('returns 2 when key is missing', async () => {
    const code = await runJsonCommand('config', ['set']);
    expect(code).toBe(2);
    const json = JSON.parse(capture.stdout);
    expect(json.status).toBe('error');
  });

  it('returns 2 for unknown key', async () => {
    const code = await runJsonCommand('config', ['set', 'bad.key', 'val']);
    expect(code).toBe(2);
    const json = JSON.parse(capture.stdout);
    expect(json.status).toBe('error');
  });
});
