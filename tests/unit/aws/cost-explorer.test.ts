/**
 * Tests for src/aws/cost-explorer.ts — focused regression coverage for issue #20:
 * empty-string Amount in AWS Cost Explorer responses must not produce NaN entries.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as FsModule from 'node:fs';
import { createMockRateLimiter } from '../../helpers/mock-rate-limiter.js';

// The send mock is reassigned per test so each case can return a custom CE response.
let sendMockImpl: (cmd: { constructor: { name: string } }) => Promise<unknown> =
  () => Promise.resolve({ ResultsByTime: [] });

vi.mock('@aws-sdk/client-cost-explorer', async () => ({
  CostExplorerClient: vi.fn().mockImplementation(function () {
    return { send: vi.fn().mockImplementation((cmd: { constructor: { name: string } }) => sendMockImpl(cmd)) };
  }),
  GetCostAndUsageCommand: vi.fn().mockImplementation(function (this: { args: unknown }, args: unknown) {
    this.args = args;
  }),
}));

vi.mock('../../../src/aws/rate-limiter.js', async () => createMockRateLimiter());

vi.mock('../../../src/aws/credentials.js', async () => ({
  getCredentials: vi.fn().mockReturnValue(async () => ({ accessKeyId: 'x', secretAccessKey: 'y' })),
}));

// safeReadFile/safeWriteFile are reassignable so individual tests can drive cache file behavior.
let readFileSyncMock: (() => string) | (() => never) = () => { throw new Error('test: no cache'); };
const writeFileSyncCalls: Array<{ path: string; data: string }> = [];

vi.mock('../../../src/utils/safe-fs.js', () => ({
  safeReadFile: vi.fn().mockImplementation(() => readFileSyncMock()),
  safeWriteFile: vi.fn().mockImplementation((path: string, data: string | Buffer) => {
    writeFileSyncCalls.push({ path, data: typeof data === 'string' ? data : data.toString('utf8') });
  }),
  safeOpenAppend: vi.fn().mockReturnValue(0),
  checkNoSymlink: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof FsModule>('node:fs');
  return { ...actual, mkdirSync: vi.fn() };
});

import { getCostsCached } from '../../../src/aws/cost-explorer.js';

// Each test uses a unique date range so the in-process cache (Map keyed by date range)
// never collides with another test in the same file.
function dates(year: number): { startDate: string; endDate: string } {
  return { startDate: `${year}-01-01`, endDate: `${year}-01-31` };
}

describe('getCostsCached — empty-string Amount handling (issue #20)', () => {
  beforeEach(() => {
    sendMockImpl = () => Promise.resolve({ ResultsByTime: [] });
  });

  it('returns amount=0 (not NaN) when result.Total.UnblendedCost.Amount is empty string', async () => {
    sendMockImpl = () => Promise.resolve({
      ResultsByTime: [{
        TimePeriod: { Start: '2010-01-01', End: '2010-01-31' },
        Total: { UnblendedCost: { Amount: '', Unit: 'USD' } },
        Groups: [],
      }],
    });

    const { costs } = await getCostsCached({}, dates(2010));

    expect(costs).toHaveLength(1);
    expect(costs[0]?.amount).toBe(0);
    expect(Number.isFinite(costs[0]?.amount)).toBe(true);
  });

  it('returns amount=0 (not NaN) when a group\'s UnblendedCost.Amount is empty string', async () => {
    sendMockImpl = () => Promise.resolve({
      ResultsByTime: [{
        TimePeriod: { Start: '2011-01-01', End: '2011-01-31' },
        Groups: [{
          Keys: ['AmazonEC2'],
          Metrics: { UnblendedCost: { Amount: '', Unit: 'USD' } },
        }],
      }],
    });

    const { costs } = await getCostsCached({}, dates(2011));

    expect(costs).toHaveLength(1);
    expect(costs[0]?.service).toBe('AmazonEC2');
    expect(costs[0]?.amount).toBe(0);
    expect(Number.isFinite(costs[0]?.amount)).toBe(true);
  });

  it('returns parsed amount when Amount is a valid numeric string (happy path)', async () => {
    sendMockImpl = () => Promise.resolve({
      ResultsByTime: [{
        TimePeriod: { Start: '2012-01-01', End: '2012-01-31' },
        Groups: [{
          Keys: ['AmazonS3'],
          Metrics: { UnblendedCost: { Amount: '12.34', Unit: 'USD' } },
        }],
      }],
    });

    const { costs } = await getCostsCached({}, dates(2012));

    expect(costs).toHaveLength(1);
    expect(costs[0]?.amount).toBe(12.34);
  });

  it('returns amount=0 when Amount is missing (undefined)', async () => {
    sendMockImpl = () => Promise.resolve({
      ResultsByTime: [{
        TimePeriod: { Start: '2013-01-01', End: '2013-01-31' },
        Total: { UnblendedCost: { Unit: 'USD' } },
        Groups: [],
      }],
    });

    const { costs } = await getCostsCached({}, dates(2013));

    expect(costs).toHaveLength(1);
    expect(costs[0]?.amount).toBe(0);
    expect(Number.isFinite(costs[0]?.amount)).toBe(true);
  });

  it('parses UsageQuantity correctly and includes it on the entry when non-zero', async () => {
    sendMockImpl = () => Promise.resolve({
      ResultsByTime: [{
        TimePeriod: { Start: '2014-01-01', End: '2014-01-31' },
        Groups: [{
          Keys: ['AmazonEC2'],
          Metrics: {
            UnblendedCost: { Amount: '1.00', Unit: 'USD' },
            UsageQuantity: { Amount: '42.5', Unit: 'Hrs' },
          },
        }],
      }],
    });

    const { costs } = await getCostsCached({}, dates(2014));

    expect(costs).toHaveLength(1);
    expect(costs[0]?.usageQuantity).toBe(42.5);
  });

  it('omits usageQuantity field when UsageQuantity.Amount is empty string', async () => {
    // The post-refactor guard coerces '' → 0, and the spread `...(usageQuantity !== 0 ? {...} : {})`
    // drops the field entirely when it would have been zero. Verifies both the parse fix and
    // the conditional include logic survive together.
    sendMockImpl = () => Promise.resolve({
      ResultsByTime: [{
        TimePeriod: { Start: '2015-01-01', End: '2015-01-31' },
        Groups: [{
          Keys: ['AmazonS3'],
          Metrics: {
            UnblendedCost: { Amount: '1.00', Unit: 'USD' },
            UsageQuantity: { Amount: '', Unit: 'GB' },
          },
        }],
      }],
    });

    const { costs } = await getCostsCached({}, dates(2015));

    expect(costs).toHaveLength(1);
    expect(costs[0]).not.toHaveProperty('usageQuantity');
  });
});

describe('getCostsCached — pagination cap surfaces partial flag (issue #38)', () => {
  beforeEach(() => {
    sendMockImpl = () => Promise.resolve({ ResultsByTime: [] });
  });

  it('returns partial=false when the CE response has no NextPageToken', async () => {
    sendMockImpl = () => Promise.resolve({
      ResultsByTime: [{
        TimePeriod: { Start: '2020-01-01', End: '2020-01-31' },
        Groups: [{ Keys: ['AmazonEC2'], Metrics: { UnblendedCost: { Amount: '1.00', Unit: 'USD' } } }],
      }],
    });

    const result = await getCostsCached({}, dates(2020));

    expect(result.partial).toBe(false);
    expect(result.costs).toHaveLength(1);
  });

  it('returns partial=true when CE keeps returning NextPageToken past the page cap', async () => {
    // The CE_MAX_PAGES cap is 100. Hand back a token every call so the loop exits
    // because the cap was hit, not because data ran out.
    let calls = 0;
    sendMockImpl = () => {
      calls += 1;
      return Promise.resolve({
        ResultsByTime: [{
          TimePeriod: { Start: '2021-01-01', End: '2021-01-31' },
          Groups: [{ Keys: [`Service${calls}`], Metrics: { UnblendedCost: { Amount: '1.00', Unit: 'USD' } } }],
        }],
        NextPageToken: `tok-${calls}`,
      });
    };

    const result = await getCostsCached({}, dates(2021));

    expect(result.partial).toBe(true);
    expect(calls).toBe(100); // CE_MAX_PAGES
    expect(result.costs.length).toBe(100); // one entry per page
  });

  it('returns partial=false when CE drains all pages within the cap', async () => {
    // Hand back a NextPageToken for 3 pages, then nothing.
    let calls = 0;
    sendMockImpl = () => {
      calls += 1;
      const body: { ResultsByTime: unknown[]; NextPageToken?: string } = {
        ResultsByTime: [{
          TimePeriod: { Start: '2022-01-01', End: '2022-01-31' },
          Groups: [{ Keys: [`Svc${calls}`], Metrics: { UnblendedCost: { Amount: '2.50', Unit: 'USD' } } }],
        }],
      };
      if (calls < 3) body.NextPageToken = `t-${calls}`;
      return Promise.resolve(body);
    };

    const result = await getCostsCached({}, dates(2022));

    expect(result.partial).toBe(false);
    expect(calls).toBe(3);
    expect(result.costs).toHaveLength(3);
  });
});

describe('getCostsCached — cache file persistence (issue #38)', () => {
  beforeEach(() => {
    sendMockImpl = () => Promise.resolve({ ResultsByTime: [] });
    readFileSyncMock = () => { throw new Error('test: no cache'); };
    writeFileSyncCalls.length = 0;
  });

  it('writes partial=true to the cache file when CE pagination is capped', async () => {
    let calls = 0;
    sendMockImpl = () => {
      calls += 1;
      return Promise.resolve({
        ResultsByTime: [{
          TimePeriod: { Start: '2023-01-01', End: '2023-01-31' },
          Groups: [{ Keys: [`S${calls}`], Metrics: { UnblendedCost: { Amount: '1.00', Unit: 'USD' } } }],
        }],
        NextPageToken: `t-${calls}`,
      });
    };

    await getCostsCached({}, dates(2023));

    // The last writeFileSync call holds the latest cache snapshot.
    const lastWrite = writeFileSyncCalls.at(-1);
    expect(lastWrite).toBeDefined();
    const parsed = JSON.parse(lastWrite!.data) as Record<string, { partial?: boolean }>;
    const entry = Object.values(parsed).at(-1);
    expect(entry?.partial).toBe(true);
  });

  it('omits the partial field from the cache file when results are complete (small-JSON optimization)', async () => {
    sendMockImpl = () => Promise.resolve({
      ResultsByTime: [{
        TimePeriod: { Start: '2024-01-01', End: '2024-01-31' },
        Groups: [{ Keys: ['EC2'], Metrics: { UnblendedCost: { Amount: '1.00', Unit: 'USD' } } }],
      }],
    });

    await getCostsCached({}, dates(2024));

    const lastWrite = writeFileSyncCalls.at(-1);
    expect(lastWrite).toBeDefined();
    const parsed = JSON.parse(lastWrite!.data) as Record<string, { partial?: boolean }>;
    const entry = Object.values(parsed).at(-1);
    // exactOptionalPropertyTypes: not present at all when false (avoid noise in the cache file).
    expect(entry).not.toHaveProperty('partial');
  });

  it('preserves partial=true across an in-process cache hit', async () => {
    // First call: 100 pages, each with NextPageToken → cap is hit, partial=true.
    let calls = 0;
    sendMockImpl = () => {
      calls += 1;
      return Promise.resolve({
        ResultsByTime: [{
          TimePeriod: { Start: '2025-01-01', End: '2025-01-31' },
          Groups: [{ Keys: [`S${calls}`], Metrics: { UnblendedCost: { Amount: '1.00', Unit: 'USD' } } }],
        }],
        NextPageToken: `t-${calls}`,
      });
    };

    const first = await getCostsCached({}, dates(2025));
    expect(first.partial).toBe(true);
    expect(calls).toBe(100);

    // Second call same key: must hit the in-process cache, not the API, and still report partial.
    const callsBefore = calls;
    const second = await getCostsCached({}, dates(2025));
    expect(calls).toBe(callsBefore); // no new API calls
    expect(second.partial).toBe(true);
    expect(second.costs).toHaveLength(100);
  });

  it('superset cache hit (includeResourceCosts=false reusing =true entry) preserves partial flag', async () => {
    // Seed the cache with a partial=true entry under the includeResourceCosts=true key.
    let calls = 0;
    sendMockImpl = () => {
      calls += 1;
      return Promise.resolve({
        ResultsByTime: [{
          TimePeriod: { Start: '2026-01-01', End: '2026-01-31' },
          Groups: [{ Keys: [`S${calls}`], Metrics: { UnblendedCost: { Amount: '1.00', Unit: 'USD' } } }],
        }],
        NextPageToken: `t-${calls}`,
      });
    };

    // First call: with includeResourceCosts=true → fills both keys' parallel calls; cap is hit on getCosts.
    const seed = await getCostsCached({}, { ...dates(2026), includeResourceCosts: true });
    expect(seed.partial).toBe(true);

    // Second call: same date/range/granularity/groupBy but includeResourceCosts=false (default) → must hit
    // the superset entry instead of issuing a fresh API call, and must still surface partial=true.
    const callsBefore = calls;
    const result = await getCostsCached({}, dates(2026));
    expect(calls).toBe(callsBefore); // no new API calls
    expect(result.partial).toBe(true);
  });
});

describe('getCostsCached — concurrent callers share the same partial flag via in-flight dedup (issue #38)', () => {
  beforeEach(() => {
    sendMockImpl = () => Promise.resolve({ ResultsByTime: [] });
    readFileSyncMock = () => { throw new Error('test: no cache'); };
    writeFileSyncCalls.length = 0;
  });

  it('two concurrent callers with the same cache key share one fetch and both see partial=true', async () => {
    let calls = 0;
    sendMockImpl = () => {
      calls += 1;
      return Promise.resolve({
        ResultsByTime: [{
          TimePeriod: { Start: '2027-01-01', End: '2027-01-31' },
          Groups: [{ Keys: [`S${calls}`], Metrics: { UnblendedCost: { Amount: '1.00', Unit: 'USD' } } }],
        }],
        NextPageToken: `t-${calls}`,
      });
    };

    // Fire two callers BEFORE awaiting — the second must land on _ceInFlight before the first resolves.
    const p1 = getCostsCached({}, dates(2027));
    const p2 = getCostsCached({}, dates(2027));

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(calls).toBe(100); // only ONE fetch ran (100 pages), not 200.
    expect(r1.partial).toBe(true);
    expect(r2.partial).toBe(true);
    expect(r1.costs).toBe(r2.costs); // same array reference via shared promise
  });
});
