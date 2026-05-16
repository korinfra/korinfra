/**
 * Tests for src/tools/get-costs.ts — verifies the CE pagination `partial` flag
 * bubbles up into the MCP tool JSON output as `costExplorerPartial` + `ceWarning`.
 * Regression coverage for issue #38.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CostEntry } from '../../../src/aws/types.js';

interface MockedCachedResult {
  costs: CostEntry[];
  resourceCosts: Map<string, number>;
  partial: boolean;
}

let getCostsCachedMockImpl: () => Promise<MockedCachedResult> =
  () => Promise.resolve({ costs: [], resourceCosts: new Map(), partial: false });

vi.mock('../../../src/aws/cost-explorer.js', async () => ({
  getCostsCached: vi.fn().mockImplementation(() => getCostsCachedMockImpl()),
}));

import { getCostsTool } from '../../../src/tools/get-costs.js';

function parseToolJson(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

describe('getCostsTool — costExplorerPartial bubbles up from CE pagination cap (issue #38)', () => {
  beforeEach(() => {
    getCostsCachedMockImpl = () => Promise.resolve({ costs: [], resourceCosts: new Map(), partial: false });
  });

  it('returns costExplorerPartial=true and ceWarning when CE pagination was capped', async () => {
    const stubCosts: CostEntry[] = [{
      service: 'AmazonEC2', amount: 12.34, unit: 'USD',
      startDate: '2026-04-01', endDate: '2026-04-30', granularity: 'DAILY',
    }];
    getCostsCachedMockImpl = () => Promise.resolve({ costs: stubCosts, resourceCosts: new Map(), partial: true });

    const result = await getCostsTool.handler({});

    expect(result.isError).not.toBe(true);
    const body = parseToolJson(result.content[0]!.text);
    expect(body['costExplorerPartial']).toBe(true);
    expect(body['ceWarning']).toContain('partial');
    expect(body['count']).toBe(1);
  });

  it('returns costExplorerPartial=false and no ceWarning when CE returned all pages', async () => {
    const stubCosts: CostEntry[] = [{
      service: 'AmazonS3', amount: 4.20, unit: 'USD',
      startDate: '2026-04-01', endDate: '2026-04-30', granularity: 'DAILY',
    }];
    getCostsCachedMockImpl = () => Promise.resolve({ costs: stubCosts, resourceCosts: new Map(), partial: false });

    const result = await getCostsTool.handler({});

    expect(result.isError).not.toBe(true);
    const body = parseToolJson(result.content[0]!.text);
    expect(body['costExplorerPartial']).toBe(false);
    expect(body).not.toHaveProperty('ceWarning');
  });

  it('keeps the existing truncated flag (50-entry slice) independent of CE pagination partial', async () => {
    // 60 entries with partial=false → tool slices to 50, sets truncated=true, but costExplorerPartial stays false.
    const stubCosts: CostEntry[] = Array.from({ length: 60 }, (_, i) => ({
      service: `Service-${i}`, amount: 1.0, unit: 'USD',
      startDate: '2026-04-01', endDate: '2026-04-30', granularity: 'DAILY',
    }));
    getCostsCachedMockImpl = () => Promise.resolve({ costs: stubCosts, resourceCosts: new Map(), partial: false });

    const result = await getCostsTool.handler({});

    const body = parseToolJson(result.content[0]!.text);
    expect(body['truncated']).toBe(true);
    expect(body['costExplorerPartial']).toBe(false);
    expect(body).toHaveProperty('warning');
    expect(body).not.toHaveProperty('ceWarning');
    expect((body['costs'] as unknown[]).length).toBe(50);
    expect(body['count']).toBe(60);
  });

  it('surfaces both flags together when slice truncation AND CE pagination cap both hit', async () => {
    const stubCosts: CostEntry[] = Array.from({ length: 75 }, (_, i) => ({
      service: `Svc-${i}`, amount: 0.5, unit: 'USD',
      startDate: '2026-04-01', endDate: '2026-04-30', granularity: 'DAILY',
    }));
    getCostsCachedMockImpl = () => Promise.resolve({ costs: stubCosts, resourceCosts: new Map(), partial: true });

    const result = await getCostsTool.handler({});

    const body = parseToolJson(result.content[0]!.text);
    expect(body['truncated']).toBe(true);
    expect(body['costExplorerPartial']).toBe(true);
    expect(body).toHaveProperty('warning');
    expect(body).toHaveProperty('ceWarning');
  });
});
