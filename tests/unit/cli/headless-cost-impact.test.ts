/**
 * Tests for `korinfra cost-impact` in src/cli/headless.ts —
 * specifically --fail-on-delta (issue #64) and --tfdir (issue #63) wiring.
 *
 * Mirrors the pattern from headless-recommend-co.test.ts:
 * - Mock loadConfig so tests don't need a real config file.
 * - Capture stdout/stderr in beforeEach/afterEach.
 * - Drive runJsonCommand (returns a number, no process.exit).
 * - Drive runHeadlessTextCommand with mocked process.exit for exit-code assertions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixture = (name: string): string =>
  relative(process.cwd(), resolve(__dirname, '../../fixtures/terraform-plans', name));

// ─── Stdout / stderr capture ─────────────────────────────────────────────────

let stdoutBuf = '';
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;
let origExitCode: number | string | undefined;

beforeEach(() => {
  stdoutBuf = '';
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origStderrWrite = process.stderr.write.bind(process.stderr);
  origExitCode = process.exitCode;
  process.stdout.write = ((chunk: unknown) => {
    stdoutBuf += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  process.exitCode = origExitCode;
  vi.restoreAllMocks();
});

// ─── JSON mode: --fail-on-delta ──────────────────────────────────────────────

describe('runJsonCommand("cost-impact") — --fail-on-delta (issue #64)', () => {
  it('returns 0 and omits failOnDeltaTriggered when flag not supplied', async () => {
    const code = await runJsonCommand('cost-impact', ['--plan-file', fixture('simple-create.json')]);
    expect(code).toBe(0);
    const out = JSON.parse(stdoutBuf) as { summary: Record<string, unknown> };
    expect(out.summary['failOnDeltaTriggered']).toBeUndefined();
    expect(out.summary['failOnDeltaThresholdUsd']).toBeUndefined();
  });

  it('returns 0 and includes failOnDeltaTriggered=false when delta is below threshold', async () => {
    // simple-create.json: t3.micro create ≈ $6/mo — well under 999999
    const code = await runJsonCommand('cost-impact', [
      '--plan-file', fixture('simple-create.json'),
      '--fail-on-delta', '999999',
    ]);
    expect(code).toBe(0);
    const out = JSON.parse(stdoutBuf) as { summary: Record<string, unknown> };
    expect(out.summary['failOnDeltaTriggered']).toBe(false);
    expect(out.summary['failOnDeltaThresholdUsd']).toBe(999999);
  });

  it('returns 1 and failOnDeltaTriggered=true when delta exceeds threshold', async () => {
    // simple-create.json: t3.micro ≈ $6/mo — exceeds threshold of 0 (any delta)
    const code = await runJsonCommand('cost-impact', [
      '--plan-file', fixture('simple-create.json'),
      '--fail-on-delta', '0',
    ]);
    expect(code).toBe(1);
    const out = JSON.parse(stdoutBuf) as { summary: Record<string, unknown> };
    expect(out.summary['failOnDeltaTriggered']).toBe(true);
    expect(out.summary['failOnDeltaThresholdUsd']).toBe(0);
  });

  it('uses absolute value — destroy that saves money also fires the gate', async () => {
    // multi-action.json has a destroy (aws_instance.legacy_worker t3.large ≈ -$50/mo)
    // threshold 0: abs(-50) > 0 → should fire
    const code = await runJsonCommand('cost-impact', [
      '--plan-file', fixture('multi-action.json'),
      '--fail-on-delta', '0',
    ]);
    expect(code).toBe(1);
    const out = JSON.parse(stdoutBuf) as { summary: Record<string, unknown> };
    expect(out.summary['failOnDeltaTriggered']).toBe(true);
  });

  it('returns 2 for --fail-on-delta abc (non-numeric)', async () => {
    const code = await runJsonCommand('cost-impact', [
      '--plan-file', fixture('simple-create.json'),
      '--fail-on-delta', 'abc',
    ]);
    expect(code).toBe(2);
    const out = JSON.parse(stdoutBuf) as { status: string; error: string };
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/must be a number/i);
  });

  it('returns 2 for --fail-on-delta (no value)', async () => {
    const code = await runJsonCommand('cost-impact', [
      '--plan-file', fixture('simple-create.json'),
      '--fail-on-delta',
    ]);
    expect(code).toBe(2);
    const out = JSON.parse(stdoutBuf) as { status: string; error: string };
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/requires a numeric value/i);
  });

  it('returns 2 for --fail-on-delta -100 (negative)', async () => {
    const code = await runJsonCommand('cost-impact', [
      '--plan-file', fixture('simple-create.json'),
      '--fail-on-delta', '-100',
    ]);
    expect(code).toBe(2);
    const out = JSON.parse(stdoutBuf) as { status: string; error: string };
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/must be >= 0/i);
  });

  it('returns 2 for --fail-on-delta=-100 (equals form negative)', async () => {
    const code = await runJsonCommand('cost-impact', [
      '--plan-file', fixture('simple-create.json'),
      '--fail-on-delta=-100',
    ]);
    expect(code).toBe(2);
    const out = JSON.parse(stdoutBuf) as { status: string; error: string };
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/must be >= 0/i);
  });

  it('OR semantics: both --fail-on critical and --fail-on-delta fire → returns 1', async () => {
    // critical-finding.json triggers RDS-SEC-001 (critical); threshold 0 also fires
    const code = await runJsonCommand('cost-impact', [
      '--plan-file', fixture('critical-finding.json'),
      '--fail-on', 'critical',
      '--fail-on-delta', '0',
    ]);
    expect(code).toBe(1);
    const out = JSON.parse(stdoutBuf) as {
      summary: Record<string, unknown>;
      findings: Array<{ severity: string }>;
    };
    // Both gates independently fired
    expect(out.summary['failOnDeltaTriggered']).toBe(true);
    expect(out.findings.filter((f) => f.severity === 'critical').length).toBeGreaterThan(0);
  });
});

// ─── Text mode: --fail-on-delta ──────────────────────────────────────────────

describe('runHeadlessTextCommand("cost-impact") — --fail-on-delta text output (issue #64)', () => {
  it('includes "Exiting 1" line when gate fires', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string) => {
      throw new Error(`process.exit(${_code ?? ''})`);
    });
    await expect(
      runHeadlessTextCommand('cost-impact', [
        '--plan-file', fixture('simple-create.json'),
        '--fail-on-delta', '0',
      ]),
    ).rejects.toThrow('process.exit(1)');
    expect(stdoutBuf).toMatch(/Exiting 1/);
    expect(stdoutBuf).toMatch(/exceeds --fail-on-delta threshold/);
    exitSpy.mockRestore();
  });

  it('does not include "Exiting 1" when below threshold', async () => {
    const result = await runHeadlessTextCommand('cost-impact', [
      '--plan-file', fixture('simple-create.json'),
      '--fail-on-delta', '999999',
    ]);
    expect(result).toBe(true);
    expect(stdoutBuf).not.toMatch(/Exiting 1/);
  });
});

// ─── JSON mode: --tfdir ──────────────────────────────────────────────────────

describe('runJsonCommand("cost-impact") — --tfdir validation (issue #63)', () => {
  it('returns 2 for --tfdir pointing to a non-existent directory', async () => {
    const code = await runJsonCommand('cost-impact', [
      '--plan-file', fixture('simple-create.json'),
      '--tfdir', 'definitely-does-not-exist-xyz',
    ]);
    expect(code).toBe(2);
    const out = JSON.parse(stdoutBuf) as { status: string; error: string };
    expect(out.status).toBe('error');
    expect(out.error).toMatch(/not found or not a directory/i);
  });

  it('accepts a valid --tfdir and returns 0', async () => {
    const tfdir = relative(
      process.cwd(),
      resolve(__dirname, '../../fixtures/terraform-dirs/simple'),
    );
    const code = await runJsonCommand('cost-impact', [
      '--plan-file', fixture('simple-create.json'),
      '--tfdir', tfdir,
    ]);
    expect(code).toBe(0);
    const out = JSON.parse(stdoutBuf) as { status: string; warnings: string[] };
    expect(out.status).toBe('completed');
    // No scan-failure warning
    const scanError = out.warnings.find((w) => w.includes('--tfdir scan failed'));
    expect(scanError).toBeUndefined();
  });
});

// ─── Text mode: warnings visible ─────────────────────────────────────────────

describe('runHeadlessTextCommand("cost-impact") — warnings in text output', () => {
  it('prints region-defaulted warning in text output', async () => {
    const noRegionFixture = relative(
      process.cwd(),
      resolve(__dirname, '../../fixtures/terraform-plans/no-region.json'),
    );
    await runHeadlessTextCommand('cost-impact', ['--plan-file', noRegionFixture]);
    expect(stdoutBuf).toMatch(/No AWS region found/);
    expect(stdoutBuf).toMatch(/us-east-1/);
  });
});
