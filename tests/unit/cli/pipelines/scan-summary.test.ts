/**
 * Tests for extractScanSummary() partial failure fields.
 * Verifies that collect errors are correctly surfaced as partial/errorCount/failedRegions.
 */

import { describe, it, expect } from 'vitest';
import type { PipelineContext } from '../../../../src/cli/components/DirectPipeline.js';
import { extractScanSummary } from '../../../../src/cli/pipelines/scan.js';

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
