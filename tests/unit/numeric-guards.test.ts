import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  clampConfidence,
  guardCost,
  guardSavings,
  isValidUtilization,
} from '../../src/utils/numeric-guards.js';

describe('clampConfidence', () => {
  it('passes through valid values in [0, 1]', () => {
    expect(clampConfidence(0)).toBe(0);
    expect(clampConfidence(0.5)).toBe(0.5);
    expect(clampConfidence(0.95)).toBe(0.95);
    expect(clampConfidence(1)).toBe(1);
  });

  it('clamps values above 1 down to 1', () => {
    expect(clampConfidence(1.05)).toBe(1);
    expect(clampConfidence(1.1)).toBe(1);
    expect(clampConfidence(2)).toBe(1);
    expect(clampConfidence(Number.MAX_VALUE)).toBe(1);
  });

  it('clamps values below 0 up to 0', () => {
    expect(clampConfidence(-0.1)).toBe(0);
    expect(clampConfidence(-1)).toBe(0);
    expect(clampConfidence(-Number.MAX_VALUE)).toBe(0);
  });

  it('collapses NaN / ±Infinity to 0', () => {
    expect(clampConfidence(NaN)).toBe(0);
    expect(clampConfidence(Infinity)).toBe(0);
    expect(clampConfidence(-Infinity)).toBe(0);
  });

  it('rejects non-number inputs', () => {
    expect(clampConfidence(undefined)).toBe(0);
    expect(clampConfidence(null)).toBe(0);
    expect(clampConfidence('0.5')).toBe(0);
    expect(clampConfidence({})).toBe(0);
  });
});

describe('guardCost', () => {
  it('returns positive finite numbers unchanged', () => {
    expect(guardCost(0.01)).toBe(0.01);
    expect(guardCost(1)).toBe(1);
    expect(guardCost(1234.56)).toBe(1234.56);
  });

  it('coerces numeric strings', () => {
    expect(guardCost('100')).toBe(100);
    expect(guardCost('3.14')).toBe(3.14);
  });

  it('returns null for ≤ 0', () => {
    expect(guardCost(0)).toBeNull();
    expect(guardCost(-0.01)).toBeNull();
    expect(guardCost(-100)).toBeNull();
  });

  it('returns null for NaN / Infinity / non-finite', () => {
    expect(guardCost(NaN)).toBeNull();
    expect(guardCost(Infinity)).toBeNull();
    expect(guardCost(-Infinity)).toBeNull();
  });

  it('returns null for null / undefined / non-numeric strings', () => {
    expect(guardCost(null)).toBeNull();
    expect(guardCost(undefined)).toBeNull();
    expect(guardCost('not-a-number')).toBeNull();
    expect(guardCost({})).toBeNull();
  });
});

describe('guardSavings', () => {
  it('preserves zero (valid for security-only rules)', () => {
    expect(guardSavings(0)).toBe(0);
  });

  it('passes through positive finite values', () => {
    expect(guardSavings(1)).toBe(1);
    expect(guardSavings(99.99)).toBe(99.99);
  });

  it('collapses NaN / Infinity / negative to 0', () => {
    expect(guardSavings(NaN)).toBe(0);
    expect(guardSavings(Infinity)).toBe(0);
    expect(guardSavings(-Infinity)).toBe(0);
    expect(guardSavings(-50)).toBe(0);
  });

  it('rejects non-number inputs', () => {
    expect(guardSavings(undefined)).toBe(0);
    expect(guardSavings(null)).toBe(0);
    expect(guardSavings('100')).toBe(0);
  });
});

describe('isValidUtilization', () => {
  it('returns true for valid utilization', () => {
    expect(isValidUtilization({ dataPoints: 10 })).toBe(true);
    expect(isValidUtilization({ dataPoints: 100, dataGaps: 0 })).toBe(true);
    expect(isValidUtilization({ dataPoints: 30, dataGaps: 5 })).toBe(true);
  });

  it('returns false for missing / zero dataPoints', () => {
    expect(isValidUtilization(undefined)).toBe(false);
    expect(isValidUtilization({})).toBe(false);
    expect(isValidUtilization({ dataPoints: 0 })).toBe(false);
  });

  it('returns false for non-finite dataPoints', () => {
    expect(isValidUtilization({ dataPoints: NaN })).toBe(false);
    expect(isValidUtilization({ dataPoints: Infinity })).toBe(false);
    expect(isValidUtilization({ dataPoints: -10 })).toBe(false);
  });

  it('returns false when dataGaps is non-numeric', () => {
    expect(isValidUtilization({ dataPoints: 10, dataGaps: NaN })).toBe(false);
  });
});

// Property-based tests catch any future call site that bypasses the guards —
// the issue (korinfra#37) explicitly calls these out as cheap insurance.

describe('clampConfidence — property-based invariants', () => {
  it('output is always in [0, 1] for any number input', () => {
    fc.assert(fc.property(fc.double({ noNaN: false }), (n) => {
      const v = clampConfidence(n);
      return v >= 0 && v <= 1;
    }));
  });

  it('output is always a finite number for any input', () => {
    fc.assert(fc.property(fc.anything(), (x) => {
      const v = clampConfidence(x as number);
      return typeof v === 'number' && Number.isFinite(v);
    }));
  });

  it('is idempotent — clampConfidence(clampConfidence(x)) === clampConfidence(x)', () => {
    fc.assert(fc.property(fc.double({ noNaN: false }), (n) => {
      return clampConfidence(clampConfidence(n)) === clampConfidence(n);
    }));
  });

  it('passes through values in [0, 1] unchanged', () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (n) => {
      return clampConfidence(n) === n;
    }));
  });
});

describe('guardCost — property-based invariants', () => {
  it('always returns null or a positive finite number', () => {
    fc.assert(fc.property(fc.anything(), (x) => {
      const v = guardCost(x);
      return v === null || (typeof v === 'number' && Number.isFinite(v) && v > 0);
    }));
  });

  it('returns null for any non-positive number', () => {
    fc.assert(fc.property(fc.double({ max: 0, noNaN: true }), (n) => {
      return guardCost(n) === null;
    }));
  });

  it('returns the value unchanged for positive finite numbers', () => {
    fc.assert(fc.property(fc.double({ min: Math.fround(1e-6), max: 1e9, noNaN: true }), (n) => {
      return guardCost(n) === n;
    }));
  });
});

describe('guardSavings — property-based invariants', () => {
  it('always returns a non-negative finite number', () => {
    fc.assert(fc.property(fc.anything(), (x) => {
      const v = guardSavings(x);
      return typeof v === 'number' && Number.isFinite(v) && v >= 0;
    }));
  });

  it('is idempotent', () => {
    fc.assert(fc.property(fc.anything(), (x) => {
      return guardSavings(guardSavings(x)) === guardSavings(x);
    }));
  });
});
