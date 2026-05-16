/**
 * Tests for src/tools/get-ri-coverage.ts — regression coverage for the same
 * empty-string Amount bug class fixed in cost-explorer.ts (issue #20).
 *
 * AWS Cost Explorer numeric fields (CoverageHoursPercentage, OnDemandHours,
 * ReservedHours) can return as "" — must not become NaN in the tool response.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

let sendMockImpl: () => Promise<unknown> = () => Promise.resolve({ CoveragesByTime: [] });

vi.mock('@aws-sdk/client-cost-explorer', async () => ({
  CostExplorerClient: vi.fn().mockImplementation(function () {
    return { send: vi.fn().mockImplementation(() => sendMockImpl()) };
  }),
  GetReservationCoverageCommand: vi.fn().mockImplementation(function (this: { args: unknown }, args: unknown) {
    this.args = args;
  }),
}));

vi.mock('../../../src/aws/credentials.js', async () => ({
  getCredentials: vi.fn().mockReturnValue(async () => ({ accessKeyId: 'x', secretAccessKey: 'y' })),
}));

import { getRiCoverageTool } from '../../../src/tools/get-ri-coverage.js';

interface CoverageRow {
  service: string;
  region: string;
  coveragePercent: number;
  onDemandHours: number;
  reservedHours: number;
}

function parseResult(text: string): { coverageByService: CoverageRow[]; count: number; lowCoverageCount: number } {
  return JSON.parse(text);
}

describe('get_ri_coverage tool — empty-string Amount handling (issue #20)', () => {
  beforeEach(() => {
    sendMockImpl = () => Promise.resolve({ CoveragesByTime: [] });
  });

  it('does not produce NaN when CoverageHoursPercentage / ReservedHours are empty strings (with non-zero OnDemandHours)', async () => {
    // Critical regression case: OnDemandHours is non-zero so the row passes the
    // `.filter(c => c.onDemandHours > 0)` guard. Without the fix, the buggy
    // `parseFloat('' ?? '0')` would leave coveragePercent / reservedHours as NaN
    // in the surviving row, polluting the tool's JSON response.
    sendMockImpl = () => Promise.resolve({
      CoveragesByTime: [{
        Groups: [{
          Attributes: { SERVICE: 'Amazon Elastic Compute Cloud - Compute', REGION: 'us-east-1' },
          Coverage: { CoverageHours: { CoverageHoursPercentage: '', OnDemandHours: '100', ReservedHours: '' } },
        }],
      }],
    });

    const result = await getRiCoverageTool.handler({});
    const body = parseResult(result.content[0]?.text ?? '');

    expect(body.count).toBe(1);
    const row = body.coverageByService[0]!;
    expect(row.coveragePercent).toBe(0);
    expect(row.reservedHours).toBe(0);
    expect(row.onDemandHours).toBe(100);
    expect(Number.isFinite(row.coveragePercent)).toBe(true);
    expect(Number.isFinite(row.reservedHours)).toBe(true);
  });

  it('drops rows where OnDemandHours is an empty string (would-be-NaN gets coerced to 0 and filtered)', async () => {
    sendMockImpl = () => Promise.resolve({
      CoveragesByTime: [{
        Groups: [{
          Attributes: { SERVICE: 'Amazon RDS', REGION: 'us-east-1' },
          Coverage: { CoverageHours: { CoverageHoursPercentage: '50', OnDemandHours: '', ReservedHours: '200' } },
        }],
      }],
    });

    const result = await getRiCoverageTool.handler({});
    const body = parseResult(result.content[0]?.text ?? '');

    expect(body.count).toBe(0);
    expect(body.coverageByService).toEqual([]);
  });

  it('parses valid numeric strings correctly (happy-path non-regression)', async () => {
    sendMockImpl = () => Promise.resolve({
      CoveragesByTime: [{
        Groups: [{
          Attributes: { SERVICE: 'Amazon RDS', REGION: 'us-west-2' },
          Coverage: { CoverageHours: { CoverageHoursPercentage: '42.5', OnDemandHours: '50', ReservedHours: '150' } },
        }],
      }],
    });

    const result = await getRiCoverageTool.handler({});
    const body = parseResult(result.content[0]?.text ?? '');

    expect(body.coverageByService[0]?.coveragePercent).toBe(42.5);
    expect(body.coverageByService[0]?.onDemandHours).toBe(50);
    expect(body.coverageByService[0]?.reservedHours).toBe(150);
  });
});
