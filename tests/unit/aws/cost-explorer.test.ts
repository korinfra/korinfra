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

// Stub fs so the file-backed CE cache at ~/.korinfra/ce_cache.json is never read or written.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof FsModule>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn().mockImplementation(() => { throw new Error('test: no cache'); }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
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
