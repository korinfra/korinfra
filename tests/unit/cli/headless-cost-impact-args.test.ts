/**
 * Argument validation tests for the `korinfra cost-impact` command in both
 * text mode (runHeadlessTextCommand) and JSON mode (runJsonCommand).
 *
 * These tests exercise the argument parsing and path-validation logic in
 * headless.ts without requiring a real Terraform plan file. They confirm:
 *   - Missing --plan-file → exit 2 + error to stderr/stdout
 *   - Non-existent file → error about missing file
 *   - Wrong extension (.txt) → error about .json requirement
 *   - Symlink pointing outside cwd → rejected by assertInsideRoot
 *   - Valid .json file inside cwd → passes validation (may fail later at parse)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

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
  };
});

import { runHeadlessTextCommand, runJsonCommand } from '../../../src/cli/headless.js';
import { createStdioCapture } from '../../helpers/stdio-capture.js';

// ─── Stdio capture helpers ────────────────────────────────────────────────────

const capture = createStdioCapture();
let origExitCode: number | string | undefined;

// We need a real temp dir so realpathSync works
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'korinfra-test-'));
  origExitCode = process.exitCode;
  capture.install();
  // Point cwd to tmpDir so files created there pass the containment check
  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
});

afterEach(() => {
  capture.uninstall();
  process.exitCode = origExitCode;
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Text mode ────────────────────────────────────────────────────────────────

describe('cost-impact text mode — argument validation', () => {
  it('exits 2 and writes to stderr when --plan-file is missing', async () => {
    const exited = await new Promise<boolean>((resolve) => {
      vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
        if (code === 2) resolve(true);
        return undefined as never;
      });
      void runHeadlessTextCommand('cost-impact', []).catch(() => resolve(false));
    });
    expect(exited).toBe(true);
    expect(capture.stderr).toContain('--plan-file');
  });

  it('exits 2 when plan file does not exist', async () => {
    const nonExistent = path.join(tmpDir, 'missing.json');
    const exited = await new Promise<boolean>((resolve) => {
      vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
        if (code === 2) resolve(true);
        return undefined as never;
      });
      void runHeadlessTextCommand('cost-impact', ['--plan-file', nonExistent]).catch(() => resolve(false));
    });
    expect(exited).toBe(true);
    expect(capture.stderr).toMatch(/not found|cannot resolve/i);
  });

  it('exits 2 when plan file has wrong extension', async () => {
    const txtFile = path.join(tmpDir, 'plan.txt');
    fs.writeFileSync(txtFile, '{}');
    const exited = await new Promise<boolean>((resolve) => {
      vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
        if (code === 2) resolve(true);
        return undefined as never;
      });
      void runHeadlessTextCommand('cost-impact', ['--plan-file', txtFile]).catch(() => resolve(false));
    });
    expect(exited).toBe(true);
    expect(capture.stderr).toContain('.json');
  });

  it('rejects a symlink pointing outside cwd', async () => {
    // Create a real .json file outside tmpDir, then symlink to it from inside
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'korinfra-outside-'));
    const outsideFile = path.join(outsideDir, 'outside.json');
    fs.writeFileSync(outsideFile, '{}');
    const symlink = path.join(tmpDir, 'escape.json');
    fs.symlinkSync(outsideFile, symlink);

    const exited = await new Promise<boolean>((resolve) => {
      vi.spyOn(process, 'exit').mockImplementation((code?: number) => {
        if (code === 2) resolve(true);
        return undefined as never;
      });
      void runHeadlessTextCommand('cost-impact', ['--plan-file', symlink]).catch(() => resolve(false));
    });
    fs.unlinkSync(outsideFile);
    fs.rmdirSync(outsideDir);
    expect(exited).toBe(true);
    expect(capture.stderr).toContain('must be inside');
  });
});

// ─── JSON mode ────────────────────────────────────────────────────────────────

describe('cost-impact JSON mode — argument validation', () => {
  it('returns 2 and writes JSON error when --plan-file is missing', async () => {
    const code = await runJsonCommand('cost-impact', []);
    expect(code).toBe(2);
    const json = JSON.parse(capture.stdout);
    expect(json.command).toBe('cost-impact');
    expect(json.status).toBe('error');
    expect(json.error).toContain('--plan-file');
  });

  it('returns 2 and writes JSON error when plan file does not exist', async () => {
    const nonExistent = path.join(tmpDir, 'ghost.json');
    const code = await runJsonCommand('cost-impact', ['--plan-file', nonExistent]);
    expect(code).toBe(2);
    const json = JSON.parse(capture.stdout);
    expect(json.status).toBe('error');
    expect(json.error).toMatch(/not found|cannot resolve/i);
  });

  it('returns 2 and writes JSON error for wrong extension', async () => {
    const txtFile = path.join(tmpDir, 'plan.txt');
    fs.writeFileSync(txtFile, '{}');
    const code = await runJsonCommand('cost-impact', ['--plan-file', txtFile]);
    expect(code).toBe(2);
    const json = JSON.parse(capture.stdout);
    expect(json.status).toBe('error');
    expect(json.error).toContain('.json');
  });

  it('returns 2 and writes JSON error when symlink escapes cwd', async () => {
    const outsideFile = path.join(os.tmpdir(), `korinfra-outside-json-${Date.now()}.json`);
    fs.writeFileSync(outsideFile, '{}');
    const symlink = path.join(tmpDir, 'escape.json');
    fs.symlinkSync(outsideFile, symlink);

    const code = await runJsonCommand('cost-impact', ['--plan-file', symlink]);
    fs.unlinkSync(outsideFile);
    expect(code).toBe(2);
    const json = JSON.parse(capture.stdout);
    expect(json.status).toBe('error');
    expect(json.error).toContain('must be inside');
  });

  it('JSON error response always has command and status fields', async () => {
    const code = await runJsonCommand('cost-impact', []);
    expect(code).toBe(2);
    const json = JSON.parse(capture.stdout);
    expect(json).toHaveProperty('command', 'cost-impact');
    expect(json).toHaveProperty('status', 'error');
    expect(json).toHaveProperty('error');
    expect(typeof json.error).toBe('string');
    expect(json.error.length).toBeGreaterThan(0);
  });
});
