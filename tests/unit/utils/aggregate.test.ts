import { describe, it, expect } from 'vitest';
import { calcSavingsPct, groupBySum, aggregateDailyCosts } from '../../../src/utils/aggregate.js';

// ─── calcSavingsPct ───────────────────────────────────────────────────────────

describe('calcSavingsPct', () => {
  it('returns "0" when total is 0 to avoid division by zero', () => {
    expect(calcSavingsPct(100, 0)).toBe('0');
    expect(calcSavingsPct(50, 0)).toBe('0');
    expect(calcSavingsPct(0, 0)).toBe('0');
  });

  it('calculates savings percentage correctly when total > 0', () => {
    // 100 savings out of 1000 total = 10%
    expect(calcSavingsPct(100, 1000)).toBe('10.0');

    // 50 savings out of 1000 total = 5%
    expect(calcSavingsPct(50, 1000)).toBe('5.0');

    // 500 savings out of 1000 total = 50%
    expect(calcSavingsPct(500, 1000)).toBe('50.0');
  });

  it('respects decimals parameter for rounding', () => {
    // Default: 1 decimal place
    expect(calcSavingsPct(100, 333)).toBe('30.0');

    // 0 decimals
    expect(calcSavingsPct(100, 333, 0)).toBe('30');

    // 2 decimals
    expect(calcSavingsPct(100, 333, 2)).toBe('30.03');

    // 3 decimals
    expect(calcSavingsPct(100, 333, 3)).toBe('30.030');
  });

  it('handles edge case where savings equals total', () => {
    expect(calcSavingsPct(1000, 1000)).toBe('100.0');
  });

  it('handles fractional values', () => {
    // 1.5 savings out of 10 total = 15%
    expect(calcSavingsPct(1.5, 10)).toBe('15.0');

    // 0.5 savings out of 2.5 total = 20%
    expect(calcSavingsPct(0.5, 2.5)).toBe('20.0');
  });

  it('handles cases where savings > total (100%+ savings)', () => {
    // 1500 savings out of 1000 total = 150%
    expect(calcSavingsPct(1500, 1000)).toBe('150.0');
  });
});

// ─── groupBySum ───────────────────────────────────────────────────────────────

describe('groupBySum', () => {
  it('groups items by key and sums numeric values', () => {
    const items = [
      { k: 'a', v: 1 },
      { k: 'a', v: 2 },
      { k: 'b', v: 3 },
    ];

    const result = groupBySum(items, (item) => item.k, (item) => item.v);

    expect(result.get('a')).toBe(3);
    expect(result.get('b')).toBe(3);
    expect(result.size).toBe(2);
  });

  it('returns a Map with correct entries', () => {
    const items = [
      { name: 'apple', count: 5 },
      { name: 'banana', count: 3 },
      { name: 'apple', count: 2 },
    ];

    const result = groupBySum(
      items,
      (item) => item.name,
      (item) => item.count,
    );

    expect(result instanceof Map).toBe(true);
    expect(Array.from(result.entries())).toEqual([
      ['apple', 7],
      ['banana', 3],
    ]);
  });

  it('handles empty array', () => {
    const result = groupBySum([], (item) => item, (item) => item);
    expect(result.size).toBe(0);
  });

  it('handles single item', () => {
    const items = [{ key: 'only', value: 42 }];
    const result = groupBySum(items, (item) => item.key, (item) => item.value);

    expect(result.get('only')).toBe(42);
    expect(result.size).toBe(1);
  });

  it('accumulates values correctly with multiple occurrences', () => {
    const items = [
      { region: 'us-east-1', cost: 100 },
      { region: 'us-west-2', cost: 50 },
      { region: 'us-east-1', cost: 75 },
      { region: 'us-west-2', cost: 25 },
      { region: 'us-east-1', cost: 50 },
    ];

    const result = groupBySum(
      items,
      (item) => item.region,
      (item) => item.cost,
    );

    expect(result.get('us-east-1')).toBe(225);
    expect(result.get('us-west-2')).toBe(75);
    expect(result.size).toBe(2);
  });

  it('handles zero and negative values', () => {
    const items = [
      { k: 'a', v: 10 },
      { k: 'a', v: -5 },
      { k: 'b', v: 0 },
      { k: 'b', v: 3 },
    ];

    const result = groupBySum(items, (item) => item.k, (item) => item.v);

    expect(result.get('a')).toBe(5);
    expect(result.get('b')).toBe(3);
  });

  it('preserves insertion order for Map iteration', () => {
    const items = [
      { k: 'z', v: 1 },
      { k: 'a', v: 2 },
      { k: 'm', v: 3 },
      { k: 'a', v: 4 },
    ];

    const result = groupBySum(items, (item) => item.k, (item) => item.v);
    const keys = Array.from(result.keys());

    expect(keys).toEqual(['z', 'a', 'm']); // insertion order
  });
});

// ─── aggregateDailyCosts ──────────────────────────────────────────────────────

describe('aggregateDailyCosts', () => {
  it('aggregates costs by date (YYYY-MM-DD prefix)', () => {
    const items = [
      { costDate: '2025-01-01T12:00:00Z', dailyCost: 5 },
      { costDate: '2025-01-01T00:00:00Z', dailyCost: 3 },
    ];

    const result = aggregateDailyCosts(items);

    expect(result.get('2025-01-01')).toBe(8);
    expect(result.size).toBe(1);
  });

  it('handles multiple days correctly', () => {
    const items = [
      { costDate: '2025-01-01T10:00:00Z', dailyCost: 10 },
      { costDate: '2025-01-02T15:30:45Z', dailyCost: 20 },
      { costDate: '2025-01-01T22:00:00Z', dailyCost: 5 },
      { costDate: '2025-01-03T08:15:00Z', dailyCost: 15 },
      { costDate: '2025-01-02T03:45:00Z', dailyCost: 10 },
    ];

    const result = aggregateDailyCosts(items);

    expect(result.get('2025-01-01')).toBe(15); // 10 + 5
    expect(result.get('2025-01-02')).toBe(30); // 20 + 10
    expect(result.get('2025-01-03')).toBe(15);
    expect(result.size).toBe(3);
  });

  it('ignores time component and only uses date prefix', () => {
    const items = [
      { costDate: '2025-06-15T00:00:00Z', dailyCost: 100 },
      { costDate: '2025-06-15T23:59:59Z', dailyCost: 200 },
      { costDate: '2025-06-15T12:30:45.123Z', dailyCost: 50 },
    ];

    const result = aggregateDailyCosts(items);

    expect(result.get('2025-06-15')).toBe(350);
    expect(result.size).toBe(1);
  });

  it('returns empty map for empty input', () => {
    const result = aggregateDailyCosts([]);
    expect(result.size).toBe(0);
  });

  it('handles single item', () => {
    const items = [{ costDate: '2025-12-25T10:00:00Z', dailyCost: 999 }];
    const result = aggregateDailyCosts(items);

    expect(result.get('2025-12-25')).toBe(999);
    expect(result.size).toBe(1);
  });

  it('preserves insertion order of dates', () => {
    const items = [
      { costDate: '2025-03-15T12:00:00Z', dailyCost: 1 },
      { costDate: '2025-01-10T12:00:00Z', dailyCost: 2 },
      { costDate: '2025-02-20T12:00:00Z', dailyCost: 3 },
      { costDate: '2025-01-10T18:00:00Z', dailyCost: 4 }, // same date as second, appears later
    ];

    const result = aggregateDailyCosts(items);
    const dates = Array.from(result.keys());

    expect(dates).toEqual(['2025-03-15', '2025-01-10', '2025-02-20']); // insertion order
    expect(result.get('2025-01-10')).toBe(6); // 2 + 4
  });

  it('handles fractional cost values', () => {
    const items = [
      { costDate: '2025-01-01T10:00:00Z', dailyCost: 5.5 },
      { costDate: '2025-01-01T20:00:00Z', dailyCost: 2.3 },
    ];

    const result = aggregateDailyCosts(items);

    expect(result.get('2025-01-01')).toBeCloseTo(7.8, 5);
  });

  it('handles zero costs', () => {
    const items = [
      { costDate: '2025-01-01T10:00:00Z', dailyCost: 0 },
      { costDate: '2025-01-01T20:00:00Z', dailyCost: 0 },
    ];

    const result = aggregateDailyCosts(items);

    expect(result.get('2025-01-01')).toBe(0);
  });

  it('extracts exactly 10 characters (YYYY-MM-DD) from costDate', () => {
    const items = [
      // All these should map to '2025-01-01' because we slice(0, 10)
      { costDate: '2025-01-01', dailyCost: 1 },
      { costDate: '2025-01-01T', dailyCost: 2 },
      { costDate: '2025-01-01T00:00:00', dailyCost: 3 },
      { costDate: '2025-01-01T00:00:00.000Z', dailyCost: 4 },
    ];

    const result = aggregateDailyCosts(items);

    expect(result.get('2025-01-01')).toBe(10); // 1 + 2 + 3 + 4
    expect(result.size).toBe(1);
  });
});
