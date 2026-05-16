/**
 * Tests the file-backed cache LOAD path of src/aws/cost-explorer.ts.
 *
 * Lives in its own file because vitest's `pool: 'forks'` gives each test file
 * a fresh worker — required for asserting the very first `loadCeCache()` call,
 * which is gated by `_ceCache.size === 0`.
 *
 * Regression coverage for issue #38: entries written before the `partial`
 * field existed must load with `partial=false`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as FsModule from 'node:fs';
import { createMockRateLimiter } from '../../helpers/mock-rate-limiter.js';

let readFileSyncMock: () => string = () => { throw new Error('test: no cache'); };

vi.mock('@aws-sdk/client-cost-explorer', async () => ({
  CostExplorerClient: vi.fn().mockImplementation(function () {
    // Force CE API to be unreachable so any cache miss fails loudly — tests must hit the cache.
    return { send: vi.fn().mockRejectedValue(new Error('test: CE network unreachable')) };
  }),
  GetCostAndUsageCommand: vi.fn().mockImplementation(function (this: { args: unknown }, args: unknown) {
    this.args = args;
  }),
}));

vi.mock('../../../src/aws/rate-limiter.js', async () => createMockRateLimiter());

vi.mock('../../../src/aws/credentials.js', async () => ({
  getCredentials: vi.fn().mockReturnValue(async () => ({ accessKeyId: 'x', secretAccessKey: 'y' })),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof FsModule>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn().mockImplementation(() => readFileSyncMock()),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { getCostsCached } from '../../../src/aws/cost-explorer.js';

describe('getCostsCached — back-compat load from old cache file without partial field', () => {
  beforeEach(() => {
    readFileSyncMock = () => { throw new Error('test: no cache'); };
  });

  it('treats a pre-fix cache entry (no partial field) as partial=false on load', async () => {
    // Build a cache file in the OLD format: no `partial` key.
    // Cache key format: `${startDate}:${endDate}:${granularity}:${groupBy}:${includeResourceCosts}`.
    const startDate = '2030-01-01';
    const endDate = '2030-01-31';
    const cacheKey = `${startDate}:${endDate}:DAILY:SERVICE:false`;
    const oldEntry = {
      costs: [{
        service: 'AmazonEC2', amount: 9.99, unit: 'USD',
        startDate, endDate, granularity: 'DAILY' as const,
      }],
      resourceCosts: {},
      expiresAt: Date.now() + 60_000, // not expired
      // NOTE: no `partial` field — simulates an entry written before issue #38 fix.
    };
    readFileSyncMock = () => JSON.stringify({ [cacheKey]: oldEntry });

    const result = await getCostsCached({}, { startDate, endDate, granularity: 'DAILY', groupBy: 'SERVICE' });

    expect(result.partial).toBe(false);
    expect(result.costs).toHaveLength(1);
    expect(result.costs[0]?.amount).toBe(9.99);
  });
});
