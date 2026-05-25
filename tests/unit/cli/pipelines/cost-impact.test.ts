import { describe, it, expect } from 'vitest';
import type { PipelineContext } from '../../../../src/cli/components/DirectPipeline.js';
import { extractCostImpact } from '../../../../src/cli/pipelines/cost-impact.js';

function makeCtx(results: Record<string, unknown>): PipelineContext {
  return { results: new Map(Object.entries(results)) } as PipelineContext;
}

describe('extractCostImpact', () => {
  it('returns the empty view when the pipeline result is missing', () => {
    const view = extractCostImpact(makeCtx({}));
    expect(view.summary.netDeltaMonthlyUsd).toBe(0);
    expect(view.changes).toEqual([]);
    expect(view.findings).toEqual([]);
    expect(view.warnings).toEqual([]);
  });

  it('passes through a complete pipeline result intact', () => {
    const fixture = {
      summary: {
        netDeltaMonthlyUsd: 515,
        netDeltaAnnualUsd: 6180,
        counts: { create: 3, update: 1, destroy: 2, replace: 0 },
        unpricedCount: 0,
        unknownCount: 0,
        variableCount: 0,
        skippedCount: 0,
      },
      changes: [
        {
          action: 'create',
          address: 'aws_db_instance.api',
          tfType: 'aws_db_instance',
          resourceType: 'rds_instance',
          beforeUsd: 0,
          afterUsd: 487,
          deltaUsd: 487,
          costStatus: 'known',
          triggeredRuleIds: ['RDS-002'],
        },
      ],
      findings: [
        {
          ruleId: 'RDS-002',
          address: 'aws_db_instance.api',
          severity: 'high',
          title: 'Production RDS without Multi-AZ',
          description: 'Single-AZ RDS has no automatic failover.',
        },
      ],
      warnings: [],
    };
    const view = extractCostImpact(makeCtx({ cost_impact: fixture }));
    expect(view.summary.netDeltaMonthlyUsd).toBe(515);
    expect(view.changes).toHaveLength(1);
    expect(view.changes[0]?.deltaUsd).toBe(487);
    expect(view.findings).toHaveLength(1);
    expect(view.findings[0]?.severity).toBe('high');
  });

  it('survives a partial pipeline result (missing arrays)', () => {
    const view = extractCostImpact(makeCtx({ cost_impact: { summary: { netDeltaMonthlyUsd: 100 } } }));
    expect(view.summary.netDeltaMonthlyUsd).toBe(100);
    expect(view.changes).toEqual([]);
    expect(view.findings).toEqual([]);
  });

  // ─── Immutability regression ────────────────────────────────────────────────
  // extractCostImpact must return COPIES of the arrays stored in PipelineContext.
  // A caller that mutates the returned arrays must not corrupt the cached result.

  it('returns independent copies of arrays — caller mutations do not corrupt the cache', () => {
    const finding = {
      ruleId: 'RDS-002',
      address: 'aws_db_instance.api',
      severity: 'high',
      title: 'No Multi-AZ',
      description: 'desc',
    };
    const ctx = makeCtx({
      cost_impact: {
        summary: { netDeltaMonthlyUsd: 10 },
        changes: [{ action: 'create', address: 'aws_instance.web', deltaUsd: 10 }],
        findings: [finding],
        warnings: ['warn-1'],
      },
    });

    const view1 = extractCostImpact(ctx);
    expect(view1.findings).toHaveLength(1);

    // Mutate the returned arrays in-place
    view1.findings.splice(0, 1);
    view1.changes.push({ action: 'destroy', address: 'injected', deltaUsd: -99 } as never);
    view1.warnings.push('injected-warning');

    // Second call must return the original unmodified data
    const view2 = extractCostImpact(ctx);
    expect(view2.findings).toHaveLength(1);
    expect(view2.findings[0]?.ruleId).toBe('RDS-002');
    expect(view2.changes).toHaveLength(1);
    expect(view2.warnings).toEqual(['warn-1']);
  });

  it('returned arrays are not reference-equal to stored arrays', () => {
    const raw = {
      summary: { netDeltaMonthlyUsd: 5 },
      changes: [{ action: 'create', address: 'a', deltaUsd: 5 }],
      findings: [] as unknown[],
      warnings: [] as string[],
    };
    const ctx = makeCtx({ cost_impact: raw });

    const view = extractCostImpact(ctx);
    expect(view.changes).not.toBe(raw.changes);
    expect(view.findings).not.toBe(raw.findings);
    expect(view.warnings).not.toBe(raw.warnings);
  });
});
