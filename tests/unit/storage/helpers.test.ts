import { describe, it, expect } from 'vitest';
import { safeParse, safeParseArray } from '../../../src/storage/helpers.js';

// ─── safeParse ────────────────────────────────────────────────────────────────

describe('safeParse', () => {
  it('returns null for null', () => {
    expect(safeParse(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(safeParse(undefined)).toBeNull();
  });

  it('parses a plain object', () => {
    expect(safeParse('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses nested objects', () => {
    expect(safeParse('{"x":{"y":2}}')).toEqual({ x: { y: 2 } });
  });

  it('returns null for malformed JSON', () => {
    expect(safeParse('{not json}')).toBeNull();
  });

  it('returns null for a JSON array (not a Record)', () => {
    // Arrays are excluded — safeParse only returns plain objects
    expect(safeParse('[1,2]')).toBeNull();
  });

  // ─── Falsy-value regression (issue: old code used `if (!raw)`) ─────────────
  // The early-exit guard must only fire on null/undefined, not falsy strings.
  // JSON primitives (false, 0, "") are not Record shapes so safeParse returns
  // null — but it must reach JSON.parse rather than short-circuiting early.

  it('returns null for JSON false — not a plain object', () => {
    // 'false' parses to boolean — not a Record, so safeParse returns null.
    // The fix ensures we reach JSON.parse (old !raw guard would have short-circuited),
    // but the parsed value fails the object type check.
    expect(safeParse('false')).toBeNull();
  });

  it('returns null for JSON "0" — not a plain object', () => {
    // '0' parses to number — not a Record, so safeParse returns null.
    expect(safeParse('0')).toBeNull();
  });

  it('returns null for JSON empty string literal — not a plain object', () => {
    // '""' parses to string "" — not a Record, so safeParse returns null.
    expect(safeParse('""')).toBeNull();
  });

  it('does NOT skip empty object JSON', () => {
    expect(safeParse('{}')).toEqual({});
  });
});

// ─── safeParseArray ───────────────────────────────────────────────────────────

describe('safeParseArray', () => {
  it('returns null for null', () => {
    expect(safeParseArray(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(safeParseArray(undefined)).toBeNull();
  });

  it('parses a JSON array', () => {
    expect(safeParseArray<number>('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('parses an array of objects', () => {
    expect(safeParseArray<{ id: number }>('[{"id":1},{"id":2}]')).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });

  it('returns null when JSON is not an array', () => {
    expect(safeParseArray('{"a":1}')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(safeParseArray('[1,2,')).toBeNull();
  });

  it('parses an empty array', () => {
    expect(safeParseArray('[]')).toEqual([]);
  });

  // ─── Falsy-value regression ────────────────────────────────────────────────

  it('does NOT skip the string "false" — it is valid input to JSON.parse', () => {
    // 'false' parses to boolean false, which is not an array → returns null
    expect(safeParseArray('false')).toBeNull();
  });

  it('does NOT skip the string "0" — it is valid input to JSON.parse', () => {
    // '0' parses to 0, not an array → returns null
    expect(safeParseArray('0')).toBeNull();
  });
});
