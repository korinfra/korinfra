import { describe, it, expect } from 'vitest';
import { formatCost, formatDuration, formatBytes } from '../../src/utils/humanize.js';

describe('formatCost', () => {
  it('formats whole dollars, cents, and edge values', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(1)).toBe('$1.00');
    expect(formatCost(100)).toBe('$100.00');
    expect(formatCost(0.5)).toBe('$0.50');
    expect(formatCost(0.01)).toBe('$0.01');
    expect(formatCost(0.999)).toBe('$1.00'); // rounds up
    expect(formatCost(1.005)).toBe('$1.01');
    expect(formatCost(1.004)).toBe('$1.00');
    expect(formatCost(1.234)).toBe('$1.23');
  });

  it('adds comma thousands separators and handles negatives', () => {
    expect(formatCost(1000)).toBe('$1,000.00');
    expect(formatCost(12345.6)).toBe('$12,345.60');
    expect(formatCost(1234567.89)).toBe('$1,234,567.89');
    expect(formatCost(-1)).toBe('-$1.00');
    expect(formatCost(-99.5)).toBe('-$99.50');
    expect(formatCost(-12345.6)).toBe('-$12,345.60');
  });
});

describe('formatDuration', () => {
  it('formats all time ranges correctly', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(1)).toBe('1ms');
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(999)).toBe('999ms');
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(2500)).toBe('2.5s');
    expect(formatDuration(59999)).toBe('60.0s');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(90_000)).toBe('1m30s');
    expect(formatDuration(120_000)).toBe('2m');
    expect(formatDuration(3599_000)).toBe('59m59s');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(9_000_000)).toBe('2h30m');
    expect(formatDuration(10_800_000)).toBe('3h');
  });

  it('throws RangeError for negative duration', () => {
    expect(() => formatDuration(-1)).toThrow(RangeError);
    expect(() => formatDuration(-1000)).toThrow('Duration cannot be negative');
  });
});

describe('formatBytes', () => {
  it('formats all byte ranges correctly', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1023)).toBe('1023.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 * 1024 * 2)).toBe('2.0 MB');
    expect(formatBytes(1024 * 1024 * 1.5)).toBe('1.5 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
    expect(formatBytes(1024 ** 3 * 5)).toBe('5.0 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
    expect(formatBytes(1024 ** 4 * 2)).toBe('2.0 TB');
  });
});
