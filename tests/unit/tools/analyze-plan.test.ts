import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';

import { analyzePlanTool, runAnalyzePlan } from '../../../src/tools/analyze-plan.js';
import type { AnalyzePlanResult } from '../../../src/tools/analyze-plan.js';
import type { ToolResult } from '../../../src/tools/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const fixture = (name: string): string =>
  resolve(__dirname, '../../fixtures/terraform-plans', name);

// The Tool validates that the path stays within process.cwd(), so we use a
// cwd-relative path. Tests run with cwd at the repo root.
const relFixture = (name: string): string =>
  relative(process.cwd(), fixture(name));

function parseToolJson(result: ToolResult): AnalyzePlanResult {
  if (result.isError) throw new Error(result.content[0]?.text ?? 'tool error');
  return JSON.parse(result.content[0]?.text ?? '{}') as AnalyzePlanResult;
}

describe('runAnalyzePlan — pure function', () => {
  it('returns empty summary for an empty plan', async () => {
    const r = await runAnalyzePlan(fixture('empty.json'));
    expect(r.summary.netDeltaMonthlyUsd).toBe(0);
    expect(r.changes).toEqual([]);
    expect(r.findings).toEqual([]);
  });

  it('computes a positive delta for a single create', async () => {
    const r = await runAnalyzePlan(fixture('simple-create.json'));
    expect(r.summary.counts.create).toBe(1);
    expect(r.summary.netDeltaMonthlyUsd).toBeGreaterThan(0);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]?.address).toBe('aws_instance.web');
    expect(r.changes[0]?.action).toBe('create');
    expect(r.changes[0]?.beforeUsd).toBe(0);
    expect(r.changes[0]?.afterUsd).toBeGreaterThan(0);
    expect(r.summary.netDeltaAnnualUsd).toBeCloseTo(r.summary.netDeltaMonthlyUsd * 12, 2);
  });

  it('treats delete+create as a replace and uses before/after costs (not full after)', async () => {
    const r = await runAnalyzePlan(fixture('replace.json'));
    expect(r.summary.counts.replace).toBe(1);
    expect(r.changes).toHaveLength(1);
    const row = r.changes[0]!;
    expect(row.action).toBe('replace');
    expect(row.beforeUsd).toBeGreaterThan(0);
    expect(row.afterUsd).toBeGreaterThan(row.beforeUsd);
    // Delta is positive (upgrade) and less than the full after cost.
    expect(row.deltaUsd).toBeGreaterThan(0);
    expect(row.deltaUsd).toBeLessThan(row.afterUsd);
  });

  it('marks unknown-instance-type rows as costStatus="unknown" and excludes them from net delta', async () => {
    const r = await runAnalyzePlan(fixture('with-unknowns.json'));
    expect(r.summary.unknownCount).toBeGreaterThanOrEqual(1);
    expect(r.summary.netDeltaMonthlyUsd).toBe(0);
    expect(r.changes[0]?.costStatus).toBe('unknown');
  });

  it('counts no-op rows in skippedCount and excludes them from changes', async () => {
    const r = await runAnalyzePlan(fixture('multi-action.json'));
    expect(r.summary.counts.create).toBe(1);
    expect(r.summary.counts.update).toBe(1);
    expect(r.summary.counts.destroy).toBe(1);
    expect(r.summary.skippedCount).toBeGreaterThanOrEqual(1);
    expect(r.changes.find((c) => c.action === 'no-op')).toBeUndefined();
  });

  it('surfaces a critical security finding for publicly_accessible=true RDS', async () => {
    const r = await runAnalyzePlan(fixture('critical-finding.json'));
    const critical = r.findings.filter((f) => f.severity === 'critical');
    expect(critical.length).toBeGreaterThanOrEqual(1);
    expect(critical.some((f) => f.ruleId === 'RDS-SEC-001')).toBe(true);
    expect(critical[0]?.address).toBe('aws_db_instance.public_legacy');
  });

  it('attaches triggeredRuleIds back to the change row', async () => {
    const r = await runAnalyzePlan(fixture('critical-finding.json'));
    const row = r.changes.find((c) => c.address === 'aws_db_instance.public_legacy');
    expect(row).toBeDefined();
    expect(row!.triggeredRuleIds.length).toBeGreaterThan(0);
    expect(row!.triggeredRuleIds).toContain('RDS-SEC-001');
  });

  it('rounds USD values to 2 decimals (no float precision artifacts)', async () => {
    const r = await runAnalyzePlan(fixture('replace.json'));
    for (const row of r.changes) {
      // A value like 1237.8999999999999 should be 1237.9 after rounding.
      const rounded = Math.round(row.deltaUsd * 100) / 100;
      expect(row.deltaUsd).toBe(rounded);
      expect(row.beforeUsd).toBe(Math.round(row.beforeUsd * 100) / 100);
      expect(row.afterUsd).toBe(Math.round(row.afterUsd * 100) / 100);
    }
    expect(r.summary.netDeltaMonthlyUsd).toBe(
      Math.round(r.summary.netDeltaMonthlyUsd * 100) / 100,
    );
  });
});

describe('analyzePlanTool — handler input validation', () => {
  it('errors when planFile is missing', async () => {
    const result = await analyzePlanTool.handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/planFile/);
  });

  it('errors when planFile is empty', async () => {
    const result = await analyzePlanTool.handler({ planFile: '' });
    expect(result.isError).toBe(true);
  });

  it('errors when planFile has non-.json extension', async () => {
    // Use a path that exists conceptually inside cwd to bypass assertInsideRoot
    // but fails the extension check.
    const bad = relFixture('simple-create.json').replace('.json', '.tfplan');
    const result = await analyzePlanTool.handler({ planFile: bad });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/\.json file/);
  });

  it('errors when planFile does not exist', async () => {
    const result = await analyzePlanTool.handler({
      planFile: relFixture('does-not-exist.json'),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/does not exist/);
  });

  it('errors when planFile is outside cwd', async () => {
    const result = await analyzePlanTool.handler({ planFile: '/etc/passwd.json' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/inside the project directory/);
  });

  it('returns valid JSON output for a real fixture', async () => {
    const result = await analyzePlanTool.handler({
      planFile: relFixture('simple-create.json'),
    });
    expect(result.isError).toBeFalsy();
    const parsed = parseToolJson(result);
    expect(parsed.summary).toBeDefined();
    expect(parsed.changes).toBeDefined();
    expect(parsed.findings).toBeDefined();
    expect(parsed.warnings).toBeDefined();
  });

  it('accepts an explicit currency override', async () => {
    const result = await analyzePlanTool.handler({
      planFile: relFixture('simple-create.json'),
      currency: 'EUR',
    });
    expect(result.isError).toBeFalsy();
  });
});
