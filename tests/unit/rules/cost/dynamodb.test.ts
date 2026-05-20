import { describe, it, expect } from 'vitest';
import { checkDDB001, checkDDB002 } from '../../../../src/rules/cost/dynamodb.js';
import { THRESHOLDS } from '../../../../src/rules/config.js';
import type { Resource } from '../../../../src/aws/types.js';

const cfg = THRESHOLDS;

function makeTable(overrides: Partial<Resource> = {}): Resource {
  return {
    id: 'my-orders-table',
    arn: 'arn:aws:dynamodb:us-east-1:123456789012:table/my-orders-table',
    type: 'dynamodb_table',
    name: 'my-orders-table',
    region: 'us-east-1',
    state: 'active',
    instanceType: '',
    tags: { Environment: 'prod', Team: 'backend' },
    launchTime: new Date(Date.now() - 60 * 86_400_000).toISOString(),
    collectedAt: new Date().toISOString(),
    configuration: {},
    ...overrides,
  };
}

// ─── DDB-001: Provisioned → on-demand ─────────────────────────────────────────

describe('checkDDB001 — switch DynamoDB provisioned to on-demand', () => {
  it('fires for provisioned tables (with/without utilization data) and estimates 25% savings', () => {
    // Without utilization — low confidence
    const r1 = makeTable({ configuration: { billing_mode: 'PROVISIONED', read_capacity: 5, write_capacity: 5, monthlyCost: 30 } });
    const rec1 = checkDDB001(r1, cfg);
    expect(rec1).not.toBeNull();
    expect(rec1!.ruleId).toBe('DDB-001');
    expect(rec1!.confidence).toBe(0.55);
    expect(rec1!.suggestedConfig).toMatchObject({ billing_mode: 'PAY_PER_REQUEST' });

    // With low utilization — higher confidence
    const r2 = makeTable({ configuration: { billing_mode: 'PROVISIONED', read_capacity: 100, write_capacity: 100, consumed_read_capacity_units: 10, consumed_write_capacity_units: 5, monthlyCost: 80 } });
    expect(checkDDB001(r2, cfg)!.confidence).toBe(0.85);

    // 25% savings
    expect(checkDDB001(makeTable({ configuration: { billing_mode: 'PROVISIONED', read_capacity: 10, write_capacity: 10, monthlyCost: 60 } }), cfg)!.estimatedSavings).toBe(15);

    // empty billing_mode treated as PROVISIONED
    const r3 = makeTable({ configuration: { read_capacity: 5, write_capacity: 5, monthlyCost: 10 } });
    expect(checkDDB001(r3, cfg)!.currentConfig).toMatchObject({ billing_mode: 'PROVISIONED' });

    // fires when write util low even if read util high
    const r4 = makeTable({ configuration: { billing_mode: 'PROVISIONED', read_capacity: 100, write_capacity: 100, consumed_read_capacity_units: 60, consumed_write_capacity_units: 5, monthlyCost: 100 } });
    expect(checkDDB001(r4, cfg)).not.toBeNull();
  });

  it('does not fire when utilization is high, on-demand, or wrong type', () => {
    expect(checkDDB001(makeTable({ configuration: { billing_mode: 'PROVISIONED', read_capacity: 100, write_capacity: 100, consumed_read_capacity_units: 80, consumed_write_capacity_units: 70, monthlyCost: 200 } }), cfg)).toBeNull();
    expect(checkDDB001(makeTable({ configuration: { billing_mode: 'PAY_PER_REQUEST', monthlyCost: 15 } }), cfg)).toBeNull();
    expect(checkDDB001(makeTable({ type: 'rds_instance' }), cfg)).toBeNull();
  });

  // Issue #37, finding #6 — paused / zero-capacity table must skip cleanly
  it('skips a paused table (zero provisioned and zero consumed) instead of dividing 0/0', () => {
    const paused = makeTable({
      configuration: {
        billing_mode: 'PROVISIONED',
        read_capacity: 0,
        write_capacity: 0,
        consumed_read_capacity_units: 0,
        consumed_write_capacity_units: 0,
        monthlyCost: 0,
      },
    });
    expect(checkDDB001(paused, cfg)).toBeNull();
  });

  it('skips when consumed capacity is non-finite (broken upstream metric)', () => {
    const broken = makeTable({
      configuration: {
        billing_mode: 'PROVISIONED',
        read_capacity: 100,
        write_capacity: 100,
        consumed_read_capacity_units: NaN,
        consumed_write_capacity_units: 5,
        monthlyCost: 50,
      },
    });
    expect(checkDDB001(broken, cfg)).toBeNull();
  });
});

// ─── DDB-002: Provisioned without auto-scaling ────────────────────────────────

describe('checkDDB002 — DynamoDB provisioned without auto-scaling', () => {
  it('fires for provisioned tables without auto-scaling and estimates 30% savings', () => {
    const r = makeTable({ configuration: { billing_mode: 'PROVISIONED', read_capacity: 100, write_capacity: 100, monthlyCost: 200 } });
    const rec = checkDDB002(r, cfg);
    expect(rec).not.toBeNull();
    expect(rec!.ruleId).toBe('DDB-002');
    expect(rec!.suggestedConfig).toMatchObject({ auto_scaling_enabled: true });
    expect(rec!.estimatedSavings).toBe(60);

    // explicit false also fires
    expect(checkDDB002(makeTable({ configuration: { billing_mode: 'PROVISIONED', read_capacity: 25, write_capacity: 25, auto_scaling_enabled: false, monthlyCost: 100 } }), cfg)).not.toBeNull();
  });

  it('does not fire when auto-scaling enabled, on-demand, or wrong type', () => {
    expect(checkDDB002(makeTable({ configuration: { billing_mode: 'PROVISIONED', read_capacity: 50, write_capacity: 50, auto_scaling_enabled: true, monthlyCost: 150 } }), cfg)).toBeNull();
    expect(checkDDB002(makeTable({ configuration: { billing_mode: 'PAY_PER_REQUEST', monthlyCost: 20 } }), cfg)).toBeNull();
    expect(checkDDB002(makeTable({ configuration: { billing_mode: 'PAY_PER_REQUEST' } }), cfg)).toBeNull();
  });
});

// ─── DDB-001: data-quality skip warnings (#44 Item 1) ─────────────────────────

describe('DDB-001 — emits warnings on data-quality skips', () => {
  function makeCtx() {
    const warnings: Array<{ ruleId: string; resourceId: string; resourceType: string; reason: string }> = [];
    return {
      warnings,
      ctx: {
        warn(ruleId: string, resourceId: string, resourceType: string, reason: string) {
          warnings.push({ ruleId, resourceId, resourceType, reason });
        },
      },
    };
  }

  it('warns when consumed capacity is non-finite', () => {
    const { ctx, warnings } = makeCtx();
    const broken = makeTable({
      configuration: {
        billing_mode: 'PROVISIONED',
        read_capacity: 100,
        write_capacity: 100,
        consumed_read_capacity_units: NaN,
        consumed_write_capacity_units: 5,
        monthlyCost: 50,
      },
    });
    expect(checkDDB001(broken, cfg, ctx)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      ruleId: 'DDB-001',
      resourceId: broken.id,
      reason: 'consumed capacity is non-finite',
    });
  });

  it('warns when zero provisioned and zero consumed capacity', () => {
    const { ctx, warnings } = makeCtx();
    const paused = makeTable({
      configuration: {
        billing_mode: 'PROVISIONED',
        read_capacity: 0,
        write_capacity: 0,
        consumed_read_capacity_units: 0,
        consumed_write_capacity_units: 0,
        monthlyCost: 0,
      },
    });
    expect(checkDDB001(paused, cfg, ctx)).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      ruleId: 'DDB-001',
      resourceId: paused.id,
      reason: 'zero provisioned and zero consumed capacity (paused or new table)',
    });
  });

  it('does NOT warn when table is well-utilized (legitimate skip)', () => {
    const { ctx, warnings } = makeCtx();
    const wellUtilized = makeTable({
      configuration: {
        billing_mode: 'PROVISIONED',
        read_capacity: 100,
        write_capacity: 100,
        consumed_read_capacity_units: 80,
        consumed_write_capacity_units: 70,
        monthlyCost: 200,
      },
    });
    expect(checkDDB001(wellUtilized, cfg, ctx)).toBeNull();
    expect(warnings).toHaveLength(0);
  });
});
