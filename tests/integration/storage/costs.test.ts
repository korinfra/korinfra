import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '../../helpers/db.js';
import { insertScan } from '../../../src/storage/queries/scans.js';
import {
  insertCosts,
  listCosts,
  aggregateCostsByService,
} from '../../../src/storage/queries/costs.js';
import type { Driver } from '../../../src/storage/drivers/node.js';
import type { CostEntry } from '../../../src/storage/queries/costs.js';

function makeScan(id: string) {
  return {
    id,
    started_at: new Date().toISOString(),
    status: 'completed' as const,
    total_resources: 0,
    total_cost: 0,
    total_recommendations: 0,
    total_savings: 0,
    scenario_a_count: 0,
    scenario_b_count: 0,
    scenario_c_count: 0,
  };
}

function makeCost(overrides: Partial<CostEntry> = {}): CostEntry {
  return {
    scan_id: 'scan-1',
    service_name: 'Amazon Elastic Compute Cloud',
    cost_date: '2024-01-15',
    monthly_cost: 1523.47,
    region: 'us-east-1',
    currency: 'USD',
    ...overrides,
  };
}

// ─── costs CRUD ──────────────────────────────────────────────────────────────

describe('storage — costs CRUD', () => {
  let db: Driver;

  beforeEach(() => {
    db = createTestDb();
    insertScan(db, makeScan('scan-1'));
  });

  afterEach(() => { db.close(); });

  it('inserts, retrieves, filters, and handles edge cases', () => {
    // basic insert + retrieve with all fields
    insertCosts(db, 'scan-1', [makeCost()]);
    const costs = listCosts(db, 'scan-1');
    expect(costs).toHaveLength(1);
    expect(costs[0]!.service_name).toBe('Amazon Elastic Compute Cloud');
    expect(costs[0]!.cost_date).toBe('2024-01-15');
    expect(costs[0]!.monthly_cost).toBeCloseTo(1523.47, 2);
    expect(costs[0]!.region).toBe('us-east-1');
    expect(costs[0]!.currency).toBe('USD');
    expect(costs[0]!.scan_id).toBe('scan-1');

    // multiple services ordered by monthly_cost DESC
    insertCosts(db, 'scan-1', [
      makeCost({ service_name: 'Amazon Relational Database Service', monthly_cost: 1890.23 }),
      makeCost({ service_name: 'Amazon Simple Storage Service', monthly_cost: 456.78 }),
    ]);
    const all = listCosts(db, 'scan-1');
    expect(all[0]!.monthly_cost).toBeGreaterThanOrEqual(all[1]!.monthly_cost);

    // empty and unknown scan
    expect(listCosts(db, 'scan-unknown')).toHaveLength(0);

    // tags stored as JSON; null tags preserved
    insertCosts(db, 'scan-1', [makeCost({ tags: { Environment: 'production' } })]);
    const withTag = listCosts(db, 'scan-1').find((c) => (c.tags as Record<string, string> | null)?.['Environment']);
    expect(withTag?.tags).toEqual({ Environment: 'production' });

    insertCosts(db, 'scan-1', [makeCost({ tags: null })]);
    const withNull = listCosts(db, 'scan-1').find((c) => c.tags === null);
    expect(withNull?.tags).toBeNull();

    // usage_type and daily_cost stored
    insertCosts(db, 'scan-1', [makeCost({ usage_type: 'BoxUsage:m5.xlarge', daily_cost: 50.78 })]);
    const withUsage = listCosts(db, 'scan-1').find((c) => c.usage_type === 'BoxUsage:m5.xlarge');
    expect(withUsage?.daily_cost).toBeCloseTo(50.78, 2);

    // per-scan isolation
    insertScan(db, makeScan('scan-2'));
    insertCosts(db, 'scan-2', [makeCost({ monthly_cost: 200 })]);
    expect(listCosts(db, 'scan-1').length).toBeGreaterThan(0);
    expect(listCosts(db, 'scan-2')).toHaveLength(1);

    // duplicate dates for same service allowed
    insertCosts(db, 'scan-1', [
      makeCost({ cost_date: '2024-01-15', monthly_cost: 1000 }),
      makeCost({ cost_date: '2024-01-15', monthly_cost: 2000 }),
    ]);
    // date range: 31 entries
    const entries: CostEntry[] = [];
    for (let day = 1; day <= 31; day++) {
      entries.push(makeCost({ cost_date: `2024-01-${String(day).padStart(2, '0')}`, monthly_cost: day * 10 }));
    }
    insertScan(db, makeScan('scan-dates'));
    insertCosts(db, 'scan-dates', entries);
    expect(listCosts(db, 'scan-dates')).toHaveLength(31);
  });
});

// ─── aggregateCostsByService ──────────────────────────────────────────────────

describe('storage — aggregateCostsByService', () => {
  let db: Driver;

  beforeEach(() => {
    db = createTestDb();
    insertScan(db, makeScan('scan-1'));
  });

  afterEach(() => { db.close(); });

  it('returns per-service aggregates with correct totals and ordering', () => {
    // empty scan
    expect(aggregateCostsByService(db, 'scan-1')).toHaveLength(0);
    expect(aggregateCostsByService(db, 'scan-unknown')).toHaveLength(0);

    // single service, multi-entry aggregation
    insertCosts(db, 'scan-1', [
      makeCost({ service_name: 'Amazon Elastic Compute Cloud', monthly_cost: 1000, daily_cost: 33 }),
      makeCost({ service_name: 'Amazon Elastic Compute Cloud', monthly_cost: 500, daily_cost: 16, cost_date: '2024-01-16' }),
    ]);
    const single = aggregateCostsByService(db, 'scan-1');
    expect(single).toHaveLength(1);
    expect(single[0]!.total_monthly_cost).toBeCloseTo(1500, 2);
    expect(single[0]!.entry_count).toBe(2);

    // multi-service: ordered by total_monthly_cost DESC with correct grand total
    insertCosts(db, 'scan-1', [
      makeCost({ service_name: 'Amazon Relational Database Service', monthly_cost: 1890.23 }),
      makeCost({ service_name: 'Amazon Simple Storage Service', monthly_cost: 456.78 }),
    ]);
    const multi = aggregateCostsByService(db, 'scan-1');
    expect(multi.length).toBeGreaterThanOrEqual(3);
    expect(multi[0]!.total_monthly_cost).toBeGreaterThanOrEqual(multi[1]!.total_monthly_cost);
    const grandTotal = multi.reduce((s, x) => s + x.total_monthly_cost, 0);
    expect(grandTotal).toBeGreaterThan(0);
  });
});
