import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { formatDateISO } from '../../../src/utils/date.js';

describe('formatDateISO', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('formats a date as YYYY-MM-DD with no time component', () => {
    const date = new Date('2025-03-15T12:00:00Z');
    expect(formatDateISO(date)).toBe('2025-03-15');
  });

  it('formats the first day of a year correctly', () => {
    const date = new Date('2025-01-01T00:00:00Z');
    expect(formatDateISO(date)).toBe('2025-01-01');
  });

  it('formats the last day of a year correctly', () => {
    const date = new Date('2025-12-31T23:59:59Z');
    expect(formatDateISO(date)).toBe('2025-12-31');
  });

  it('pads single-digit months with a leading zero', () => {
    const date = new Date('2025-06-05T00:00:00Z');
    expect(formatDateISO(date)).toBe('2025-06-05');
  });

  it('strips the time portion regardless of time of day', () => {
    const morning = new Date('2025-07-20T00:00:01Z');
    const evening = new Date('2025-07-20T23:59:59Z');
    expect(formatDateISO(morning)).toBe('2025-07-20');
    expect(formatDateISO(evening)).toBe('2025-07-20');
  });

  it('returns exactly 10 characters in YYYY-MM-DD format', () => {
    const date = new Date('2025-11-03T08:30:00Z');
    const result = formatDateISO(date);
    expect(result).toHaveLength(10);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('works with a frozen system time', () => {
    vi.setSystemTime(new Date('2026-05-25T14:30:00Z'));
    expect(formatDateISO(new Date())).toBe('2026-05-25');
  });

  it('handles epoch zero date', () => {
    const date = new Date(0);
    expect(formatDateISO(date)).toBe('1970-01-01');
  });

  it('handles a leap day correctly', () => {
    const date = new Date('2024-02-29T12:00:00Z');
    expect(formatDateISO(date)).toBe('2024-02-29');
  });
});
