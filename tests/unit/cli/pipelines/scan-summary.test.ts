/**
 * Tests for extractScanSummary() partial failure fields.
 * Verifies that collect errors are correctly surfaced as partial/errorCount/failedRegions.
 */

import { describe, it, expect } from 'vitest';
import type { PipelineContext } from '../../../../src/cli/components/DirectPipeline.js';
import { extractScanSummary, extractRecommendations } from '../../../../src/cli/pipelines/scan.js';

function makeCtx(results: Record<string, unknown>): PipelineContext {
  return { results: new Map(Object.entries(results)) } as PipelineContext;
}

describe('extractScanSummary — partial failures', () => {
  it('sets partial=true, errorCount, and failedRegions when collect errors exist', () => {
    const ctx = makeCtx({
      collect: {
        resourceCount: 5,
        errors: [
          { collector: 'ec2', region: 'us-east-1', message: 'Access denied', code: 'AccessDenied' },
          { collector: 'rds', region: 'eu-west-1', message: 'Access denied', code: 'AccessDenied' },
        ],
      },
    });
    const summary = extractScanSummary(ctx);
    expect(summary.partial).toBe(true);
    expect(summary.errorCount).toBe(2);
    expect(summary.failedRegions).toEqual(['us-east-1', 'eu-west-1']);
  });

  it('deduplicates failedRegions when multiple errors share the same region', () => {
    const ctx = makeCtx({
      collect: {
        resourceCount: 3,
        errors: [
          { collector: 'ec2', region: 'us-east-1', message: 'Throttled', code: 'ThrottlingException' },
          { collector: 'rds', region: 'us-east-1', message: 'Access denied', code: 'AccessDenied' },
        ],
      },
    });
    const summary = extractScanSummary(ctx);
    expect(summary.partial).toBe(true);
    expect(summary.errorCount).toBe(2);
    expect(summary.failedRegions).toEqual(['us-east-1']);
  });

  it('excludes non-AWS-region strings (e.g. GetCallerIdentity) from failedRegions', () => {
    const ctx = makeCtx({
      collect: {
        resourceCount: 3,
        errors: [
          { collector: 'sts', region: 'GetCallerIdentity', message: 'Unauthorized', code: 'AccessDenied' },
          { collector: 'ec2', region: 'us-east-1', message: 'Access denied', code: 'AccessDenied' },
        ],
      },
    });
    const summary = extractScanSummary(ctx);
    expect(summary.partial).toBe(true);
    expect(summary.errorCount).toBe(2);
    expect(summary.failedRegions).toEqual(['us-east-1']);
  });

  it('includes errors without a region in errorCount but not in failedRegions', () => {
    const ctx = makeCtx({
      collect: {
        resourceCount: 10,
        errors: [
          { collector: 'cost_explorer', message: 'API error', code: 'ServiceUnavailable' },
          { collector: 'global_timeout', message: 'Scan timed out', code: 'ScanTimeout' },
        ],
      },
    });
    const summary = extractScanSummary(ctx);
    expect(summary.partial).toBe(true);
    expect(summary.errorCount).toBe(2);
    expect(summary.failedRegions).toEqual([]);
  });

  it('sets partial=false, errorCount=0, and failedRegions=[] when no errors', () => {
    const ctx = makeCtx({
      collect: { resourceCount: 10, errors: [] },
    });
    const summary = extractScanSummary(ctx);
    expect(summary.partial).toBe(false);
    expect(summary.errorCount).toBe(0);
    expect(summary.failedRegions).toEqual([]);
  });

  it('sets partial=false when collect result has no errors field', () => {
    const ctx = makeCtx({
      collect: { resourceCount: 7 },
    });
    const summary = extractScanSummary(ctx);
    expect(summary.partial).toBe(false);
    expect(summary.errorCount).toBe(0);
    expect(summary.failedRegions).toEqual([]);
  });

  it('sets partial=false when collect result is missing entirely', () => {
    const ctx = makeCtx({});
    const summary = extractScanSummary(ctx);
    expect(summary.partial).toBe(false);
    expect(summary.errorCount).toBe(0);
    expect(summary.failedRegions).toEqual([]);
  });

  it('preserves existing summary fields alongside new partial fields', () => {
    const ctx = makeCtx({
      collect: {
        resourceCount: 15,
        errors: [{ collector: 'ec2', region: 'ap-southeast-1', message: 'Unauthorized', code: 'UnauthorizedOperation' }],
      },
      anomalies: { anomalyCount: 3 },
    });
    const summary = extractScanSummary(ctx);
    expect(summary.resourceCount).toBe(15);
    expect(summary.anomalyCount).toBe(3);
    expect(summary.partial).toBe(true);
    expect(summary.failedRegions).toEqual(['ap-southeast-1']);
  });
});

// unknownCostCount is derived from the warnings emitted by strict-gated rules
// (deduped per resource), so the count reflects resources that were actually
// skipped — not raw collect-payload values that security rules still consume.
describe('extractScanSummary — unknownCostCount', () => {
  it('counts unique resources warned about missing monthly_cost', () => {
    const ctx = makeCtx({
      collect: { resourceCount: 5 },
      rules: {
        warnings: [
          { ruleId: 'RDS-001', resourceId: 'db-1', resourceType: 'rds_instance', reason: 'monthly_cost missing or invalid' },
          { ruleId: 'RDS-009', resourceId: 'db-1', resourceType: 'rds_instance', reason: 'monthly_cost missing or invalid' },
          { ruleId: 'EBS-001', resourceId: 'vol-1', resourceType: 'ebs_volume', reason: 'monthly_cost missing or invalid' },
        ],
      },
    });
    expect(extractScanSummary(ctx).unknownCostCount).toBe(2);
  });

  it('ignores warnings with other reasons', () => {
    const ctx = makeCtx({
      collect: { resourceCount: 1 },
      rules: {
        warnings: [
          { ruleId: 'X-1', resourceId: 'r-1', resourceType: 't', reason: 'something else' },
        ],
      },
    });
    expect(extractScanSummary(ctx).unknownCostCount).toBe(0);
  });

  it('returns 0 when there are no rule warnings', () => {
    const ctx = makeCtx({
      collect: { resourceCount: 2 },
      rules: { warnings: [] },
    });
    expect(extractScanSummary(ctx).unknownCostCount).toBe(0);
  });
});

// Issue #37 finding #1 — JSON output must reflect the real (clamped)
// confidence from each rule, not the previously-hardcoded 1.
describe('extractRecommendations — confidence + savings guards', () => {
  it('propagates the rule-emitted confidence', () => {
    const ctx = makeCtx({
      rules: {
        recommendations: [
          { id: 'EC2-001-001', title: 'idle', description: 'd', impact: 'high', risk: 'low', estimated_savings: 50, confidence: 0.85 },
        ],
      },
    });
    const recs = extractRecommendations(ctx);
    expect(recs[0]!.confidence).toBe(0.85);
  });

  it('clamps confidence > 1 down to 1 (defends against stale DB rows)', () => {
    const ctx = makeCtx({
      rules: {
        recommendations: [
          { id: 'x', title: 't', description: 'd', impact: 'high', risk: 'low', estimated_savings: 10, confidence: 1.05 },
        ],
      },
    });
    expect(extractRecommendations(ctx)[0]!.confidence).toBe(1);
  });

  it('collapses NaN / negative confidence to 0', () => {
    const ctx = makeCtx({
      rules: {
        recommendations: [
          { id: 'a', title: 't', description: 'd', impact: 'high', risk: 'low', confidence: NaN },
          { id: 'b', title: 't', description: 'd', impact: 'high', risk: 'low', confidence: -0.5 },
        ],
      },
    });
    const recs = extractRecommendations(ctx);
    expect(recs[0]!.confidence).toBe(0);
    expect(recs[1]!.confidence).toBe(0);
  });

  it('rejects NaN / negative estimated_savings', () => {
    const ctx = makeCtx({
      rules: {
        recommendations: [
          { id: 'a', title: 't', description: 'd', impact: 'high', risk: 'low', estimated_savings: NaN, confidence: 0.9 },
          { id: 'b', title: 't', description: 'd', impact: 'high', risk: 'low', estimated_savings: -100, confidence: 0.9 },
        ],
      },
    });
    const recs = extractRecommendations(ctx);
    expect(recs[0]!.estimatedSavingsUsd).toBe(0);
    expect(recs[1]!.estimatedSavingsUsd).toBe(0);
  });
});
