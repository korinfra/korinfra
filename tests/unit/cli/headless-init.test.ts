/**
 * Tests for the `korinfra init` command argument validation in headless mode.
 *
 * In headless mode, `init` without --non-interactive or --config exits with 2.
 * Various invalid flag combinations also exit with 2.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── Mock writekorinfraConfig and validateApiKey ──────────────────────────────

const mockWritekorinfraConfig = vi.hoisted(() => vi.fn());

vi.mock('../../../src/cli/commands/init-core.js', async () => {
  // Keep the real validateApiKey so API key format checks still work
  return {
    writekorinfraConfig: mockWritekorinfraConfig,
    validateApiKey: (provider: 'anthropic', key: string): boolean =>
      provider === 'anthropic' ? /^sk-ant-api/.test(key) : true,
    detectAwsProfiles: vi.fn().mockReturnValue(['default']),
  };
});

// Also mock loadConfig so headless.ts doesn't fail on startup
import type * as ConfigModule from '../../../src/config/index.js';
vi.mock('../../../src/config/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof ConfigModule>();
  return {
    ...real,
    loadConfig: vi.fn().mockRejectedValue(new Error('no config')),
    findConfigPath: vi.fn().mockResolvedValue('/tmp/.korinfra/config.yaml'),
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
  vi.restoreAllMocks();
});

// ─── Helper: run command and capture exit code ────────────────────────────────

async function runAndCaptureExit(args: string[]): Promise<number | undefined> {
  let exitCode: number | undefined;
  const spy = vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
    exitCode = code;
    return undefined as never;
  });
  try {
    await runHeadlessTextCommand('init', args);
  } catch {
    // swallow any propagation after mocked exit
  }
  spy.mockRestore();
  return exitCode;
}

// ─── init validation ──────────────────────────────────────────────────────────

describe('init — headless mode validation', () => {
  it('exits 2 without --non-interactive or --config', async () => {
    const code = await runAndCaptureExit([]);
    expect(code).toBe(2);
    expect(capture.stderr).toContain('--non-interactive');
  });

  it('exits 2 for unknown --ai-provider', async () => {
    const code = await runAndCaptureExit(['--non-interactive', '--ai-provider', 'openai']);
    expect(code).toBe(2);
    expect(capture.stderr).toContain('--ai-provider');
  });

  it('exits 2 for anthropic without --ai-key', async () => {
    // Ensure ANTHROPIC_API_KEY env is not set in this test
    const saved = process.env['ANTHROPIC_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    try {
      const code = await runAndCaptureExit(['--non-interactive', '--ai-provider', 'anthropic']);
      expect(code).toBe(2);
      expect(capture.stderr).toContain('anthropic');
    } finally {
      if (saved !== undefined) process.env['ANTHROPIC_API_KEY'] = saved;
    }
  });

  it('exits 2 for invalid API key format', async () => {
    const code = await runAndCaptureExit([
      '--non-interactive',
      '--ai-provider', 'anthropic',
      '--ai-key', 'invalid-key',
    ]);
    expect(code).toBe(2);
    expect(capture.stderr).toContain('invalid API key format');
  });

  it('succeeds with --non-interactive --ai-provider none', async () => {
    mockWritekorinfraConfig.mockResolvedValue({
      configExisted: false,
      configPath: '/tmp/.korinfra/config.yaml',
      envSaved: false,
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await runHeadlessTextCommand('init', ['--non-interactive', '--ai-provider', 'none']);
    exitSpy.mockRestore();

    expect(capture.stdout).toContain('korinfra init');
    expect(capture.stdout).toContain('Status: created');
    expect(capture.stdout).toContain('/tmp/.korinfra/config.yaml');
  });
});
