import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runHeadlessTextCommand, runJsonCommand } from '../../../src/cli/headless.js';
import { ruleRegistry } from '../../../src/rules/registry.js';

describe('rules list — text output', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let captured: string;

  beforeEach(() => {
    captured = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      captured += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('lists all rules by default', async () => {
    const handled = await runHeadlessTextCommand('rules', ['list']);
    expect(handled).toBe(true);
    expect(captured).toContain('korinfra rules');
    expect(captured).toContain(`Rules: ${ruleRegistry.length}`);
    expect(captured).toContain('EC2-001');
    expect(captured).toContain('EBS-001');
    expect(captured).toContain('LAM-001');
    expect(process.exitCode).toBeUndefined();
  });

  it('defaults to list when no subcommand given', async () => {
    const handled = await runHeadlessTextCommand('rules', []);
    expect(handled).toBe(true);
    expect(captured).toContain('korinfra rules');
    expect(captured).toContain(`Rules: ${ruleRegistry.length}`);
  });

  it('treats a leading flag as missing subcommand (flag-first)', async () => {
    const handled = await runHeadlessTextCommand('rules', ['--filter', 'ec2']);
    expect(handled).toBe(true);
    expect(captured).toContain('EC2-001');
    expect(captured).toContain('filter=ec2');
    expect(process.exitCode).toBeUndefined();
  });

  it('filters by category', async () => {
    const handled = await runHeadlessTextCommand('rules', ['list', '--filter', 'ec2']);
    expect(handled).toBe(true);
    expect(captured).toContain('EC2-001');
    expect(captured).not.toMatch(/RDS-\d+/);
    expect(captured).toContain('filter=ec2');
  });

  it('filters by id prefix', async () => {
    const handled = await runHeadlessTextCommand('rules', ['list', '--filter', 'LAM']);
    expect(handled).toBe(true);
    expect(captured).toContain('LAM-001');
    expect(captured).not.toContain('EC2-001');
  });

  it('reports zero matches when no rules match the filter', async () => {
    const handled = await runHeadlessTextCommand('rules', ['list', '--filter', 'zzz']);
    expect(handled).toBe(true);
    expect(captured).toContain('no rules match');
    expect(captured).toContain('filter=zzz');
    expect(captured).toContain('Rules: 0');
    expect(process.exitCode).toBeUndefined();
  });

  it('trims whitespace around filter value', async () => {
    const handled = await runHeadlessTextCommand('rules', ['list', '--filter', '  ec2  ']);
    expect(handled).toBe(true);
    expect(captured).toContain('EC2-001');
    expect(captured).toContain('filter=ec2');
  });

  it('treats whitespace-only filter as no filter', async () => {
    const handled = await runHeadlessTextCommand('rules', ['list', '--filter', '   ']);
    expect(handled).toBe(true);
    expect(captured).not.toContain('Filters:');
    expect(captured).toContain(`Rules: ${ruleRegistry.length}`);
  });

  it('rejects unknown subcommands with exit code 2', async () => {
    const handled = await runHeadlessTextCommand('rules', ['delete']);
    expect(handled).toBe(true);
    expect(captured).toContain('unknown subcommand');
    expect(process.exitCode).toBe(2);
  });

  it('filters by impact severity', async () => {
    const handled = await runHeadlessTextCommand('rules', ['list', '--impact', 'high']);
    expect(handled).toBe(true);
    expect(captured).toContain('impact=high');
    expect(captured).not.toMatch(/\[impact=low /);
    expect(captured).not.toMatch(/\[impact=medium /);
  });

  it('filters by risk severity', async () => {
    const handled = await runHeadlessTextCommand('rules', ['list', '--risk', 'medium']);
    expect(handled).toBe(true);
    expect(captured).toContain('risk=medium');
    expect(captured).not.toMatch(/risk=high\] /);
    expect(captured).not.toMatch(/risk=low\] /);
  });

  it('combines text and impact filters', async () => {
    const handled = await runHeadlessTextCommand('rules', ['list', '--filter', 'ec2', '--impact', 'high']);
    expect(handled).toBe(true);
    expect(captured).toContain('filter=ec2');
    expect(captured).toContain('impact=high');
    expect(captured).not.toContain('EBS-001');
    expect(captured).not.toMatch(/\[impact=low /);
  });

  it('rejects invalid --impact value with exit code 2', async () => {
    const handled = await runHeadlessTextCommand('rules', ['list', '--impact', 'bogus']);
    expect(handled).toBe(true);
    expect(captured).toContain('Invalid --impact');
    expect(process.exitCode).toBe(2);
  });

  it('rejects --filter without a value as a usage error', async () => {
    const handled = await runHeadlessTextCommand('rules', ['list', '--filter']);
    expect(handled).toBe(true);
    expect(captured).toContain('--filter requires a value');
    expect(process.exitCode).toBe(2);
  });

  it('rejects --impact followed only by another flag', async () => {
    const handled = await runHeadlessTextCommand('rules', ['list', '--impact', '--filter', 'ec2']);
    expect(handled).toBe(true);
    expect(captured).toContain('--impact requires a value');
    expect(process.exitCode).toBe(2);
  });
});

describe('rules list — JSON output', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let captured: string;

  beforeEach(() => {
    captured = '';
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      captured += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('emits the full catalog as JSON', async () => {
    const exit = await runJsonCommand('rules', ['list']);
    expect(exit).toBe(0);
    const parsed = JSON.parse(captured) as {
      command: string;
      status: string;
      filter?: string;
      summary: { total: number; totalAllRules: number };
      rules: { id: string; category: string; title: string; description: string; impact: string; risk: string }[];
    };
    expect(parsed.command).toBe('rules list');
    expect(parsed.status).toBe('completed');
    expect(parsed.summary.total).toBe(ruleRegistry.length);
    expect(parsed.summary.totalAllRules).toBe(ruleRegistry.length);
    expect(parsed.rules).toHaveLength(ruleRegistry.length);
    expect(parsed.filter).toBeUndefined();
    const ec2_012 = parsed.rules.find((r) => r.id === 'EC2-012');
    expect(ec2_012).toBeDefined();
    expect(ec2_012?.category).toBe('ec2');
    expect(ec2_012?.impact).toBe('high');
    expect(ec2_012?.risk).toBe('low');
    expect(typeof ec2_012?.description).toBe('string');
    expect(typeof ec2_012?.title).toBe('string');
  });

  it('returns only rules matching the filter', async () => {
    const exit = await runJsonCommand('rules', ['list', '--filter', 'rds']);
    expect(exit).toBe(0);
    const parsed = JSON.parse(captured) as {
      filter: string;
      summary: { total: number; totalAllRules: number };
      rules: { category: string }[];
    };
    expect(parsed.filter).toBe('rds');
    expect(parsed.summary.totalAllRules).toBe(ruleRegistry.length);
    expect(parsed.summary.total).toBeGreaterThan(0);
    expect(parsed.summary.total).toBeLessThan(ruleRegistry.length);
    for (const rule of parsed.rules) {
      expect(rule.category).toBe('rds');
    }
  });

  it('returns an empty rules array when no rules match', async () => {
    const exit = await runJsonCommand('rules', ['list', '--filter', 'zzz']);
    expect(exit).toBe(0);
    const parsed = JSON.parse(captured) as {
      filter: string;
      summary: { total: number };
      rules: unknown[];
    };
    expect(parsed.filter).toBe('zzz');
    expect(parsed.summary.total).toBe(0);
    expect(parsed.rules).toHaveLength(0);
  });

  it('treats a leading flag as missing subcommand in JSON mode too', async () => {
    const exit = await runJsonCommand('rules', ['--filter', 'ec2']);
    expect(exit).toBe(0);
    const parsed = JSON.parse(captured) as {
      command: string;
      filter: string;
      rules: { category: string }[];
    };
    expect(parsed.command).toBe('rules list');
    expect(parsed.filter).toBe('ec2');
    for (const rule of parsed.rules) {
      expect(rule.category).toBe('ec2');
    }
  });

  it('returns exit code 2 for unknown subcommand', async () => {
    const exit = await runJsonCommand('rules', ['delete']);
    expect(exit).toBe(2);
    const parsed = JSON.parse(captured) as { status: string; error: string };
    expect(parsed.status).toBe('error');
    expect(parsed.error).toContain('Unknown subcommand');
  });

  it('exposes `total` at the top level (matches issue #25 shape)', async () => {
    const exit = await runJsonCommand('rules', ['list']);
    expect(exit).toBe(0);
    const parsed = JSON.parse(captured) as { total: number; summary: { total: number } };
    expect(parsed.total).toBe(ruleRegistry.length);
    expect(parsed.total).toBe(parsed.summary.total);
  });

  it('filters by --impact high in JSON mode', async () => {
    const exit = await runJsonCommand('rules', ['list', '--impact', 'high']);
    expect(exit).toBe(0);
    const parsed = JSON.parse(captured) as {
      impact: string;
      rules: { impact: string }[];
    };
    expect(parsed.impact).toBe('high');
    expect(parsed.rules.length).toBeGreaterThan(0);
    for (const rule of parsed.rules) {
      expect(rule.impact).toBe('high');
    }
  });

  it('filters by --risk and combines with --impact', async () => {
    const exit = await runJsonCommand('rules', ['list', '--impact', 'high', '--risk', 'low']);
    expect(exit).toBe(0);
    const parsed = JSON.parse(captured) as {
      impact: string;
      risk: string;
      rules: { impact: string; risk: string }[];
    };
    expect(parsed.impact).toBe('high');
    expect(parsed.risk).toBe('low');
    for (const rule of parsed.rules) {
      expect(rule.impact).toBe('high');
      expect(rule.risk).toBe('low');
    }
  });

  it('rejects invalid --risk value with structured error', async () => {
    const exit = await runJsonCommand('rules', ['list', '--risk', 'bogus']);
    expect(exit).toBe(2);
    const parsed = JSON.parse(captured) as { status: string; error: string };
    expect(parsed.status).toBe('error');
    expect(parsed.error).toContain('Invalid --risk');
  });

  it('rejects --risk without a value as a usage error', async () => {
    const exit = await runJsonCommand('rules', ['list', '--risk']);
    expect(exit).toBe(2);
    const parsed = JSON.parse(captured) as { status: string; error: string };
    expect(parsed.status).toBe('error');
    expect(parsed.error).toContain('--risk requires a value');
  });
});
